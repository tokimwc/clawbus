import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClawBus } from "../core/bus.js";
import type { ClawBusMessage, TaskPayload } from "../core/types.js";
import { runSdkQuery } from "./sdk-helpers.js";

export interface WorkerInput {
  taskMessage: ClawBusMessage;
  cwd: string;
  approverAgent?: string;
  model?: string;
  onMessage?: (msg: SDKMessage) => void;
  /** How long to wait for a human approval before treating it as a deny. */
  approvalTimeoutMs?: number;
}

export interface WorkerResult {
  resultMessage: ClawBusMessage;
  text: string;
  costUsd: number;
  approvals: number;
  rejections: number;
}

/** Tools that require explicit human approval before executing. */
const GATED_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

const WORKER_SYSTEM = `You are ClawBus Worker, an autonomous coding agent that executes a single subtask and then summarizes what you did.

RULES:
1. You have Read, Grep, Glob, Bash, and Edit tools.
2. Use Bash for anything read-only (e.g. \`npm test\`, \`ls\`, \`cat\`).
3. When you need to modify a file, use the Edit tool — it will be intercepted and sent to a Human Approval Gate. If approval is denied, STOP and report the denial reason.
4. After the subtask is complete (or blocked), write a short plain-text summary of what you observed and what you changed. Do not ask follow-up questions.
5. Do not run destructive commands (rm, git push, etc.).`;

/**
 * Run the Worker agent against a single task message. File-modifying tools
 * are routed through the bus as `approval-request` messages; the worker
 * blocks until an `approval-decision` message arrives from `approverAgent`.
 */
export async function runWorker(
  bus: ClawBus,
  input: WorkerInput,
): Promise<WorkerResult> {
  const task = input.taskMessage.payload as TaskPayload;
  const approverAgent = input.approverAgent ?? "approval-gate";
  const approvalTimeoutMs = input.approvalTimeoutMs ?? 5 * 60_000;

  let approvals = 0;
  let rejections = 0;

  const canUseTool = async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    if (!GATED_TOOLS.has(toolName)) {
      return { behavior: "allow", updatedInput: toolInput };
    }

    const diff = summarizeEdit(toolName, toolInput);
    const approvalRequest = await bus.send({
      from: "worker",
      to: approverAgent,
      kind: "approval-request",
      parent: input.taskMessage.id,
      payload: {
        action: `${toolName} ${String(toolInput["file_path"] ?? "")}`.trim(),
        diff,
        severity: "medium",
        rationale: `Worker wants to apply a ${toolName} to ${String(
          toolInput["file_path"] ?? "(unknown file)",
        )}`,
      },
    });

    try {
      const decision = await bus.waitFor({
        parent: approvalRequest.id,
        kind: "approval-decision",
        timeoutMs: approvalTimeoutMs,
      });
      const payload = decision.payload as {
        decision: "approve" | "reject";
        note?: string;
      };
      if (payload.decision === "approve") {
        approvals += 1;
        return { behavior: "allow", updatedInput: toolInput };
      }
      rejections += 1;
      return {
        behavior: "deny",
        message: `Human approval denied${payload.note ? `: ${payload.note}` : ""}`,
      };
    } catch (err) {
      rejections += 1;
      return {
        behavior: "deny",
        message: `Approval timed out or failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  };

  const prompt = `Subtask:\n${task.goal}\n\nWorking directory: ${input.cwd}\n\nExecute this subtask now, then write a short summary.`;

  const { text, costUsd } = await runSdkQuery(prompt, {
    systemPrompt: WORKER_SYSTEM,
    tools: ["Read", "Grep", "Glob", "Bash", "Edit"],
    canUseTool,
    cwd: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    ...(input.onMessage ? { onMessage: input.onMessage } : {}),
  });

  const resultMessage = await bus.send({
    from: "worker",
    to: input.taskMessage.from,
    kind: "result",
    parent: input.taskMessage.id,
    payload: {
      status: rejections > 0 ? "partial" : "ok",
      summary: text,
      artifacts: [{ kind: "worker-summary", ref: text.slice(0, 200) }],
    },
    meta: { approvals, rejections, costUsd },
  });

  return { resultMessage, text, costUsd, approvals, rejections };
}

function summarizeEdit(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const filePath = String(toolInput["file_path"] ?? "(unknown)");
  if (toolName === "Write") {
    const content = String(toolInput["content"] ?? "");
    const preview = content.length > 400 ? `${content.slice(0, 400)}…` : content;
    return `Write ${filePath}\n--- new content (first 400 chars) ---\n${preview}`;
  }
  const oldStr = String(toolInput["old_string"] ?? "");
  const newStr = String(toolInput["new_string"] ?? "");
  return [
    `Edit ${filePath}`,
    `--- before ---`,
    oldStr.length > 400 ? `${oldStr.slice(0, 400)}…` : oldStr,
    `--- after ---`,
    newStr.length > 400 ? `${newStr.slice(0, 400)}…` : newStr,
  ].join("\n");
}
