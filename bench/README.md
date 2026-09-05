# bench — model cost sweep (2026-09-05)

Scripts and raw results behind the article "Agent SDK 3モデル実測｜1件$0.04〜0.32" (Zenn, @toki_mwc).

This branch is `bench-baseline` (the `examples/feature-add-slugify` implementation and tests are stripped so the feature-add scenario starts empty) plus this `bench/` folder.

| File | Purpose |
|---|---|
| `run-one.ps1 <model> <scenario>` | One ClawBus `run --auto` with the API key injected via `op run` into the process only, `CLAUDE_CONFIG_DIR` pointed at an empty dir so subscription OAuth cannot be picked up, 600 s timeout, secret-pattern scan of the outputs. |
| `run-batch.ps1` | Reps × models × scenarios driver. Resets the example dir with `git checkout` before each run, appends one CSV row per run. |
| `usage_from_transcripts.py` | Sums token usage from the isolated `CLAUDE_CONFIG_DIR` transcripts and prices it at list rates (the SDK `total_cost_usd` under-reports Opus). |
| `results-2026-09-05.csv` | 30 runs, 29 valid (one failed before any API call: 1Password authorization timeout). |

Requirements: Windows PowerShell 7, Node 22 (`CLAWBUS_NODE` to override), 1Password CLI with an env file `credit.env.op` containing `ANTHROPIC_API_KEY=op://<vault>/<item>/credential` (not committed).

Models were passed as full IDs (`claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`); the `sonnet`/`opus` aliases resolved to the previous generation with the bundled CLI 2.1.117.
