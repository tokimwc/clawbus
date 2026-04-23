# Scenario: live `clawbus demo --auto` against broken-node-project

> Captured: 2026-04-23 15:07–15:08 JST.
> Model: default Claude Sonnet (per `agents/sdk-helpers.ts`).
> API spend: **$0.0794** total ($0.0123 planner + $0.0339 + $0.0210 + $0.0122 across three worker subtasks).
> Wall time: ~74 seconds.

This is a real, end-to-end run of `npx clawbus demo --auto` against the
`examples/broken-node-project/` fixture (a deliberately buggy FizzBuzz
implementation). Three artifacts are captured alongside this narrative:

- [`run-01-fizzbuzz/stdout.txt`](run-01-fizzbuzz/stdout.txt) — verbatim CLI output during the run
- [`run-01-fizzbuzz/message-timeline.txt`](run-01-fizzbuzz/message-timeline.txt) — full append-only message log captured by `clawbus logs`
- [`run-01-fizzbuzz/fix.diff`](run-01-fizzbuzz/fix.diff) — the actual edit applied by the worker

## What the demo does

The Planner is given this single goal:

> "Run `npm test` in the working directory. Identify the single failing
> test, find the bug in src/fizzbuzz.mjs, apply a one-line fix using the
> Edit tool, then re-run `npm test` to confirm everything passes."

The Planner decomposes that into **three subtasks** ($0.0123, planner-only):

1. `s1` — run `npm test`, identify the failing test, report assertion details
2. `s2` — read `src/fizzbuzz.mjs`, locate the bug, apply a one-line fix using the Edit tool
3. `s3` — re-run `npm test` and confirm it passes

## Approval gate fires exactly once

Subtasks `s1` and `s3` are read-only — they call `Bash` to run tests but
mutate nothing. They produce a `result` directly with no `approval-request`.

Subtask `s2` is the only one that needs to mutate a file. Before the
worker calls `Edit`, it emits an `approval-request`:

```
2026-04-23 06:08:05  worker → approval-gate  [approval-request]
    action: Edit C:\...\examples\broken-node-project\src\fizzbuzz.mjs
    severity: medium
```

The `--auto` flag means the approval gate auto-approves and emits an
`approval-decision` immediately:

```
2026-04-23 06:08:05  approval-gate → worker  [approval-decision]
    decision: approve (auto-approved)
```

Without `--auto`, this is the single point where the operator gets a
terminal prompt asking "approve / reject this Edit?". The point is the
**gate is structural** — it's the difference in code path between
`severity: low` reads and `severity: medium` writes, not an opinion the
worker has to volunteer.

## The actual fix

The worker applied the minimal correct fix — reorder the branch checks
so `n % 15 === 0` is evaluated before the individual `n % 3` and `n % 5`
checks (see [`fix.diff`](run-01-fizzbuzz/fix.diff)):

```diff
 export function fizzbuzz(n) {
   // BUG: the order of these branches is wrong. `n % 3 === 0` fires before
   // `n % 15 === 0`, so 15, 30, 45, ... return "Fizz" instead of "FizzBuzz".
+  if (n % 15 === 0) return "FizzBuzz";
   if (n % 3 === 0) return "Fizz";
   if (n % 5 === 0) return "Buzz";
-  if (n % 15 === 0) return "FizzBuzz";
   return String(n);
 }
```

After the edit, `s3` re-runs `npm test` and confirms all 4 tests pass.

## Cost breakdown

| Step | Cost (USD) | What it bought |
|---|---:|---|
| Planner | $0.0123 | Decompose 1 goal → 3 subtasks |
| Worker s1 (read) | $0.0339 | Run `npm test`, parse output, identify failing test |
| Worker s2 (mutate) | $0.0210 | Read source, locate bug, propose Edit, apply on approval |
| Worker s3 (verify) | $0.0122 | Re-run `npm test`, confirm pass |
| **Total** | **$0.0794** | full Planner→Worker→Gate→Worker pipeline |

For reference: the Anthropic hackathon credit pool is $500. This whole
run consumes 0.016% of it.

## Message-kind distribution

Across the 9 messages logged:

| Kind | Count | Example |
|---|---:|---|
| `task` | 3 | planner → worker, one per subtask |
| `result` | 3 | worker → planner, one per subtask completion |
| `approval-request` | 1 | only for the file-mutating subtask |
| `approval-decision` | 1 | auto-approved for this run |
| `log` | 1 | "Planner produced 3 subtask(s)" broadcast |

The `parent` field on every message links each `result` back to its
originating `task`, and the `approval-decision` back to its
`approval-request`. That's how the entire run is auditable after the
fact: tail any node and walk up `parent` to reconstruct the causal
chain.

## Reproducing this

```bash
git clone https://github.com/tokimwc/clawbus.git
cd clawbus
npm install && npm run build
export ANTHROPIC_API_KEY=sk-ant-...
rm -rf .clawbus                                    # start clean
git checkout -- examples/broken-node-project/      # reset the bug
npx clawbus demo --auto                            # run
npx clawbus logs                                   # inspect timeline
```

The output should be substantively the same as the captured artifacts in
this directory (the model is non-deterministic but the structural
sequence — 3 subtasks, 1 approval-request, the same edit — is stable).
