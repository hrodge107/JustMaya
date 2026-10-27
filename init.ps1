# JustMaya - agent harness bootstrap (Windows PowerShell)
# Run: .\init.ps1
# Optional: $env:RUN_START_COMMAND=1; .\init.ps1

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$InstallCmd = "npm install"
$VerifyCmd  = "npm run lint; npm run build"
$StartCmd   = "npm run dev"

Write-Host "==> Working directory: $(Get-Location)"
Write-Host "==> Syncing dependencies"
Write-Host "    $InstallCmd"
Invoke-Expression $InstallCmd
if ($LASTEXITCODE -ne 0) { throw "Install failed with exit code $LASTEXITCODE" }

Write-Host "==> Running baseline verification"
Write-Host "    npm run lint"
Invoke-Expression "npm run lint"
if ($LASTEXITCODE -ne 0) { throw "Lint failed with exit code $LASTEXITCODE" }
Write-Host "    npm run build"
Invoke-Expression "npm run build"
if ($LASTEXITCODE -ne 0) { throw "Verification failed with exit code $LASTEXITCODE - fix baseline before feature work" }

Write-Host "==> Startup command (print only unless RUN_START_COMMAND=1)"
Write-Host "    $StartCmd"

if ($env:RUN_START_COMMAND -eq "1") {
    Write-Host "==> Starting the app"
    Invoke-Expression $StartCmd
}
