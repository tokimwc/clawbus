# Phase 3 — single Sonnet run, key injected by `op run` (never typed, never echoed, never on disk).
# Cap: 1 run, 10-min wall-clock timeout, kill tree on timeout. Process scope only.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Poc  = 'C:\tmp\clawbus-api-credit-poc'
$Node = if ($env:CLAWBUS_NODE) { $env:CLAWBUS_NODE } else { (Get-Command node).Source }
$Model = if ($args.Count -ge 1) { $args[0] } else { 'sonnet' }
$TimeoutMs = 600000
# NOTE: 'demo' ignores --model (cmdDemo never forwards it -> planner Sonnet 4.6 / worker Opus 4.7 defaults). Use 'run' so --model reaches both.
$Scenario = if ($args.Count -ge 2) { $args[1] } else { 'broken-node-project' }
$Cwd = Join-Path $Poc ('examples\' + $Scenario)
$Goal = switch ($Scenario) {
  'broken-node-project' { 'Run `npm test` in the working directory. Identify the single failing test, find the bug in src/fizzbuzz.mjs, apply a one-line fix using the Edit tool, then re-run `npm test` to confirm everything passes.' }
  'feature-add-slugify' { 'Implement the `slugify(input)` function specified in src/utils.mjs. Add tests for it under test/utils.test.mjs covering the four examples in the spec. Run `npm test` and report whether all tests pass.' }
  default { throw "unknown scenario $Scenario" }
}

Set-Location $Poc
Remove-Item Env:\OP_SERVICE_ACCOUNT_TOKEN -ErrorAction SilentlyContinue   # desktop-app integration (personal account)
$env:OP_CONFIG_DIR = "$env:LOCALAPPDATA\op"
# Isolate the SDK-spawned claude CLI from ~/.claude OAuth credentials so it MUST use the injected API key.
# (2026-09-05: without this, the Phase 3 run silently billed the Max subscription; Console logs showed no request.)
$env:CLAUDE_CONFIG_DIR = 'C:\tmp\claude-cfg-credit'
New-Item -ItemType Directory -Force $env:CLAUDE_CONFIG_DIR | Out-Null
if (Test-Path (Join-Path $env:CLAUDE_CONFIG_DIR '.credentials.json')) { Write-Host "ABORT: OAuth credentials present in isolated config dir"; exit 5 }

$commit = (git -c safe.directory=C:/tmp/clawbus-api-credit-poc rev-parse HEAD).Trim()
if ($commit -ne 'caacf753ba2c03f0f7ae46de34856bf7dc370547') { Write-Host "COMMIT MISMATCH $commit -- abort"; exit 3 }

# Guard: no billing env in persistent scopes before the run
foreach ($s in 'User','Machine') { foreach ($v in 'ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL') {
  if ([Environment]::GetEnvironmentVariable($v,$s)) { Write-Host "ABORT: $v is set in $s scope"; exit 4 } } }
if ($env:ANTHROPIC_API_KEY) { Write-Host "ABORT: ANTHROPIC_API_KEY already in Process scope"; exit 4 }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = ".\run-$stamp-$Model-$Scenario.stdout.txt"; $err = ".\run-$stamp-$Model-$Scenario.stderr.txt"; $meta = ".\run-$stamp-$Model-$Scenario.meta.txt"
Write-Host "goal=$Goal"
Write-Host "node=$(& $Node -v) commit=$($commit.Substring(0,8)) model=$Model timeout=${TimeoutMs}ms"
Write-Host "Console credit BEFORE (user-recorded): see meta"

$sw = [Diagnostics.Stopwatch]::StartNew()
$pr = Start-Process op -ArgumentList @('run','--env-file','.\credit.env.op','--', $Node, 'dist/cli/index.js','run','--auto','--model',$Model,'--cwd',('"' + $Cwd + '"'),'--goal',('"' + $Goal.Replace('"','\"') + '"')) `
      -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
if (-not $pr.WaitForExit($TimeoutMs)) {
  & taskkill /T /F /PID $pr.Id | Out-Null
  $code = "TIMEOUT(>$($TimeoutMs/60000)min)"
} else { $code = $pr.ExitCode }
$sw.Stop()

$leak = [bool]$env:ANTHROPIC_API_KEY
foreach ($s in 'User','Machine') { if ([Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY',$s)) { $leak = $true } }
$line = "ts=$stamp model=$Model exit=$code wall_sec=$([math]::Round($sw.Elapsed.TotalSeconds,1)) key_leaked=$leak stdout=$out stderr=$err"
Write-Host $line; $line | Out-File -FilePath $meta -Encoding utf8
# secret scan of outputs (pattern only, no values printed)
$hits = Select-String -Path $out,$err -Pattern 'sk-ant-api' -SimpleMatch | Measure-Object | Select-Object -ExpandProperty Count
Write-Host "secret_pattern_hits_in_output=$hits"; "secret_pattern_hits_in_output=$hits" | Out-File -FilePath $meta -Encoding utf8 -Append
exit 0
