import type { ClawBus } from "../core/bus.js";
import type { ClawBusMessage } from "../core/types.js";
import { extractJson, runSdkQuery } from "./sdk-helpers.js";

export interface PlannerInput {
  goal: string;
  cwd: string;
  targetAgent?: string;
  model?: string;
  onMessage?: Parameters<typeof runSdkQuery>[1] extends infer O
    ? O extends { onMessage?: infer C }
      ? C
      : never
    : never;
}

export interface PlannedSubtask {
  id: string;
  goal: string;
  rationale?: string;
}

export interface PlannerResult {
  plan: PlannedSubtask[];
  taskMessages: ClawBusMessage[];
  costUsd: number;
}

const PLANNER_SYSTEM = `You are ClawBus Planner, an agent that decomposes a user's goal into a short ordered list of subtasks for a Worker agent to execute.

RULES:
1. Output ONLY a single JSON code block — no prose before or after.
2. The JSON must be an object shaped like:
   {"subtasks": [{"id": "s1", "goal": "...", "rationale": "..."}, ...]}
3. Each "goal" must be a single concrete instruction (e.g. "Run npm test and report which test fails").
4. Produce the minimum number of subtasks needed — 1 to 3 is typical for small tasks.
5. Never include shell commands that require approval (git push, rm -rf, etc.) — leave those for the Worker + Human Approval Gate.
6. The Worker has Read, Grep, Glob, Bash, and Edit tools. Planner itself has no tools.`;

/**
 * Ask the Planner agent to decompose `input.goal` into a subtask list, then
 * publish each subtask to the bus as a `task` message addressed to the Worker
 * agent (default id: "worker"). Returns the plan and the emitted messages.
 */
export async function runPlanner(
  bus: ClawBus,
  input: PlannerInput,
): Promise<PlannerResult> {
  const targetAgent = input.targetAgent ?? "worker";

  const prompt = `Goal:\n${input.goal}\n\nWorking directory (for context only, you cannot access it): ${input.cwd}\n\nDecompose this into subtasks and return the JSON plan.`;

  const { text, costUsd } = await runSdkQuery(prompt, {
    systemPrompt: PLANNER_SYSTEM,
    tools: [],
    ...(input.model ? { model: input.model } : {}),
    ...(input.onMessage ? { onMessage: input.onMessage } : {}),
  });

  const parsed = extractJson<{ subtasks: PlannedSubtask[] }>(text);
  if (!parsed || !Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
    throw new Error(
      `Planner did not return a valid {subtasks:[...]} JSON block. Raw output:\n${text}`,
    );
  }

  const taskMessages: ClawBusMessage[] = [];
  for (const subtask of parsed.subtasks) {
    const msg = await bus.send({
      from: "planner",
      to: targetAgent,
      kind: "task",
      payload: {
        goal: subtask.goal,
        context: { subtaskId: subtask.id, rationale: subtask.rationale },
      },
    });
    taskMessages.push(msg);
  }

  await bus.send({
    from: "planner",
    to: "broadcast",
    kind: "log",
    payload: {
      level: "info",
      text: `Planner produced ${parsed.subtasks.length} subtask(s) for ${targetAgent}`,
      data: { costUsd, plan: parsed.subtasks },
    },
  });

  return { plan: parsed.subtasks, taskMessages, costUsd };
}
