# feature-add-slugify

Empty starter for a ClawBus scenario that **adds a new feature** (rather
than fixing a bug like `broken-node-project` does).

## Initial state

- `src/utils.mjs` — contains only a spec comment for `slugify`
- `test/` — empty (no tests yet)
- `npm test` — passes trivially because there are no tests yet

## What ClawBus is asked to do

```
Implement the `slugify(input)` function specified in src/utils.mjs.
Add tests for it under test/utils.test.mjs covering the four examples
in the spec. Run `npm test` and report whether all tests pass.
```

## What's interesting about this scenario

Compared to `broken-node-project` (single 1-line bug fix):

- The Planner has to decompose into **at least 2 mutating subtasks**
  (implement function, write tests).
- Each mutating subtask raises an `approval-request`. The bus gets
  more activity and the audit log shows the full timeline of what got
  approved when.
- The Worker has to **read a comment-only spec** and produce both
  source code and tests — closer to real-world coding tasks than
  bugfixing.

See `docs/scenarios/run-02-feature-add.md` for the captured run.
