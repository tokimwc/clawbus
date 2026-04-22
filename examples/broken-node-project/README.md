# broken-node-project

A deliberately buggy toy project used by the ClawBus demo.

## The bug

`src/fizzbuzz.mjs` has the branch order wrong: `n % 3 === 0` is checked before
`n % 15 === 0`, so multiples of 15 incorrectly return `"Fizz"` instead of
`"FizzBuzz"`.

## Running the tests

```bash
npm test
```

The `FizzBuzz` test fails until the branch order is fixed.

## How ClawBus fixes this

`npx clawbus demo` (from the parent repo) runs a Planner → Worker → Human
Approval pipeline against this directory:

1. Planner decomposes the goal "make the failing test pass".
2. Worker runs the tests, reads the source, proposes a one-line fix.
3. Human Approval Gate prompts you at the terminal before the Edit is applied.
4. On approval, the Edit goes through and the test suite is re-run.

All messages (task / result / approval-request / approval-decision / log) are
persisted to `.clawbus/bus.sqlite` and can be inspected with `npx clawbus logs`.
