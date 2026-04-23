# DiscordAdapter — Design Note

> Status: **Shipped** (2026-04-23, real-bot E2E verified — see [`scenarios/discord-handshake.md`](scenarios/discord-handshake.md))
> Goal: Validate `Adapter` interface across a real distributed transport, prove "adapter pluralism" beyond local files.

## Why now

The hackathon initially shipped only `FileAdapter` and `SQLiteAdapter`. The README mentioned a future `DiscordAdapter` as a placeholder. Implementing it during the remaining hackathon window:

1. Removes the "promised but missing" credibility risk
2. Demonstrates the Adapter interface is real, not just architectural
3. Enables a multi-machine demo (planner on machine A, worker on machine B, human approval on Discord)

## Constraints

- **No code reuse** from the user's existing production multi-agent system (per hackathon compliance notice in README)
- **Feature branch only** until proven; main stays at v3 if anything breaks
- **Optional dependency** — must not break `npx clawbus demo` for users without Discord
- **Minimal scope** — MVP transport, not a full Discord UX framework

## Architecture

```
┌──────────────────────────┐
│   DiscordAdapter         │
│  (implements Adapter)    │
│                          │
│  ┌────────────────────┐  │
│  │ Local Cache        │  │ ← SQLite for query() speed
│  │ (delegated)        │  │
│  └─────────┬──────────┘  │
│            │             │
│  ┌─────────▼──────────┐  │
│  │ DiscordTransport   │  │ ← discord.js Client
│  │  - send: post msg  │  │
│  │  - listen: events  │  │
│  └────────────────────┘  │
└──────────────────────────┘
       │                │
       ▼                ▼
   Discord Channel    Local SQLite
   (truth source     (query cache,
    + transport)      survives restart)
```

## Message encoding on Discord

Each ClawBus message becomes a Discord message:

```
**[task]** planner → worker  ·  id `01H...`
```json
{
  "id": "01H...",
  "from": "planner",
  "to": "worker",
  "kind": "task",
  "payload": { "goal": "fix the failing test" },
  "createdAt": "2026-04-23T13:00:00Z"
}
```
```

- **Header line**: `**[kind]** from → to · id` (human-skimmable)
- **Body**: pretty JSON in code block (machine-parseable, also human-readable)
- For `approval-request`: add ✅ ❌ reactions automatically; observers click to decide

## API surface

```typescript
interface DiscordAdapterOptions {
  token: string;              // Bot token (NEVER commit)
  channelId: string;          // Target channel to send/listen
  guildId?: string;           // Optional, for slash commands
  cachePath?: string;         // Defaults to ".clawbus/discord-cache.sqlite"
}

class DiscordAdapter implements Adapter {
  constructor(opts: DiscordAdapterOptions);
  append(msg: ClawBusMessage): Promise<void>;
  subscribe(agentId: AgentId, handler: Handler): Unsubscribe;
  query(filter: MessageFilter): Promise<ClawBusMessage[]>;
  close(): Promise<void>;
}
```

## Behavior contract

### `append(msg)`
1. Persist to local SQLite cache (delegate to internal SQLiteAdapter)
2. Post to Discord channel with the encoded format above
3. If `kind === "approval-request"`, add ✅ ❌ reactions
4. Return when both succeed; log error and re-throw if Discord post fails

### `subscribe(agentId, handler)`
1. Register handler for messages where `to === agentId` or `to === "broadcast"`
2. discord.js MessageCreate listener parses incoming bot-formatted messages
3. discord.js MessageReactionAdd listener detects approval reactions; synthesizes an `approval-decision` message and delivers it
4. Returns unsubscribe function

### `query(filter)`
1. Query the local SQLite cache (fast)
2. Note: does NOT backfill from Discord history (rate limit risk); cache is best-effort

### `close()`
1. Destroy discord.js client (close WebSocket)
2. Close SQLite cache

## Approval flow on Discord

```
[worker]  Posts approval-request with diff
   ↓
[bot]     Adds ✅ and ❌ reactions
   ↓
[human]   Clicks ✅ in Discord
   ↓
[bot]     Detects reaction (only from authorized reviewer IDs)
   ↓
[adapter] Synthesizes approval-decision message:
          { decision: "approve", reviewer: "<discord-user-id>" }
   ↓
[adapter] Calls append(approval-decision) → posts back to Discord +
          delivers to subscribed worker
   ↓
[worker]  Receives approval-decision, applies patch
```

**Authorization**: configurable list of reviewer Discord user IDs. Reactions from others are ignored.

## Testing strategy

### Unit tests (mocked discord.js)
- Mock `Client`, `TextChannel.send`, `ReactionCollector`
- Verify `append()` calls `channel.send()` with correctly formatted payload
- Verify `subscribe()` triggers handler when mock client emits `MessageCreate`
- Verify approval reaction → synthesized `approval-decision`

### Integration test (real Discord)
- Set up: real bot token, dedicated test channel, dedicated test guild
- Run: 2 ClawBus instances in same process, each subscribed to a different agentId
- Both share the same DiscordAdapter pointing to the same channel
- Verify: messages flow through Discord round-trip, queries return correct data

## Out of scope (for hackathon)

- Slash commands (`/clawbus task ...`) — would add UX value but high setup overhead
- Threads per task — pretty but adds rate limit complexity
- Embed-style rich messages — JSON-in-code-block is enough for MVP
- Discord history backfill — leave to FileAdapter/SQLiteAdapter as primary store
- Multiple channels per bus — single channel is sufficient
- Message editing/deletion sync — append-only invariant means we never edit/delete

## Hackathon compliance

This adapter is **new code authored during the hackathon window** (after 2026-04-22 JST kickoff). The design is informed by the author's production Discord bus but **no source code is reused**. See `README.md` "Hackathon compliance notice".

## Demo for video / docs

After implementation:
1. Capture a 5-10 second screen recording: Discord channel showing planner→worker→approval-request→human-clicks-✅→approval-decision→worker-completes
2. Save as `docs/screenshots/discord-flow.gif` or .mp4
3. Reference from README and (if v4 video re-cut) from end card
