param(
  [ValidateSet("all", "employer", "seeker")]
  [string]$Role = "all",
  [switch]$AccountsOnly
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sqlitePath = Join-Path $root "server-data\\db.sqlite"
$legacyJsonPath = Join-Path $root "server-data\\db.json"
$nodeReset = Join-Path $root "tools\\reset-db.js"

if (Test-Path $nodeReset) {
  # Preferred path: reset the SQLite DB (and make backups) via Node.
  if ($AccountsOnly) {
    node $nodeReset --role $Role --accounts-only
  } else {
    node $nodeReset --role $Role
  }
} elseif (Test-Path $sqlitePath) {
  throw "Reset script missing: $nodeReset"
} elseif (Test-Path $legacyJsonPath) {
  throw "This project now uses SQLite. Found legacy JSON DB: $legacyJsonPath. Missing reset script: $nodeReset"
} else {
  throw "No DB found. Start the server once to create: $sqlitePath"
}

Write-Host ""
Write-Host ""
Write-Host "To also clear browser login/demo data:"
Write-Host " - Open DevTools Console and run: smartHuntFactoryReset()"
