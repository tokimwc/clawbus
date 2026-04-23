# Scenario: implementing a new feature (not just a bug fix)

> Captured: 2026-04-23 15:32–15:33 JST.
> Model: default Claude Sonnet.
> API spend: **$0.0945** total ($0.0104 planner + $0.0265 + $0.0448 + $0.0128 across three worker subtasks).
> Wall time: ~102 seconds.

This scenario is deliberately different from [`run-01-fizzbuzz`](run-01-fizzbuzz.md):

| | run-01 | run-02 |
|---|---|---|
| Starting state | Broken (test fails) | **Empty** (no implementation, no tests) |
| Task type | Fix an existing bug | **Add a new feature** |
| Files to mutate | 1 | **2 (source + test)** |
| Approval gates fired | 1 | **2** |
| Spec source | Test assertions | **A comment block in `src/utils.mjs`** |

Artifacts in this directory:
- [`stdout.txt`](run-02-feature-add/stdout.txt) — verbatim CLI output
- [`message-timeline.txt`](run-02-feature-add/message-timeline.txt) — full `clawbus logs` (11 messages)
- [`changes.diff`](run-02-feature-add/changes.diff) — all files created by ClawBus + scaffolding

## The goal

```
Implement the `slugify(input)` function specified in src/utils.mjs.
Add tests for it under test/utils.test.mjs covering the four examples
in the spec. Run `npm test` and report whether all tests pass.
```

The "spec" is a comment block in `src/utils.mjs`:

```js
// Spec (ClawBus reads from this comment):
//   slugify(input: string): string
//   - lowercase the input
//   - replace any run of non-alphanumeric characters with a single "-"
//   - trim leading/trailing "-"
//   Examples:
//     slugify("Hello World")           -> "hello-world"
//     slugify("  Foo--Bar !!  ")       -> "foo-bar"
//     slugify("Привет")                 -> "" (no ASCII alphanumeric)
//     slugify("v4.7-beta+build")       -> "v4-7-beta-build"
```

## Planner's decomposition ($0.0104)

The Planner read the goal and emitted three subtasks:

1. `s1` — Read src/utils.mjs to view the slugify specification, then implement the slugify(input) function according to the spec.
2. `s2` — Create test/utils.test.mjs with tests covering the four examples from the slugify spec in src/utils.mjs.
3. `s3` — Run `npm test` and report whether all tests pass, including any failure details.

Notice that the Planner chose to separate "implement" from "write tests" into distinct subtasks. Either ordering would work — implement first makes more sense here because the test file will import the function — and the Planner got it right.

## What ClawBus implemented

The Worker (subtask `s1`) emitted an `approval-request` before editing `src/utils.mjs`, which the auto-approver passed. The resulting implementation:

```js
export function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

Short, correct, and matches the spec comment precisely. No imports, no dependencies, no over-engineering.

## What ClawBus tested (subtask `s2`)

The Worker created `test/utils.test.mjs` from scratch — again behind an `approval-request`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/utils.mjs';

test('slugify: lowercases and joins words with a hyphen', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('slugify: collapses runs of non-alphanumeric chars and trims hyphens', () => {
  assert.equal(slugify('  Foo--Bar !!  '), 'foo-bar');
});

test('slugify: returns empty string when input has no ASCII alphanumeric chars', () => {
  assert.equal(slugify('Привет'), '');
});

test('slugify: replaces dots, plus signs, and hyphens with a single hyphen', () => {
  assert.equal(slugify('v4.7-beta+build'), 'v4-7-beta-build');
});
```

One test per spec example, named meaningfully. `npm test` reported 4 pass / 0 fail (subtask `s3`).

## Cost breakdown

| Step | Cost (USD) | What it bought | Approvals |
|---|---:|---|---:|
| Planner | $0.0104 | Decompose 1 goal → 3 subtasks | 0 |
| Worker s1 (implement) | $0.0265 | Read spec, write slugify, propose + apply Edit | 1 |
| Worker s2 (test) | $0.0448 | Write 4-test file from scratch, propose + apply Write | 1 |
| Worker s3 (verify) | $0.0128 | Run `npm test`, report pass/fail | 0 |
| **Total** | **$0.0945** | | **2** |

Slightly more expensive than `run-01` ($0.0794) because s2 wrote a new file from scratch rather than applying a 1-line diff.

## Message distribution (11 total)

| Kind | Count |
|---|---:|
| `task` | 3 |
| `result` | 3 |
| `approval-request` | 2 |
| `approval-decision` | 2 |
| `log` | 1 |

Compared to `run-01` (9 messages, 1 approval), this run shows **more approval-gate activity** because two distinct files needed mutation. The append-only log has 2 inspectable `approval-request` payloads — both with full file path, severity, and rationale — for the auditor to review after the fact.

## Reproducing this

```bash
git clone https://github.com/tokimwc/clawbus.git
cd clawbus
npm install && npm run build
export ANTHROPIC_API_KEY=sk-ant-...
rm -rf .clawbus
git checkout -- examples/feature-add-slugify/

npx clawbus run \
  --goal "Implement the \`slugify(input)\` function specified in src/utils.mjs. Add tests for it under test/utils.test.mjs covering the four examples in the spec. Run \`npm test\` and report whether all tests pass." \
  --cwd examples/feature-add-slugify \
  --auto

npx clawbus logs
```

The model is non-deterministic, but the structural shape — 3 subtasks, 2 approval-requests, the same two file outputs — is stable across runs.
