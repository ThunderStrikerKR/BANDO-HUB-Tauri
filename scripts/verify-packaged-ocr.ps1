param(
    [Parameter(Mandatory = $true)]
    [string]$OcrRoot
)
# Use only the bundled runtime to execute a real image through the production
# recognize.py entrypoint with the exact arguments Tauri passes at runtime.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $OcrRoot))
$python = Join-Path $root "runtime\python.exe"
$runner = Join-Path $PSScriptRoot "..\src-tauri\resources\ocr\recognize.py"
$verifier = Join-Path $PSScriptRoot "verify-portable-ocr.py"
if (!(Test-Path -LiteralPath $python)) { throw "Bundled Python missing: $python" }
if (!(Test-Path -LiteralPath $runner)) { throw "OCR entrypoint missing: $runner" }
if (!(Test-Path -LiteralPath $verifier)) { throw "OCR verifier missing: $verifier" }
Write-Host "[OCR] Verifying the packaged OCR against a real sample BMP..."
& $python "-I" "-B" "-X" "utf8" $verifier $root $runner
if ($LASTEXITCODE -ne 0) { throw "Packaged OCR runtime verification failed (code=$LASTEXITCODE)" }
