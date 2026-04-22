# Quickstart

Wire your own agents on the ClawBus protocol in under 5 minutes.

## Install

```bash
npm install clawbus
```

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`).

## 1. Create a bus

A **bus** wraps a storage adapter. Use `FileAdapter` for zero-dep JSONL logs
or `SQLiteAdapter` for the default append-only SQLite store.

```typescript
import { ClawBus, SQLiteAdapter } from "clawbus";

const bus = new ClawBus({
  adapter: new SQLiteAdapter({ path: ".clawbus/bus.sqlite" }),
});
```

All five message kinds (`task` / `result` / `approval-request` /
`approval-decision` / `log`) flow through the same `send()` /
`subscribe()` / `query()` API.

## 2. Subscribe an agent

```typescript
bus.subscribe("worker", async (msg) => {
  if (msg.kind !== "task") return;
  const { goal } = msg.payload as { goal: string };
  await bus.send({
    to: msg.from,
    kind: "result",
    parent: msg.id,
    payload: {
      status: "ok",
      summary: `did: ${goal}`,
    },
  });
});
```

Handlers are simple async functions. Errors thrown inside a handler are
isolated — they won't crash the bus or other handlers.

## 3. Send a task and await the result

```typescript
const taskMsg = await bus.send({
  from: "planner",
  to: "worker",
  kind: "task",
  payload: { goal: "say hello" },
});

const resultMsg = await bus.waitFor({
  parent: taskMsg.id,
  kind: "result",
  timeoutMs: 10_000,
});

console.log(resultMsg.payload);
```

`waitFor` checks past messages first (so you can't miss a result that
already arrived) then subscribes for future deliveries.

## 4. Wire a human approval gate

```typescript
import { startApprovalGate } from "clawbus";

const gate = startApprovalGate(bus, { reviewer: "you" });
// ...later
await gate.stop();
```

The gate reads stdin and emits `approval-decision` messages in response to
any `approval-request` addressed to its agent id (default:
`"approval-gate"`).

Pass `autoApprove: true` for non-interactive recordings.

## 5. Plug in real Claude agents

ClawBus ships with helpers for the
[Claude Agent SDK](https://docs.claude.com/en/agent-sdk/overview):

```typescript
import { runPlanner, runWorker, startApprovalGate } from "clawbus";

const gate = startApprovalGate(bus);
const plan = await runPlanner(bus, { goal: "fix the failing test", cwd });
for (const taskMsg of plan.taskMessages) {
  await runWorker(bus, { taskMessage: taskMsg, cwd });
}
await gate.stop();
```

The Worker's `canUseTool` callback intercepts every `Edit` / `Write` /
`NotebookEdit` tool call, emits an `approval-request` on the bus, and
blocks until the gate emits an `approval-decision`. Nothing mutates the
filesystem without human sign-off.

## 6. Inspect the timeline

```bash
npx clawbus logs           # full timeline
npx clawbus logs --kind approval-request
npx clawbus logs --limit 20
```

Every message is an append-only row in SQLite with a causal `parent`
link, so any run is auditable after the fact.

## Bring-your-own adapter

Implement four methods and drop it into the bus:

```typescript
interface Adapter {
  append(msg: ClawBusMessage): Promise<void>;
  subscribe(agentId: AgentId, handler: Handler): Unsubscribe;
  query(filter: MessageFilter): Promise<ClawBusMessage[]>;
  close(): Promise<void>;
}
```

See [`src/adapters/file.ts`](../src/adapters/file.ts) and
[`src/adapters/sqlite.ts`](../src/adapters/sqlite.ts) for reference
implementations. A DiscordAdapter and SlackAdapter are on the roadmap
after the hackathon.
