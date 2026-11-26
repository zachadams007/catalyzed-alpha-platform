# Daily broad-universe scan -- scheduled-run wrapper (Windows / PowerShell).
#
# Loads server-only secrets + CURRENT vendor keys from .scan.env (gitignored)
# into the PROCESS environment BEFORE vite-node starts, so Vite exposes the
# current VITE_* keys via import.meta.env (process env wins over the app's .env,
# which may hold a stale/rotated key). Runs one scan pass and appends to scan.log.
#
# Run it once by hand:    powershell -ExecutionPolicy Bypass -File scripts\universe_scan\run_scan.ps1
# Dry run (no publish):   ... -File scripts\universe_scan\run_scan.ps1 -Dry
# Probe the environment:  ... -File scripts\universe_scan\run_scan.ps1 -Probe
#
# Schedule it (cloud is preferred via GitHub Actions; this is the local option):
#   $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
#                -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PWD\scripts\universe_scan\run_scan.ps1`""
#   $trigger = New-ScheduledTaskTrigger -Daily -At 8:00AM
#   Register-ScheduledTask -TaskName "CatalyzedUniverseScan" -Action $action -Trigger $trigger
#   # Remove later:  Unregister-ScheduledTask -TaskName "CatalyzedUniverseScan" -Confirm:$false
#
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads BOM-less scripts in the
# system codepage; a stray non-ASCII char corrupts parsing).

param(
  [switch]$Dry,
  [switch]$Probe
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here "..\..")
$envFile = Join-Path $here ".scan.env"
$logFile = Join-Path $here "scan.log"

if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
      $idx = $line.IndexOf("=")
      $name = $line.Substring(0, $idx).Trim()
      $value = $line.Substring($idx + 1).Trim()
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
} else {
  Write-Warning "No .scan.env found at $envFile -- copy .scan.env.example and fill it in."
}

if ($Dry) { [Environment]::SetEnvironmentVariable("SCAN_DRY_RUN", "1", "Process") }
$wrapperStartedAtISO = [DateTimeOffset]::UtcNow.ToString("o")
[Environment]::SetEnvironmentVariable("CATALYZED_WRAPPER_STARTED_AT_ISO", $wrapperStartedAtISO, "Process")

$script = if ($Probe) { "scripts/universe_scan/probe.mts" } else { "scripts/universe_scan/scan.mts" }
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $logFile -Value "`n[$stamp] $script (dry=$($Dry.IsPresent))"

Set-Location $repo
$ErrorActionPreference = "Continue"

$worktreeState = & git status --porcelain --untracked-files=normal 2>$null
if ($LASTEXITCODE -eq 0 -and $worktreeState) {
  # A commit SHA cannot identify code executed from a dirty worktree. The
  # non-SHA marker is intentionally quarantined by the archive contract.
  [Environment]::SetEnvironmentVariable("CATALYZED_CODE_REVISION", "unverified-dirty-worktree", "Process")
} else {
  $revisionRaw = & git rev-parse HEAD 2>$null
  $revision = ([string]$revisionRaw).Trim()
  if ($revision) {
    [Environment]::SetEnvironmentVariable("CATALYZED_CODE_REVISION", $revision, "Process")
  }
}

# A Scheduled Task runs with a minimal PATH; resolve node and put its dir first
# so npx/node are found (mirrors run_writer.ps1's python resolution).
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) { $env:PATH = (Split-Path $node) + ";" + $env:PATH }

& npx vite-node $script *>> $logFile
$code = $LASTEXITCODE

# If the in-process (vite-node) publish failed, recover the saved compute via the
# plain-node publisher -- robust for the large 500-name body. Skip for probe.
if ($code -ne 0 -and -not $Probe -and -not $Dry -and (Test-Path (Join-Path $here "last-scan.json"))) {
  $attemptFile = Join-Path $here "last-attempt.json"
  if (Test-Path $attemptFile) {
    try {
      $attempt = Get-Content -Raw $attemptFile | ConvertFrom-Json
      [Environment]::SetEnvironmentVariable(
        "CATALYZED_EXPECTED_SOURCE_RUN_ID",
        [string]$attempt.sourceRunId,
        "Process"
      )
    } catch {
      [Environment]::SetEnvironmentVariable("CATALYZED_EXPECTED_SOURCE_RUN_ID", "invalid", "Process")
    }
  } else {
    [Environment]::SetEnvironmentVariable("CATALYZED_EXPECTED_SOURCE_RUN_ID", "missing", "Process")
  }
  Add-Content -Path $logFile -Value "[$stamp] scan exit $code -- recovering via publish.mjs"
  & node (Join-Path $here "publish.mjs") *>> $logFile
  $code = $LASTEXITCODE
}

Add-Content -Path $logFile -Value "[$stamp] exit $code"
exit $code
