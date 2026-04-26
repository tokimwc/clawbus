// Free-text Discord channel end-to-end smoke test.
//
// This demonstrates the post-hackathon free-text feature: a human types
// natural language into a dedicated Discord channel, the adapter translates
// it into a `task` ClawBus message, a Worker agent picks it up, and a
// `result` is posted to the bus channel.
//
// What it does:
//   1. Connects to Discord with TWO channel IDs (bus + free-text user input)
//   2. Subscribes a "worker" agent that responds to tasks
//   3. Waits up to 5 minutes for the human to type something in the
//      free-text channel
//   4. Translator turns the typed text into a `task` (auto-routed by @command
//      prefix; bare text → default worker)
//   5. Worker echoes back a `result`
//   6. Disconnects after first round-trip OR timeout
//
// Usage:
//   1. Copy .env.example → .env, fill in:
//        DISCORD_BOT_TOKEN
//        DISCORD_CHANNEL_ID            (existing — bus channel)
//        DISCORD_FREE_TEXT_CHANNEL_ID  (NEW — separate channel for free-text)
//        DISCORD_ALLOWED_USER_IDS      (NEW — your Discord User ID, comma-sep)
//   2. node --env-file=.env examples/discord-free-text-demo.mjs
//   3. In Discord, open the free-text channel and type:
//        "ping"           → worker
//        "@quick hello"   → quick-worker (would route here if subscribed)
//
// Requires Node 22.5+. The bot must be a member of the guild and have
// read/send permissions on BOTH channels.

import { ulid } from "ulid";
import { DiscordAdapter, ClawBusMessageSchema } from "../dist/index.js";

const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const freeTextChannelId = process.env.DISCORD_FREE_TEXT_CHANNEL_ID;
const allowedUserIds = (process.env.DISCORD_ALLOWED_USER_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!token || !channelId || !freeTextChannelId || allowedUserIds.length === 0) {
  console.error(
    "✗ Required env vars: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DISCORD_FREE_TEXT_CHANNEL_ID, DISCORD_ALLOWED_USER_IDS",
  );
  process.exit(1);
}

if (channelId === freeTextChannelId) {
  console.error(
    "✗ DISCORD_CHANNEL_ID and DISCORD_FREE_TEXT_CHANNEL_ID must differ.",
  );
  process.exit(1);
}

const now = () => new Date().toISOString();
const log = (label, msg) =>
  console.log(`[${new Date().toLocaleTimeString()}] ${label}`, msg);

// Translator: free-text → task. Recognizes a leading `@command` prefix.
const COMMAND_AGENT_MAP = {
  quick: "quick-worker",
  blog: "blog-worker",
  kanban: "kanban-worker",
};
const COMMAND_RE = /^@([a-zA-Z][a-zA-Z0-9-]*)\s+(.+)$/s;

const freeTextToMessage = (input) => {
  const trimmed = input.content.trim();
  if (trimmed.length === 0) return null;
  const m = trimmed.match(COMMAND_RE);
  let to = "worker";
  let goal = trimmed;
  let command;
  if (m) {
    const cmd = m[1].toLowerCase();
    if (Object.hasOwn(COMMAND_AGENT_MAP, cmd)) {
      to = COMMAND_AGENT_MAP[cmd];
      command = cmd;
      goal = m[2].trim();
    }
  }
  return {
    id: ulid(),
    from: "user",
    to,
    kind: "task",
    payload: command ? { goal, command } : { goal },
    createdAt: now(),
    meta: {
      discordMessageId: input.messageId,
      authorName: input.authorName,
    },
  };
};

const adapter = new DiscordAdapter({
  token,
  channelId,
  cachePath: ".clawbus-discord-cache/free-text-demo.sqlite",
  // New free-text feature wiring:
  freeTextChannelId,
  freeTextAllowedUserIds: allowedUserIds,
  freeTextToMessage,
});

console.log("→ connecting to Discord...");
console.log(`  bus channel:       ${channelId}`);
console.log(`  free-text channel: ${freeTextChannelId}`);
console.log(`  allowed users:     ${allowedUserIds.join(", ")}`);
await adapter.connect();
console.log("✓ connected");

let firstRoundTrip = null;

adapter.subscribe("worker", async (msg) => {
  log("[worker received]", `${msg.kind} from ${msg.from}`);
  if (msg.kind === "task") {
    const result = {
      id: ulid(),
      from: "worker",
      to: msg.from,
      kind: "result",
      payload: {
        status: "ok",
        summary: `acknowledged free-text task: "${msg.payload.goal.slice(0, 80)}"`,
      },
      parent: msg.id,
      createdAt: now(),
    };
    ClawBusMessageSchema.parse(result);
    await adapter.append(result);
    if (!firstRoundTrip) firstRoundTrip = { task: msg, result };
  }
});

console.log("\n→ Type something in the free-text channel to trigger the worker.");
console.log("  Try:  ping");
console.log("  Or:   @quick summarize this thread");
console.log("  Will wait up to 5 minutes for the first message...\n");

const start = Date.now();
while (!firstRoundTrip && Date.now() - start < 300_000) {
  await new Promise((r) => setTimeout(r, 500));
}

if (firstRoundTrip) {
  console.log(
    `\n✓ round-trip complete in ${(Date.now() - start) / 1000}s`,
  );
  console.log(`  task.id     = ${firstRoundTrip.task.id}`);
  console.log(`  task.to     = ${firstRoundTrip.task.to}`);
  console.log(`  task.goal   = ${firstRoundTrip.task.payload.goal}`);
  console.log(`  result.id   = ${firstRoundTrip.result.id}`);
} else {
  console.log("\n⌛ no free-text message within 5 minutes (timed out).");
}

console.log("\n→ querying cached messages");
const cached = await adapter.query({});
console.log(`✓ cache has ${cached.length} messages:`);
for (const m of cached) {
  console.log(`   ${m.kind.padEnd(18)} ${m.from} → ${m.to}  id=${m.id.slice(0, 12)}...`);
}

await adapter.close();
console.log("\n✓ demo complete, disconnected from Discord");
