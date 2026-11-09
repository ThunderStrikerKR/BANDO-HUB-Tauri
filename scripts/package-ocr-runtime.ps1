param(
    [Parameter(Mandatory = $true)]
    [string]$TargetDir
)
# Runs on the build computer only. Staff computers receive a self-contained folder.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest
if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Portable PaddleOCR requires a Windows x64 build machine."
}
$target = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $TargetDir))
if (Test-Path -LiteralPath $target) {
    throw "Target already exists; refusing to overwrite: $target"
}
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("bando-ocr-package-" + [guid]::NewGuid().ToString("N"))
$stage = Join-Path $temp "ocr"
$runtime = Join-Path $stage "runtime"
$sitePackages = Join-Path $runtime "Lib\site-packages"
$cache = Join-Path $temp "paddlex-cache"

try {
    New-Item -ItemType Directory -Path $runtime, $sitePackages, $cache -Force | Out-Null
    $pythonZip = Join-Path $temp "python-embed.zip"
    Write-Host "[OCR] Downloading official embedded CPython 3.11.9 runtime..."
    Invoke-WebRequest "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip" -OutFile $pythonZip
    Expand-Archive -LiteralPath $pythonZip -DestinationPath $runtime
    $pth = Join-Path $runtime "python311._pth"
    if (!(Test-Path -LiteralPath $pth)) { throw "Embedded Python path configuration missing." }
    @("python311.zip", ".", "Lib\site-packages", "import site") |
        Set-Content -LiteralPath $pth -Encoding Ascii
    $python = Join-Path $runtime "python.exe"
    if (!(Test-Path -LiteralPath $python)) { throw "Embedded python.exe missing." }
    $pipZip = Join-Path $temp "pip.pyz"
    Write-Host "[OCR] Downloading pip zip application..."
    Invoke-WebRequest "https://bootstrap.pypa.io/pip/pip.pyz" -OutFile $pipZip
    $env:PYTHONNOUSERSITE = "1"
    $env:PYTHONDONTWRITEBYTECODE = "1"
    $env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
    $env:PIP_NO_CACHE_DIR = "1"
    Write-Host "[OCR] Installing PaddleOCR only inside this package..."
    $args = @($pipZip,"install","--disable-pip-version-check","--no-cache-dir","--only-binary=:all:","--target",$sitePackages,"paddlepaddle==3.2.0","paddleocr==3.2.0")
    & $python @args
    if ($LASTEXITCODE -ne 0) { throw "Portable PaddleOCR dependency installation failed." }

    $env:PADDLE_PDX_CACHE_HOME = $cache
    $env:PADDLE_PDX_MODEL_SOURCE = "BOS"
    Write-Host "[OCR] Bundling Korean PP-OCRv5 models..."
    & $python (Join-Path $PSScriptRoot "prepare-ocr-bundle.py") (Join-Path $stage "models")
    if ($LASTEXITCODE -ne 0) { throw "Portable PaddleOCR model download/verification failed." }

    $targetParent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    Move-Item -LiteralPath $stage -Destination $target
    if (!(Test-Path -LiteralPath (Join-Path $target "runtime\python.exe"))) {
        throw "Packaged Python binary missing after staging."
    }
    Write-Host "[OCR] Package ready: $target"
} finally {
    Remove-Item -LiteralPath $temp -Force -Recurse -ErrorAction SilentlyContinue
}
