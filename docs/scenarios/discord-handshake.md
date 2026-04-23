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
   (react with ✅ or ❌ in Discord; reviewers: 836376415955058738)
[14:29:45] [human seat received] approval-request from worker

→ waiting up to 60s for human reaction...
[14:29:48] [worker received] approval-decision from human
✓ approval-decision received: approve (reviewer 836376415955058738)

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
