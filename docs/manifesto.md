# Why ClawBus matters for Claude Code

> A short note on what we learned running multi-agent Claude Code in
> production, and why the answer was "a smaller thing, not a bigger one."

## The observation

Claude Code is the best single-session coding agent I've ever used.
It can hold a problem in its head for an hour, run the tests, read the
failing output, fix the bug, and keep moving. Per session, it is
complete.

But "per session" is where things break down once real work scales
beyond one person at one screen.

For several months I've been running Claude Code across a small
cluster of machines at home. One node plans. Another reads logs and
Vault notes. A third applies edits. A fourth keeps watch for approval
prompts. Each one is a Claude Code session in its own right. The
interesting work is not *inside* any one of them — it's the **hand-offs
between them**.

Every hand-off I'd ever built went through the same two failure modes:

1. **Context loss.** Agent A and agent B share no memory. B starts
   from scratch unless A writes a good brief — which it sometimes
   does and sometimes doesn't.
2. **Silent mutations.** Agent B applies a change that A wouldn't
   have sanctioned. I find out via `git log` an hour later.

The temptation — and I've built this temptation's output twice — is to
reach for a **workflow engine**: nodes, edges, state, retries,
compensations. Something that looks like n8n but for agents. And
every time I got halfway through one I noticed that the **thing doing
the actual work is still Claude Code**. The workflow engine is just
the thing that tells Claude Code when to wake up.

So what if we just… didn't build that?

## The design bet

ClawBus is the smallest thing that fixes the two failure modes above
without inventing a new agent runtime:

- **A minimal protocol.** Five message kinds. `task` asks for work.
  `result` answers. `approval-request` pauses a mutation with a fully
  inspectable payload (action, diff, severity, rationale).
  `approval-decision` records the human or meta-agent's call.
  `log` keeps operational breadcrumbs without polluting `result`
  semantics.
- **An append-only store.** Every message is persisted before it's
  delivered, with a causal `parent` pointer to whatever triggered it.
  "What did the agent say right before this?" becomes a `SELECT`.
- **Swappable adapters.** The same protocol rides on local files,
  SQLite, or Discord today, with a four-method `Adapter` interface
  that's small enough to implement a new transport in an afternoon.

That's it. The bus is four methods. The protocol is five kinds.
The "framework" is what your agents already are — Claude Code
sessions that happen to read and write a log.

## Why this shape is Claude-Code-native

Claude Code is already opinionated about:

- **Tool discipline.** The SDK surfaces explicit tools; it won't
  silently shell out. The agent has to reach for `Edit` or `Write`
  by name.
- **Session coherence.** Within a session, Claude Code carries your
  conversation, cached context, and CLAUDE.md memory.

ClawBus complements both. The `approval-request` kind carries the
same `Edit` / `Write` tool payload the SDK would have applied
locally, just with the human-sign-off step reified as a message.
The bus doesn't reach past the tool layer; it sits *in between* tool
proposal and tool execution, exactly where the SDK already has a
natural seam.

Put another way: if you squint at the `canUseTool` SDK hook, you can
see the same idea forming. ClawBus names that shape and persists it.

## What we resisted

Things we could have built, and chose not to:

- **A DAG engine.** No nodes, no edges, no cron. If you want
  scheduling, cron the agent. If you want retries, retry the
  `task`. The bus is not a workflow.
- **A new agent runtime.** Agents stay as Claude Code / Claude Agent
  SDK sessions. ClawBus only moves messages between them.
- **"Smart" routing.** `to` is a string. Subscribers are also strings.
  No roles, no capabilities, no skill-matching. If you want
  routing, own the routing; the bus won't surprise you.
- **Extensibility via plugins.** There's an adapter contract, and
  that's the extension point. No lifecycle hooks, no middleware
  stack, no event emitters.

If an agent bus is four methods and a protocol is five kinds, the
temptation toward over-abstraction is a tell. We try to resist it.

## What we got right (so far)

Two real end-to-end runs, both captured verbatim in
[`docs/scenarios/`](scenarios/):

- A bug fix ($0.08, 9 messages, 1 approval-request) across the SQLite
  adapter.
- A feature addition ($0.09, 11 messages, 2 approval-requests) across
  the same adapter.
- The same Planner / Worker / Gate code running over a Discord
  channel instead of a local file — ✅ reactions become
  `approval-decision` messages with no change to the protocol or the
  agents.

The thing that stayed the same across all three runs is the *agents*.
What changed is the *transport*. That's the only real test of whether
"adapter pluralism" is a marketing slogan or a design property.

## What this is not claiming

- **Not a production system.** Tested by one person on a five-node
  cluster. You should treat it as reference code.
- **Not the last word on multi-agent coordination.** We don't do
  scheduling, backpressure, retries, priority queues, message TTL,
  tracing integrations, or a hundred other things distributed systems
  eventually need. None of those belong in a v0 protocol.
- **Not a Claude Code replacement.** Claude Code is the thing doing
  the work. ClawBus is the thing telling the work where to go.

## What would change the shape

Things we'd add *only* if the production runs forced us to:

- A `cancel` message kind, if we ever see runaway tasks in the wild.
- A `schema-version` field on messages, if we ever need backward-
  compatible protocol changes.
- A dashboard. A simple HTML view of the timeline, not a framework.

None of these are in v0 because we haven't hit the pain. The point
of shipping a small protocol is to let the pain tell us what to add
next.

## The wager

If multi-agent Claude Code becomes the default way people use
Claude Code at scale — and it probably will — then the hard part
will not be "how do we make agents smarter." They're already
smart enough. The hard part will be "how do we make it
auditable, humane, and debuggable for the person on the other side."

ClawBus is a small bet in that direction. Message kind by message
kind, approval gate by approval gate.
