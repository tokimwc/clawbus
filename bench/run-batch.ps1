# Phase 4 batch: scenarios x models x reps, sequential, via run-one.ps1 (API key path, isolated config).
# Hard caps: cumulative SDK cost (USD), total wall-clock. Example dir reset (git clean + checkout) before every run.
# Usage: powershell -File run-batch.ps1 [-Reps 5] [-MaxSdkUsd 12] [-MaxMinutes 120]
param([int]$Reps = 5, [double]$MaxSdkUsd = 12.0, [int]$MaxMinutes = 120,
      [string[]]$Models = @('claude-haiku-4-5','claude-sonnet-5','claude-opus-5'),
      [string[]]$Scenarios = @('broken-node-project','feature-add-slugify'))
$ErrorActionPreference = 'Continue'
$Poc = 'C:\tmp\clawbus-api-credit-poc'; Set-Location $Poc
$Node = if ($env:CLAWBUS_NODE) { $env:CLAWBUS_NODE } else { (Get-Command node).Source }
$csv = Join-Path $Poc ("phase4-results-{0}.csv" -f (Get-Date -Format 'yyyyMMdd-HHmm'))
'ts,scenario,model,rep,success,wall_sec,sdk_cost_usd,subtasks,approvals,stdout' | Out-File $csv -Encoding utf8
$cum = 0.0; $sw = [Diagnostics.Stopwatch]::StartNew()

function Test-Success([string]$Scenario) {
  $dir = Join-Path $Poc ("examples\" + $Scenario)
  Push-Location $dir
  try {
    $out = & $Node --test ($(if ($Scenario -eq 'broken-node-project') { 'test.mjs' } else { 'test/*.mjs' })) 2>&1 | Out-String
    $pass = [int]([regex]::Match($out, '# pass (\d+)').Groups[1].Value); $fail = [int]([regex]::Match($out, '# fail (\d+)').Groups[1].Value)
    if ($Scenario -eq 'broken-node-project') { return ($pass -eq 4 -and $fail -eq 0) }
    # slugify: implementation present + at least 4 passing tests, none failing
    $impl = (Get-Content (Join-Path $dir 'src\utils.mjs') -Raw) -match 'export function slugify|export const slugify'
    return ($impl -and $pass -ge 4 -and $fail -eq 0)
  } finally { Pop-Location }
}

foreach ($rep in 1..$Reps) { foreach ($sc in $Scenarios) { foreach ($m in $Models) {
  if ($cum -ge $MaxSdkUsd) { Write-Host "STOP: cumulative SDK cost $cum >= cap $MaxSdkUsd"; break }
  if ($sw.Elapsed.TotalMinutes -ge $MaxMinutes) { Write-Host "STOP: wall-clock cap"; break }
  git -c safe.directory=* clean -fdq examples/ ; git -c safe.directory=* checkout -- examples/
  $t0 = Get-Date
  $log = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Poc 'run-one.ps1') $m $sc 2>&1 | Out-String
  $wall = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  $stdout = [regex]::Match($log, 'stdout=(\S+)').Groups[1].Value
  $text = if ($stdout -and (Test-Path $stdout)) { [string](Get-Content $stdout -Raw) } else { '' }
  if ([string]::IsNullOrWhiteSpace($text)) {
    # infra failure (e.g. op authorization timeout): no API call happened. Record and do not inherit stale values.
    $sdk = 0.0; $subs = ''; $appr = 0; $ok = 'infra-error'
    $line = "{0},{1},{2},{3},{4},{5},{6},{7},{8},{9}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $sc, $m, $rep, $ok, $wall, $sdk, $subs, $appr, $stdout
    $line | Out-File $csv -Append -Encoding utf8; Write-Host "[$(Get-Date -Format HH:mm)] $sc $m rep$rep INFRA-ERROR (see stderr)"; continue
  }
  $costs = [regex]::Matches($text, 'cost[=\s]\$?([0-9.]+)') | % { [double]$_.Groups[1].Value }
  $sdk = [math]::Round([double](($costs | Measure-Object -Sum).Sum), 4)
  $subs = [regex]::Match($text, 'produced (\d+) subtask').Groups[1].Value
  $appr = ([regex]::Matches($text, 'approvals=(\d+)') | % { [int]$_.Groups[1].Value } | Measure-Object -Sum).Sum
  $ok = Test-Success $sc
  $cum += $sdk
  $line = "{0},{1},{2},{3},{4},{5},{6},{7},{8},{9}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $sc, $m, $rep, $ok, $wall, $sdk, $subs, $appr, $stdout
  $line | Out-File $csv -Append -Encoding utf8
  Write-Host ("[{0}] {1} {2} rep{3} ok={4} wall={5}s sdk=${6} cum=${7}" -f (Get-Date -Format 'HH:mm'), $sc, $m, $rep, $ok, $wall, $sdk, [math]::Round($cum,2))
}}}
git -c safe.directory=* clean -fdq examples/ ; git -c safe.directory=* checkout -- examples/
Write-Host "DONE results=$csv cumulative_sdk_usd=$([math]::Round($cum,2)) elapsed_min=$([math]::Round($sw.Elapsed.TotalMinutes,1))"
