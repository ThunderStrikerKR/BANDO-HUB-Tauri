param(
    [Parameter(Mandatory = $true)][int] $ProcessId,
    [Parameter(Mandatory = $true)][string] $OutDir
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$process = Get-Process -Id $ProcessId -ErrorAction Stop
$children = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
    Select-Object -First 12 ProcessId, ParentProcessId, Name, CommandLine)
$session = [PSCustomObject]@{
    processId = $ProcessId
    mainWindowHandle = [int64] $process.MainWindowHandle
    mainWindowTitle = $process.MainWindowTitle
    appSessionId = $process.SessionId
    userInteractive = [Environment]::UserInteractive
    webviewProcessCount = $children.Count
    webviewProcesses = $children
    portProcesses = @((Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq 19649 } |
        Select-Object LocalAddress, LocalPort, OwningProcess))
}
if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
    try {
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Stage9Window {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
        [Stage9Window]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
        [Stage9Window]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
        Start-Sleep -Milliseconds 450
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bitmap = [System.Drawing.Bitmap]::new($screen.Width, $screen.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen(
                $screen.Location,
                [System.Drawing.Point]::Empty,
                $screen.Size,
                [System.Drawing.CopyPixelOperation]::SourceCopy
            )
            $file = Join-Path $OutDir "native-desktop-probe.png"
            $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
            $session | Add-Member NoteProperty desktopScreenshot "native-desktop-probe.png"
            $session | Add-Member NoteProperty screenshotSize "$($screen.Width)x$($screen.Height)"
            $session | Add-Member NoteProperty screenshotBytes (Get-Item $file).Length
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    } catch {
        $session | Add-Member NoteProperty screenshotError $_.Exception.Message
    }
}
$session | ConvertTo-Json -Compress -Depth 6
