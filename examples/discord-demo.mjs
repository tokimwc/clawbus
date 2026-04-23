// Discord adapter end-to-end smoke test.
//
// What it does:
//   1. Connects to Discord via the DiscordAdapter
//   2. Subscribes a "worker" agent to the bus
//   3. Sends a `task` from a "planner" agent (posts to Discord)
//   4. Worker responds with a `result` (also posts to Discord)
//   5. Sends an `approval-request` (with ✅/❌ reactions added)
//   6. Waits up to 60s for a human reaction → synthesized approval-decision
//   7. Disconnects
//
// Usage:
//   1. Copy .env.example → .env, fill in DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID
//      and DISCORD_REVIEWER_IDS (your Discord user ID, comma-separated)
//   2. node --env-file=.env examples/discord-demo.mjs
//
// Requires Node 22.5+ and the bot to be invited to a server with permission
// to read/write the target channel and add reactions.

import { ulid } from "ulid";
import { DiscordAdapter, ClawBusMessageSchema } from "../dist/index.js";

const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const reviewerIds = (process.env.DISCORD_REVIEWER_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!token || !channelId) {
  console.error(
    "✗ DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID must be set. See .env.example.",
  );
  process.exit(1);
}

const now = () => new Date().toISOString();
const log = (label, msg) =>
  console.log(`[${new Date().toLocaleTimeString()}] ${label}`, msg);

const adapter = new DiscordAdapter({
  token,
  channelId,
  reviewerIds,
  cachePath: ".clawbus-discord-cache/demo.sqlite",
});

console.log("→ connecting to Discord...");
await adapter.connect();
console.log("✓ connected");

let workerSawDecision = null;

// Subscribe the worker
const unsubWorker = adapter.subscribe("worker", async (msg) => {
  log("[worker received]", `${msg.kind} from ${msg.from}`);
  if (msg.kind === "task") {
    const result = {
      id: ulid(),
      from: "worker",
      to: msg.from,
      kind: "result",
      payload: {
        status: "ok",
        summary: `acknowledged: ${JSON.stringify(msg.payload)}`,
      },
      parent: msg.id,
      createdAt: now(),
    };
    ClawBusMessageSchema.parse(result);
    await adapter.append(result);
  }
});

// Subscribe the planner to receive results
adapter.subscribe("planner", async (msg) => {
  log("[planner received]", `${msg.kind} from ${msg.from}`);
});

// Subscribe a human reviewer to observe approval decisions
adapter.subscribe("human", async (msg) => {
  log("[human seat received]", `${msg.kind} from ${msg.from}`);
});

// Subscribe broadcast for approval-decision capture
adapter.subscribe("broadcast", async (msg) => {
  if (msg.kind === "approval-decision") {
    workerSawDecision = msg;
  }
});

// Step 1: planner sends a task
console.log("\n→ sending task from planner");
const taskMsg = {
  id: ulid(),
  from: "planner",
  to: "worker",
  kind: "task",
  payload: { goal: "say hello in three languages" },
  createdAt: now(),
};
ClawBusMessageSchema.parse(taskMsg);
await adapter.append(taskMsg);

// Wait briefly for worker reply
await new Promise((r) => setTimeout(r, 2000));

// Step 2: planner sends an approval-request
console.log("\n→ sending approval-request from worker");
console.log(`   (react with ✅ or ❌ in Discord; reviewers: ${reviewerIds.join(", ") || "<none configured>"})`);
const approvalMsg = {
  id: ulid(),
  from: "worker",
  to: "human",
  kind: "approval-request",
  payload: {
    action: "Edit src/example.ts",
    diff: "@@ -1,1 +1,1 @@\n-greet('hello')\n+greet('hello, world')",
    severity: "medium",
    rationale: "demo only — verify approval flow over Discord",
  },
  createdAt: now(),
};
ClawBusMessageSchema.parse(approvalMsg);
await adapter.append(approvalMsg);

// Wait up to 60s for human reaction
console.log("\n→ waiting up to 60s for human reaction...");
const start = Date.now();
while (!workerSawDecision && Date.now() - start < 60_000) {
  await new Promise((r) => setTimeout(r, 500));
}

if (workerSawDecision) {
  console.log(`✓ approval-decision received: ${workerSawDecision.payload.decision} (reviewer ${workerSawDecision.payload.reviewer})`);
} else {
  console.log("⌛ no reaction within 60s (timed out — that's OK for a smoke test)");
}

// Step 3: query the cache
console.log("\n→ querying cached messages");
const cached = await adapter.query({});
console.log(`✓ cache has ${cached.length} messages:`);
for (const m of cached) {
  console.log(`   ${m.kind.padEnd(18)} ${m.from} → ${m.to}  id=${m.id.slice(0, 12)}...`);
}

// Cleanup
unsubWorker();
await adapter.close();
console.log("\n✓ demo complete, disconnected from Discord");
