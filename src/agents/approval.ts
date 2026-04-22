import * as readline from "node:readline/promises";
import type { ClawBus } from "../core/bus.js";
import type {
  ApprovalRequestPayload,
  ClawBusMessage,
} from "../core/types.js";

export interface ApprovalGateOptions {
  agentId?: string;
  reviewer?: string;
  /** Auto-approve every request. Useful for non-interactive demo recordings. */
  autoApprove?: boolean;
  /** If provided, called on every decision (for logging). */
  onDecision?: (msg: ClawBusMessage, decision: "approve" | "reject") => void;
}

export interface ApprovalGate {
  stop(): Promise<void>;
}

/**
 * Start a human-in-the-loop approval gate. Subscribes to `approval-request`
 * messages directed at the gate's agent id and emits `approval-decision`
 * messages in response.
 *
 * In interactive mode (default), prompts on stdin with a y/n choice. Pass
 * `autoApprove: true` for hands-off demos.
 */
export function startApprovalGate(
  bus: ClawBus,
  options: ApprovalGateOptions = {},
): ApprovalGate {
  const agentId = options.agentId ?? "approval-gate";
  const reviewer = options.reviewer ?? "human";
  const rl = options.autoApprove
    ? null
    : readline.createInterface({ input: process.stdin, output: process.stdout });

  const pending: Array<Promise<void>> = [];

  const unsubscribe = bus.subscribe(agentId, async (msg) => {
    if (msg.kind !== "approval-request") return;
    const task = handleOne(msg);
    pending.push(task);
    await task;
  });

  async function handleOne(msg: ClawBusMessage): Promise<void> {
    const req = msg.payload as ApprovalRequestPayload;
    let decision: "approve" | "reject";
    let note: string | undefined;

    if (options.autoApprove) {
      decision = "approve";
      note = "auto-approved";
    } else {
      printApprovalRequest(msg.id, req);
      const answer = (await rl!.question("Approve? [y/N/note]: ")).trim();
      if (/^y(es)?$/i.test(answer)) {
        decision = "approve";
      } else if (answer === "" || /^n(o)?$/i.test(answer)) {
        decision = "reject";
      } else {
        decision = /^(y|yes)/i.test(answer) ? "approve" : "reject";
        note = answer;
      }
    }

    await bus.send({
      from: agentId,
      to: msg.from,
      kind: "approval-decision",
      parent: msg.id,
      payload: {
        decision,
        reviewer,
        ...(note !== undefined ? { note } : {}),
      },
    });

    options.onDecision?.(msg, decision);
  }

  return {
    async stop() {
      unsubscribe();
      await Promise.allSettled(pending);
      rl?.close();
    },
  };
}

function printApprovalRequest(
  id: string,
  req: ApprovalRequestPayload,
): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "",
      "┌─ ClawBus approval request ────────────────────────────────",
      `│ id:       ${id}`,
      `│ action:   ${req.action}`,
      `│ severity: ${req.severity}`,
      `│ rationale: ${req.rationale}`,
      "├─── proposed change ───────────────────────────────────────",
      (req.diff ?? "(no diff provided)")
        .split("\n")
        .map((l) => `│ ${l}`)
        .join("\n"),
      "└───────────────────────────────────────────────────────────",
    ].join("\n"),
  );
}
