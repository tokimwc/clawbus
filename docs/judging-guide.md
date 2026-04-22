# Judging guide — 5-minute review

This is a reviewer's cheat sheet for **Built with Opus 4.7: a Claude Code
Hackathon**. Everything here can be verified with `git clone` and a single
`ANTHROPIC_API_KEY`.

## Run the demo (≈ 90 seconds)

```bash
git clone https://github.com/tokimwc/clawbus.git
cd clawbus
npm install
npm run build
export ANTHROPIC_API_KEY=sk-ant-...
npx clawbus demo
```

What you should see:

1. **Planner** prints a decomposition of the goal ("fix the failing test").
2. **Worker** runs `npm test` in `examples/broken-node-project/`, reads the
   source, and proposes an `Edit` on `src/fizzbuzz.mjs`.
3. The proposed edit is **paused at a human approval prompt** — you type
   `y` or `n` at the terminal.
4. On approval, the edit is applied and the tests are re-run. `status: ok`.
5. On reject, the worker reports the denial in its result summary and no
   file is modified.

Use `--auto` to skip the prompts for recording:

```bash
npx clawbus demo --auto
```

## Audit the timeline

```bash
npx clawbus logs
npx clawbus logs --kind approval-request
npx clawbus logs --kind approval-decision
```

Every message is append-only in `.clawbus/bus.sqlite` with a `parent`
field linking responses to their triggers. You can reconstruct the full
causal graph of any run after the fact.

## What to look at

| Dimension | Where to look |
|---|---|
| **Protocol** | [`docs/protocol.md`](./protocol.md) — 5 kinds, small, versioned |
| **Core** | [`src/core/bus.ts`](../src/core/bus.ts) — `send` / `subscribe` / `waitFor` / `query` |
| **Adapters** | [`src/adapters/file.ts`](../src/adapters/file.ts) and [`src/adapters/sqlite.ts`](../src/adapters/sqlite.ts) — same contract, two backends |
| **Agents (SDK integration)** | [`src/agents/planner.ts`](../src/agents/planner.ts), [`src/agents/worker.ts`](../src/agents/worker.ts), [`src/agents/approval.ts`](../src/agents/approval.ts) |
| **Human-in-the-loop** | [`src/agents/worker.ts`](../src/agents/worker.ts) — `canUseTool` routes `Edit` / `Write` through the bus |
| **Tests** | `test/core.test.ts` (8), `test/adapters.test.ts` (12). Run with `npm test`. |

## Design bets

- **Protocol, not framework.** Only five message kinds. The rest is up to
  the caller, so a Planner can be a one-shot `query()` or a stateful
  session — the bus doesn't care.
- **Append-only, causal.** Every message has a `parent` link. Given any
  message id you can reconstruct the chain that led to it.
- **Adapters are swappable without touching agents.** The demo runs on
  SQLite; the same code runs on the File adapter, and a Discord adapter
  is on the roadmap for distributed teams.
- **Approval is first-class.** `approval-request` and `approval-decision`
  are message kinds, not bolted-on hooks. Any agent can demand approval
  from any other, and the exchange is visible in `clawbus logs`.

## Hackathon compliance

- Initial commit `896c4e0` is timestamped **2026-04-22 JST** — after the
  hackathon kickoff (2026-04-21 12:00 PM EDT = 2026-04-22 01:00 JST).
- No code was copied from any previous project. The design is informed
  by a production multi-agent system run across my 5-node home cluster,
  but every file under `src/`, `docs/`, `examples/`, and `test/` was
  authored fresh during the hackathon window.
- MIT licensed, all copyrights are mine.

If you want to verify the provenance claim, `git log --reverse` shows
the whole history, and `git show <hash>` on any commit shows exactly what
landed when.
