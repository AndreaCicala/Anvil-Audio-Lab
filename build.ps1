# build.ps1 — Build the Anvil Audio Lab Windows executable.
#
# Prerequisites (one-time setup):
#   1. Python 3.10+ with requirements installed:
#         pip install -r requirements.txt
#         pip install pyinstaller
#   2. ffmpeg.exe placed at ./ffmpeg/ffmpeg.exe (download from gyan.dev).
#
# Usage:
#   ./build.ps1
#
# Output: ./dist/AnvilAudioLab/ (the folder users unzip and run)
#
# Build behavior:
#   - Uses the anvil_audio_lab.spec configuration (which is version-controlled)
#   - Cleans prior build artifacts so we always produce a fresh folder
#   - Verifies the ffmpeg binary is in place before building (catches the
#     most common missed-setup error)
#   - On success, prints the version and the output path

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "Anvil Audio Lab — Build Script" -ForegroundColor Cyan
Write-Host "==============================" -ForegroundColor Cyan
Write-Host ""

# ------------------------------------------------------------------
# Pre-flight checks
# ------------------------------------------------------------------

# 1. PyInstaller must be installed
$hasPyInstaller = (pip show pyinstaller 2>$null)
if (-not $hasPyInstaller) {
    Write-Host "ERROR: PyInstaller is not installed." -ForegroundColor Red
    Write-Host "       Run: pip install pyinstaller"
    exit 1
}

# 2. ffmpeg.exe should exist at the expected path. If missing, warn but
#    continue — the build will still work, the app just won't ship with
#    a bundled ffmpeg (falls back to PATH at runtime).
$ffmpegPath = Join-Path $PSScriptRoot "ffmpeg\ffmpeg.exe"
if (-not (Test-Path $ffmpegPath)) {
    Write-Host "WARNING: ffmpeg.exe not found at: $ffmpegPath" -ForegroundColor Yellow
    Write-Host "         The build will succeed, but the packaged app will"
    Write-Host "         rely on ffmpeg being in the user's PATH instead of"
    Write-Host "         being self-contained."
    Write-Host "         To bundle it, download ffmpeg from gyan.dev and"
    Write-Host "         place ffmpeg.exe at the path above."
    Write-Host ""
    $continue = Read-Host "Continue anyway? [y/N]"
    if ($continue -ne "y") { exit 1 }
}

# 3. Show version we're building. Parse version.py line by line — simple
#    string matching avoids the PowerShell regex-parsing quirks that broke
#    the earlier Select-String + Matches[0] approach.
$version = "unknown"
foreach ($line in Get-Content "version.py") {
    if ($line -match '^\s*__version__\s*=\s*"([^"]+)"') {
        $version = $matches[1]
        break
    }
}
Write-Host "Building Anvil Audio Lab v$version" -ForegroundColor Green
Write-Host ""

# ------------------------------------------------------------------
# Clean prior artifacts
# ------------------------------------------------------------------

if (Test-Path "build") {
    Write-Host "Cleaning ./build/ ..." -ForegroundColor Gray
    Remove-Item -Recurse -Force "build"
}
if (Test-Path "dist") {
    Write-Host "Cleaning ./dist/ ..." -ForegroundColor Gray
    Remove-Item -Recurse -Force "dist"
}

# ------------------------------------------------------------------
# Build
# ------------------------------------------------------------------

Write-Host ""
Write-Host "Running PyInstaller..." -ForegroundColor Cyan
Write-Host "(First build takes 2-5 minutes. Subsequent builds are faster.)"
Write-Host ""

pyinstaller anvil_audio_lab.spec --clean --noconfirm

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "BUILD FAILED." -ForegroundColor Red
    Write-Host "Check the output above for the first error."
    exit $LASTEXITCODE
}

# ------------------------------------------------------------------
# Post-build summary
# ------------------------------------------------------------------

$outDir = Join-Path $PSScriptRoot "dist\AnvilAudioLab"
if (-not (Test-Path $outDir)) {
    Write-Host "ERROR: Expected output folder not found: $outDir" -ForegroundColor Red
    exit 1
}

$exePath = Join-Path $outDir "AnvilAudioLab.exe"
$size = (Get-ChildItem $outDir -Recurse | Measure-Object -Property Length -Sum).Sum
$sizeMB = [math]::Round($size / 1MB, 1)

Write-Host ""
Write-Host "==============================" -ForegroundColor Green
Write-Host "BUILD COMPLETE" -ForegroundColor Green
Write-Host "==============================" -ForegroundColor Green
Write-Host ""
Write-Host "  Version:     v$version"
Write-Host "  Output dir:  $outDir"
Write-Host "  Executable:  $exePath"
Write-Host "  Total size:  $sizeMB MB"
Write-Host ""
Write-Host "To test: run the executable directly, then open http://localhost:5000"
Write-Host "To ship: zip the entire dist\AnvilAudioLab\ folder and attach to a GitHub release."
Write-Host ""
