# Scenario: Discord handshake (real bot, real reaction)

> Captured: 2026-04-23 JST during hackathon Tier A E2E.
> Bot: `ClawBus Hackathon` (private app, never published).
> Channel: dedicated `#clawbus-bus` in a private guild.

This is the real terminal output of `node --env-file=.env examples/discord-demo.mjs`
running against a live Discord bot. It demonstrates:

1. The DiscordAdapter connects to a real Discord channel
2. `task` from planner is posted to Discord and delivered to the local worker subscriber
3. The local worker auto-replies with a `result`, also posted to Discord
4. An `approval-request` is posted with ✅/❌ reactions auto-attached
5. A real human (Discord user `8363764159...`) clicked ✅ in Discord
6. The adapter detected the reaction, synthesized an `approval-decision`, posted it back to Discord, and delivered it to the worker
7. End-to-end approval round-trip in 3 seconds

## Terminal output

```
→ connecting to Discord...
✓ connected

→ sending task from planner
[14:29:42] [worker received] task from planner
[14:29:42] [planner received] result from worker

→ sending approval-request from worker
   (react with ✅ or ❌ in Discord; reviewers: <reviewer-discord-id>)
[14:29:45] [human seat received] approval-request from worker

→ waiting up to 60s for human reaction...
[14:29:48] [worker received] approval-decision from human
✓ approval-decision received: approve (reviewer <reviewer-discord-id>)

→ querying cached messages
✓ cache has 6 messages:
   task               planner → worker  id=01KPWCRMNEGH...
   result             worker → planner  id=01KPWCRMQ1E9...
   task               planner → worker  id=01KPWD1GWSAG...
   result             worker → planner  id=01KPWD1GX80Z...
   approval-request   worker → human  id=01KPWD1KG8B7...
   approval-decision  human → worker  id=dec_01KPWD1K...

✓ demo complete, disconnected from Discord
```

(The 4 task/result entries reflect two demo runs sharing the same SQLite cache file —
that's the cache surviving across processes, not a bug.)

## What this proves

- **Adapter pluralism is real, not slogan.** Same `Adapter` interface as
  FileAdapter and SQLiteAdapter; same protocol round-trip; transport changes
  don't change the agent code.
- **`approval-request` is a first-class kind, not bolted on.** A human
  reaction in Discord becomes an `approval-decision` message in the bus,
  with `reviewer` and `parent` fields populated.
- **The append-only log spans the transport.** All six messages are
  queryable from the local SQLite cache — including the synthesized
  `approval-decision` that originated as a Discord reaction.

## Live channel screenshot

![Discord channel showing the four-message handshake](../screenshots/discord-flow.png)

The reviewer's Discord user ID is redacted; everything else is the real
output of the demo command running against a private bot in a private
channel of the author's personal Discord server. The bot is named
`ClawBus Hackathon` and was created from scratch during the hackathon
window.

## Full message bodies (verbatim)

Captured by hand from the Discord channel after the demo run:

### Message 1 — `task` (planner → worker)

```json
{
  "id": "01KPWD1GWSAGMRERMKWMBE3CQ5",
  "from": "planner",
  "to": "worker",
  "kind": "task",
  "payload": {
    "goal": "say hello in three languages"
  },
  "createdAt": "2026-04-23T05:29:42.553Z"
}
```

### Message 2 — `result` (worker → planner)

```json
{
  "id": "01KPWD1GX80ZMT8TSEP888YYVC",
  "from": "worker",
  "to": "planner",
  "kind": "result",
  "payload": {
    "status": "ok",
    "summary": "acknowledged: {\"goal\":\"say hello in three languages\"}"
  },
  "parent": "01KPWD1GWSAGMRERMKWMBE3CQ5",
  "createdAt": "2026-04-23T05:29:42.568Z"
}
```

### Message 3 — `approval-request` (worker → human)

```json
{
  "id": "01KPWD1KG8B7S71MX60XEF9WF1",
  "from": "worker",
  "to": "human",
  "kind": "approval-request",
  "payload": {
    "action": "Edit src/example.ts",
    "diff": "@@ -1,1 +1,1 @@\n-greet('hello')\n+greet('hello, world')",
    "severity": "medium",
    "rationale": "demo only — verify approval flow over Discord"
  },
  "createdAt": "2026-04-23T05:29:45.224Z"
}
```

### Message 4 — `approval-decision` (human → worker, synthesized from ✅ reaction)

```json
{
  "id": "dec_01KPWD1KG8B7S71MX60XEF9WF1_1776922188786",
  "from": "human",
  "to": "worker",
  "kind": "approval-decision",
  "payload": {
    "decision": "approve",
    "reviewer": "<reviewer-discord-id>",
    "note": "via Discord reaction ✅"
  },
  "parent": "01KPWD1KG8B7S71MX60XEF9WF1",
  "createdAt": "2026-04-23T05:29:48.786Z"
}
```

Notice that message 4 has `"parent": "01KPWD1KG8B7S71MX60XEF9WF1"` — the
ID of the approval-request — establishing the causal link between human
approval and the worker's pending mutation.

## How to reproduce

1. Create a Discord application + bot at https://discord.com/developers/applications
2. Enable the **Message Content Intent** on the Bot page
3. Generate an OAuth2 URL with `bot` scope and the four permissions
   (View Channels, Send Messages, Read Message History, Add Reactions)
4. Invite the bot to a server and grant it explicit access to a channel
5. Copy the bot token and channel ID into `.env` (see `.env.example`)
6. Run:
   ```bash
   npm run build
   node --env-file=.env examples/discord-demo.mjs
   ```
7. React with ✅ in the channel within 60 seconds when the approval-request appears
