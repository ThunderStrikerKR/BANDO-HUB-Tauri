$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Windows.Forms
    $picker = New-Object System.Windows.Forms.FolderBrowserDialog
    $picker.Description = 'Select the BANDO HUB Tauri source folder containing BUILD_WINDOWS_TAURI.cmd'
    $picker.ShowNewFolderButton = $false
    $picker.SelectedPath = [Environment]::GetFolderPath('Desktop')
    if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw 'No source folder selected.' }
    $base = $picker.SelectedPath
    $target = Join-Path $base 'src\product-price-xlsx.ts'
    $build = Join-Path $base 'BUILD_WINDOWS_TAURI.cmd'
    if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or -not (Test-Path -LiteralPath $build -PathType Leaf)) {
        throw 'Wrong folder. Select the project root containing src and BUILD_WINDOWS_TAURI.cmd.'
    }
    $source = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)
    $old = 'await wb.xlsx.load((await file.arrayBuffer()) as unknown as Buffer);'
    $new = 'await wb.xlsx.load(new Uint8Array(await file.arrayBuffer()) as unknown as Parameters<typeof wb.xlsx.load>[0]);'
    if ($source.Contains($new)) {
        Write-Host 'ALREADY PATCHED: TS2345 fix is present.' -ForegroundColor Green
        exit 0
    }
    $count = [regex]::Matches($source, [regex]::Escape($old)).Count
    if ($count -ne 1) {
        throw "SOURCE MISMATCH: expected one old line, found $count. No changes made."
    }
    $backupDir = Join-Path $env:LOCALAPPDATA 'BANDO-HUB\patch-backups'
    [System.IO.Directory]::CreateDirectory($backupDir) | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $backup = Join-Path $backupDir "product-price-xlsx.ts-$stamp.bak"
    [System.IO.File]::Copy($target, $backup, $false)
    $updated = $source.Replace($old, $new)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($target, $updated, $enc)
    $verify = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)
    if ($verify -ne $updated -or -not $verify.Contains($new)) { throw 'Verification failed.' }
    Write-Host 'SUCCESS: TS2345 fixed. Only one line changed.' -ForegroundColor Green
    Write-Host 'Target:' $target
    Write-Host 'Backup:' $backup
    exit 0
} catch {
    Write-Host ('PATCH ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
