# Judging guide — 5-minute review

**Built with Opus 4.7: a Claude Code Hackathon** · Cerebral Valley × Anthropic

This is a reviewer's cheat sheet. The whole repo is designed to be
auditable in under 5 minutes. Pick your path:

- **No API key, 60 seconds** → read the [captured run logs](#no-api-key-path)
- **With `ANTHROPIC_API_KEY`, 3 minutes** → run [the demo yourself](#with-api-key-path)
- **Reviewer with deeper interest, 5+ minutes** → [design bets](#design-bets) and [code pointers](#code-pointers)

---

## TL;DR (30 seconds)

ClawBus turns multiple Claude Code sessions into one observable,
auditable agent team. It's **a protocol, not a framework**:

- **5 message kinds** (`task` / `result` / `approval-request` / `approval-decision` / `log`)
- **Append-only store** with a causal `parent` link on every message
- **3 working adapters today**: `FileAdapter`, `SQLiteAdapter`, `DiscordAdapter`
- **Human-in-the-loop as a first-class kind**, not a hook bolted on top

---

## <a id="no-api-key-path"></a>Path A — No API key (60 seconds)

Two captured end-to-end runs, verbatim artifacts already in the repo:

| Scenario | What it shows | Spend |
|---|---|---:|
| [`docs/scenarios/run-01-fizzbuzz.md`](scenarios/run-01-fizzbuzz.md) | Bug fix: Planner decomposes, Worker finds + fixes, approval gate fires once | **$0.0794** |
| [`docs/scenarios/run-02-feature-add.md`](scenarios/run-02-feature-add.md) | New feature: 2 files created, approval gate fires twice, spec comes from a comment block | **$0.0945** |
| [`docs/scenarios/discord-handshake.md`](scenarios/discord-handshake.md) | Same protocol, same worker, but running **over a real Discord channel** — a ✅ reaction becomes an `approval-decision` message | **$0 (Discord)** |

Each doc contains the full `clawbus logs` timeline (every message
body), the CLI stdout, and — for the mutating runs — the exact diff
the worker applied. You can audit the whole system from these three
documents alone.

---

## <a id="with-api-key-path"></a>Path B — With API key (3 minutes)

```bash
git clone https://github.com/tokimwc/clawbus.git
cd clawbus && npm install && npm run build
export ANTHROPIC_API_KEY=sk-ant-...
npx clawbus demo --auto      # runs the FizzBuzz scenario end-to-end
npx clawbus logs             # prints the whole message timeline
```

Expected output (structure, not exact bytes — the model is
non-deterministic):

1. Planner decomposes the goal into 3 subtasks (~$0.01)
2. Worker runs `npm test`, identifies the failing test (~$0.03)
3. Worker reads source, proposes an `Edit` — emits `approval-request` — gate approves — patch lands (~$0.02)
4. Worker re-runs tests, reports pass (~$0.01)
5. `clawbus logs` prints 9 messages with full causal chain

Drop `--auto` to see the approval gate actually ask before touching
your disk. Total run: ~$0.08 and ~90 seconds.

### Try the Discord adapter (5 minutes, optional)

See [`docs/scenarios/discord-handshake.md`](scenarios/discord-handshake.md)
for the reproduction recipe. You'll need a bot token and a channel.

---

## <a id="design-bets"></a>Design bets

- **Protocol, not framework.** Five message kinds, a `parent` link, an
  append-only store. That's the whole surface. Your agents can be
  one-shot `query()` calls, stateful sessions, or anything in
  between — the bus doesn't care.
- **Observability by default.** Every agent utterance is persisted
  before it's delivered. Crash recovery, post-hoc audits, and
  "what did the agent say to get that answer?" are all just
  `clawbus logs` queries.
- **Human-in-the-loop is a first-class kind.** `approval-request` and
  `approval-decision` are in the protocol, not bolted on as a hook.
  The DiscordAdapter uses Discord reactions as the reviewer UI
  without changing the protocol at all.
- **Adapter pluralism.** The same code runs on local files, SQLite,
  or a shared Discord channel. That's the adapter contract doing its
  job — and it's the seam where Slack / NATS / Redis transports will
  plug in next.

---

## <a id="code-pointers"></a>Code pointers

| Thing | File |
|---|---|
| Protocol schema | [`src/core/types.ts`](../src/core/types.ts) |
| Bus core | [`src/core/bus.ts`](../src/core/bus.ts) — `send` / `subscribe` / `waitFor` / `query` |
| FileAdapter | [`src/adapters/file.ts`](../src/adapters/file.ts) |
| SQLiteAdapter | [`src/adapters/sqlite.ts`](../src/adapters/sqlite.ts) |
| DiscordAdapter | [`src/adapters/discord.ts`](../src/adapters/discord.ts) |
| Planner | [`src/agents/planner.ts`](../src/agents/planner.ts) |
| Worker | [`src/agents/worker.ts`](../src/agents/worker.ts) — `canUseTool` routes `Edit` / `Write` through the gate |
| Approval gate | [`src/agents/approval.ts`](../src/agents/approval.ts) |
| CLI | [`src/cli/index.ts`](../src/cli/index.ts) |
| Tests (27, all pass) | [`test/core.test.ts`](../test/core.test.ts) · [`test/adapters.test.ts`](../test/adapters.test.ts) · [`test/discord-adapter.test.ts`](../test/discord-adapter.test.ts) |
| CI | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — green on every commit to main |

---

## Hackathon compliance

- Initial commit timestamped **2026-04-22 JST** (after the 2026-04-21 12 PM EDT kickoff).
- **No code reuse** from prior projects. Design is informed by a
  production multi-agent system running on my 5-node home cluster;
  every file under `src/`, `test/`, `docs/`, and `examples/` is new work
  authored during the hackathon window.
- MIT licensed. `git log --reverse` shows the full provenance.

## Three things to take away

1. **Multi-agent coordination doesn't need a new runtime.** It needs a protocol, a log, and honest interfaces. That's ClawBus.
2. **Human approval belongs inside the protocol, not outside it.** `approval-request` carrying the full payload — path, diff, rationale — is the right shape. Reviews (human or another agent) become queryable messages.
3. **If a distributed transport can be a single file (`src/adapters/discord.ts`), your framework was too big.** ClawBus's `Adapter` interface is four methods. That's the lever.
