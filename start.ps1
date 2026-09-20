$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Node.js 18 or newer is required." -ForegroundColor Red
    Write-Host "Download it from https://nodejs.org/"
    Read-Host "Press Enter to exit"
    exit 1
}

$version = (& node -p "process.versions.node").Trim()
$major = [int]($version.Split(".")[0])
if ($major -lt 18) {
    Write-Host "Node.js 18 or newer is required. Current version: $version" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Push-Location $PSScriptRoot
try {
    & node ".\server.js" --open
} finally {
    Pop-Location
}
