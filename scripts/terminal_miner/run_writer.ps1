# Terminal wire writer -- scheduled-run wrapper (Windows / PowerShell).
#
# Loads server-only secrets from .writer.env (gitignored), runs ONE writer pass,
# and appends output to wire_writer.log. Point a Scheduled Task at this script to
# keep the Supabase terminal_events cache warm for the web/phone build.
#
# Register a task that runs every 30 minutes (run once, in a normal PowerShell;
# adjust the interval to taste, mind FMP's 250/day free tier):
#
#   $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
#                -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PWD\scripts\terminal_miner\run_writer.ps1`""
#   $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
#                -RepetitionInterval (New-TimeSpan -Minutes 30)
#   Register-ScheduledTask -TaskName "CatalyzedTerminalWire" -Action $action -Trigger $trigger
#
# Remove it later with:  Unregister-ScheduledTask -TaskName "CatalyzedTerminalWire" -Confirm:$false
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less scripts
# in the system codepage, so a stray non-ASCII char (em-dash, arrow) corrupts
# string parsing and the task fails with exit 1 and no log output.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $here ".writer.env"
$logFile = Join-Path $here "wire_writer.log"

# Load KEY=VALUE secrets into the process environment (never echoed/committed).
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
  Write-Warning "No .writer.env found at $envFile -- copy .writer.env.example and fill it in."
}

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $logFile -Value "`n[$stamp] wire_writer --once"

# Resolve python explicitly: a Scheduled Task runs with a minimal PATH that may
# not include the user's python. Fall back to bare "python" if lookup fails.
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = "python" }

# Run one pass; capture stdout+stderr to the log. The writer logs progress to
# stderr, so drop to Continue here -- under "Stop", PowerShell 5.1 promotes a
# native command's stderr writes to a terminating error and we'd exit 1 even on
# a successful upsert. The python exit code is the real success signal.
$ErrorActionPreference = "Continue"
& $py (Join-Path $here "wire_writer.py") --once *>> $logFile
$code = $LASTEXITCODE
Add-Content -Path $logFile -Value "[$stamp] exit $code"
exit $code
