# Learning clock - daily after-close capture + FreeTSA artifact timestamping.
#
# 1) Runs the existing universe scan wrapper (produces local learning-archive
#    data records; not screenshots).
# 2) RFC 3161-timestamps each sealed archive digest via FreeTSA.
# 3) Optionally runs attest.mts when LEARNING_ATTEST_BUNDLE is set to a full
#    OfflineLearningBundle path (admission subjects). Daily captures alone are
#    not evaluation bundles; use timestampUniverseArtifacts.mts for those.
#
# Schedule (after US equity close, weekdays), from repo root:
#   $action = New-ScheduledTaskAction -Execute "powershell.exe" `
#     -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PWD\scripts\universe_scan\run_learning_clock.ps1`""
#   $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 4:30PM
#   Register-ScheduledTask -TaskName "CatalyzedLearningClock" -Action $action -Trigger $trigger
#
# ASCII-only (PowerShell 5.1).

param(
  [switch]$Dry,
  [switch]$SkipScan,
  [switch]$SkipTimestamp
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here "..\..")
$logFile = Join-Path $here "learning-clock.log"
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

function Log([string]$msg) {
  Add-Content -Path $logFile -Value "[$stamp] $msg"
  Write-Output $msg
}

Set-Location $repo
$env:Path = "C:\Program Files\Git\usr\bin;C:\Program Files\nodejs;" + $env:Path

$openssl = "C:\Program Files\Git\usr\bin\openssl.exe"
if (-not (Test-Path $openssl)) {
  $opensslCmd = Get-Command openssl -ErrorAction SilentlyContinue
  if ($opensslCmd) { $openssl = $opensslCmd.Source }
}

$freetsaDir = Join-Path $repo "scripts\learning_evaluation\freetsa"
$caFile = Join-Path $freetsaDir "cacert.pem"
$tsaCert = Join-Path $freetsaDir "tsa.crt"
New-Item -ItemType Directory -Force -Path $freetsaDir | Out-Null
if (-not (Test-Path $caFile)) {
  Log "Downloading FreeTSA cacert.pem"
  curl.exe -sSL -o $caFile "https://freetsa.org/files/cacert.pem"
}
if (-not (Test-Path $tsaCert)) {
  Log "Downloading FreeTSA tsa.crt"
  curl.exe -sSL -o $tsaCert "https://freetsa.org/files/tsa.crt"
}

$code = 0
if (-not $SkipScan) {
  $scanArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $here "run_scan.ps1"))
  if ($Dry) { $scanArgs += "-Dry" }
  Log "Running universe scan..."
  & powershell @scanArgs
  $code = $LASTEXITCODE
  Log "scan exit=$code"
  if ($code -ne 0) {
    Log "Scan failed; still attempting timestamp of any existing claims."
  }
}

$archiveRoot = Join-Path $here "learning-archive"
if ($env:LEARNING_ARCHIVE_ROOT -and $env:LEARNING_ARCHIVE_ROOT.Trim()) {
  $archiveRoot = $env:LEARNING_ARCHIVE_ROOT.Trim()
}

if (-not $SkipTimestamp) {
  $claimDir = Join-Path $archiveRoot "_source-runs"
  if (Test-Path $claimDir) {
    Log "Timestamping universe artifact digests via FreeTSA..."
    $tsScript = Join-Path $repo "scripts\learning_evaluation\timestampUniverseArtifacts.mts"
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $tsOut = & npx --yes tsx $tsScript `
      --archive-root $archiveRoot `
      --ca-file $caFile `
      --tsa-cert $tsaCert `
      --openssl $openssl 2>&1 | Out-String
    $tsCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    Add-Content -Path $logFile -Value $tsOut
    Write-Output $tsOut
    Log "timestamp exit=$tsCode"
    if ($tsCode -ne 0 -and $code -eq 0) { $code = $tsCode }
  } else {
    Log "No claim directory at $claimDir - skip timestamp."
  }
}

$bundle = $env:LEARNING_ATTEST_BUNDLE
if ($bundle -and (Test-Path $bundle)) {
  $attestOut = Join-Path $archiveRoot ("_attestations-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")
  Log "Running attest.mts on bundle $bundle"
  $attestScript = Join-Path $repo "scripts\learning_evaluation\attest.mts"
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $aOut = & npx --yes tsx $attestScript `
    $bundle $attestOut `
    --ca-file $caFile `
    --tsa-cert $tsaCert `
    --openssl $openssl 2>&1 | Out-String
  $aCode = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  Add-Content -Path $logFile -Value $aOut
  Write-Output $aOut
  Log "attest exit=$aCode out=$attestOut"
  if ($aCode -ne 0 -and $code -eq 0) { $code = $aCode }
}

Log "learning-clock exit=$code"
exit $code
