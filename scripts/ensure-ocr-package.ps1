param(
    [Parameter(Mandatory = $true)]
    [string]$LiveDir,
    [Parameter(Mandatory = $true)]
    [string]$StageDir
)
# Rebuild the bundled offline OCR only when its runtime, models or packaging contract changes.
# The existing published OCR directory is never replaced until the calling CMD promotes the stage.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$live = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $LiveDir))
$stage = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $StageDir))
$stampName = "ocr-build-fingerprint.txt"
$inputs = @(
    "scripts/package-ocr-runtime.ps1",
    "scripts/prepare-ocr-bundle.py",
    "scripts/verify-packaged-ocr.ps1",
    "scripts/verify-portable-ocr.py",
    "src-tauri/resources/ocr/recognize.py"
)
$lines = @("bando-ocr-win-x64-v1")
foreach ($relative in $inputs) {
    $full = Join-Path $repo $relative
    if (!(Test-Path -LiteralPath $full)) { throw "Missing OCR package input: $relative" }
    $lines += "$relative=$((Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash)"
}
$hash = [System.Security.Cryptography.SHA256]::Create()
try {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
    $key = ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
} finally {
    $hash.Dispose()
}
$stamp = Join-Path $live $stampName
$required = @(
    "runtime/python.exe",
    "models/PP-OCRv5_mobile_det/inference.json",
    "models/korean_PP-OCRv5_mobile_rec/inference.json"
)
if (Test-Path -LiteralPath $stamp) {
    $found = (Get-Content -LiteralPath $stamp -Raw).Trim()
    $complete = $found -eq $key
    foreach ($requiredFile in $required) {
        if (!(Test-Path -LiteralPath (Join-Path $live $requiredFile))) { $complete = $false }
    }
    if ($complete) {
        Write-Host "[OCR] Cached verified runtime and models unchanged; skipping all OCR downloads."
        exit 0
    }
}
if (Test-Path -LiteralPath $stage) {
    throw "OCR staging folder already exists: $stage"
}
Write-Host "[OCR] Runtime/models changed or missing. Building a new staged bundle..."
& (Join-Path $PSScriptRoot "package-ocr-runtime.ps1") -TargetDir $StageDir
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "OCR package creation failed." }
& (Join-Path $PSScriptRoot "verify-packaged-ocr.ps1") -OcrRoot $StageDir
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "OCR package verification failed." }
Set-Content -LiteralPath (Join-Path $stage $stampName) -Value $key -Encoding Ascii
Write-Host "[OCR] Bundle verified and fingerprinted; publish staging with EXE when ready."
