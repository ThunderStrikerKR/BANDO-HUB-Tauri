param(
  [Parameter(Mandatory=$true)][string]$Exe,
  [Parameter(Mandatory=$true)][string]$OutDir
)
$ErrorActionPreference = "Stop"
if ($env:GITHUB_ACTIONS -ne "true") { throw "Run only on a disposable Windows CI worker." }
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$report = [ordered]@{
  kind = "Windows native Tauri client-registration UIA + SQLite test"
  sourceSha = $env:BANDO_BINARY_COMMIT
  testWorkspace = $true
  started = (Get-Date).ToUniversalTime().ToString("o")
  status = "STARTED"
  checks = @()
  evidence = @()
  failures = @()
}
$reportPath = Join-Path $OutDir "client-registration-native-uia.json"
function SaveReport {
  $report | ConvertTo-Json -Depth 12 | Set-Content $reportPath -Encoding utf8
}
function Check([string]$name,[bool]$passed,[string]$detail="") {
  $report.checks += @{ name=$name; passed=$passed; detail=$detail }
  SaveReport
  if (-not $passed) { throw "CHECK FAILED: $name :: $detail" }
  Write-Host "CLIENT_UIA_PASS: $name"
}
function Capture([string]$name) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = [System.Drawing.Bitmap]::new($bounds.Width,$bounds.Height)
  $graphic = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphic.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)
    $bitmap.Save((Join-Path $OutDir "$name.png"),[System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphic.Dispose();$bitmap.Dispose() }
  $report.evidence += "$name.png"
  SaveReport
}
function Nodes {
  $rows = @()
  $all = $script:root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  for ($i=0; $i -lt $all.Count; $i++) {
    $node = $all.Item($i)
    try {
      $name = $node.Current.Name
      if ([string]::IsNullOrWhiteSpace($name)) { continue }
      $box = $node.Current.BoundingRectangle
      $rows += [PSCustomObject]@{
        el=$node;name=$name
        type=$node.Current.ControlType.ProgrammaticName
        hidden=$node.Current.IsOffscreen
        x=[int]$box.X;y=[int]$box.Y;w=[int]$box.Width;h=[int]$box.Height
      }
    } catch {}
  }
  return ,$rows
}
function FindNode([string]$label,[string]$kind) {
  return @(Nodes | Where-Object {
    $_.name -eq $label -and $_.type -match $kind -and
    -not $_.hidden -and $_.w -gt 0 -and $_.h -gt 0
  } | Select-Object -First 1) | Select-Object -First 1
}
function Click([string]$label) {
  $target = FindNode $label "Button|TabItem"
  if ($null -eq $target) { throw "Button not accessible: $label" }
  $clicked = $false
  try {
    $pattern = $target.el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($null -ne $pattern) { $pattern.Invoke(); $clicked=$true }
  } catch {}
  if (-not $clicked) {
    [BandoClientInput]::SetForegroundWindow($script:proc.MainWindowHandle) | Out-Null
    [BandoClientInput]::SetCursorPos(
      [int]($target.x + $target.w/2),[int]($target.y + $target.h/2)) | Out-Null
    [BandoClientInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 90
    [BandoClientInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  }
  Start-Sleep -Milliseconds 460
}
function ReadInput([string]$label) {
  $entry = FindNode $label "Edit"
  if ($null -eq $entry) { throw "Accessible edit control not found: $label" }
  $pattern = $entry.el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  if ($null -eq $pattern) { throw "UIA ValuePattern missing: $label" }
  return [string]$pattern.Current.Value
}
function FillNative([string]$label,[string]$value) {
  $entry = FindNode $label "Edit"
  if ($null -eq $entry) { throw "Real WebView2 edit control not found: $label" }
  [BandoClientInput]::SetForegroundWindow($script:proc.MainWindowHandle) | Out-Null
  $entry.el.SetFocus()
  Start-Sleep -Milliseconds 160
  # DO NOT use UIA ValuePattern.SetValue: it can change a WebView2 DOM
  # property without emitting a React onChange/input event.
  [System.Windows.Forms.Clipboard]::SetText($value)
  [System.Windows.Forms.SendKeys]::SendWait("^a")
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Start-Sleep -Milliseconds 350
  $current = ReadInput $label
  Check "Native paste displayed in $label" ($current -eq $value) "expected=$value actual=$current"
  [System.Windows.Forms.SendKeys]::SendWait("{TAB}")
  Start-Sleep -Milliseconds 350
  $afterBlur = ReadInput $label
  Check "React-controlled $label retained value after blur" ($afterBlur -eq $value) "expected=$value actual=$afterBlur"
}
function WaitFor([scriptblock]$predicate,[int]$seconds,[string]$label) {
  $end = (Get-Date).AddSeconds($seconds)
  do {
    if (& $predicate) { return }
    Start-Sleep -Milliseconds 400
  } while ((Get-Date) -lt $end)
  throw "Timed out: $label"
}
function StartNative([string[]]$args) {
  $script:proc = Start-Process -FilePath $Exe -ArgumentList $args -WorkingDirectory (Split-Path $Exe) -PassThru
  WaitFor { $script:proc.Refresh(); $script:proc.MainWindowHandle -ne [IntPtr]::Zero } 45 "Tauri window"
  [BandoClientInput]::ShowWindow($script:proc.MainWindowHandle,3) | Out-Null
  [BandoClientInput]::SetForegroundWindow($script:proc.MainWindowHandle) | Out-Null
  $script:root = [System.Windows.Automation.AutomationElement]::FromHandle($script:proc.MainWindowHandle)
  WaitFor {
    @(Nodes | Where-Object {$_.name -eq "거래처 관리" -and $_.type -match "Button"}).Count -gt 0
  } 65 "React top navigation"
}
function StopNative {
  if ($null -ne $script:proc) {
    try { Stop-Process -Id $script:proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    try { Wait-Process -Id $script:proc.Id -Timeout 12 -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Milliseconds 800
  }
}
$script:proc = $null
$script:root = $null
SaveReport
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BandoClientInput {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int mode);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint action,int x,int y,uint data,UIntPtr extra);
}
'@
  $baseline = Join-Path $env:APPDATA "com.bandostand.bandohub.tauri/bando-hub-v001.sqlite"
  if (Test-Path $baseline) { throw "Refusing to run with a pre-existing app database: $baseline" }
  StartNative @("--bando-developer-bootstrap-placeholder")
  WaitFor { Test-Path $baseline } 55 "disposable baseline SQLite"
  StopNative
  StartNative @("--bando-developer-test")
  Check "Developer TEST database mode" (@(Nodes | Where-Object {
    $_.name -match "BANDO HUB.*테스트" }).Count -gt 0) "BANDO HUB header must show TEST mode"
  Click "거래처 관리"
  WaitFor { $null -ne (FindNode "＋ 거래처 등록" "Button") } 30 "client management loaded"
  Capture "01-clients-list"
  Click "＋ 거래처 등록"
  WaitFor { $null -ne (FindNode "거래처명" "Edit") } 25 "client registration modal fields"
  Capture "02-client-modal"
  $name = "UIA 검증 거래처 " + [Guid]::NewGuid().ToString("N").Substring(0,8)
  $address = "경기도 의정부시 시민로 100"
  $phone = "02-742-9929"
  FillNative "거래처명" $name
  FillNative "거래처 주소" $address
  # Check the genuine validation barrier before completing the required phone.
  Click "거래처 등록"
  Start-Sleep -Milliseconds 1100
  Check "Incomplete client did not close dialog" ($null -ne (FindNode "거래처명" "Edit")) "Required phone must block saving"
  FillNative "전화번호" $phone
  Capture "03-form-filled"
  Click "거래처 등록"
  WaitFor { $null -eq (FindNode "거래처명" "Edit") } 30 "native Rust upsert and SQLite save"
  WaitFor { @(Nodes | Where-Object { $_.name -eq $name }).Count -gt 0 } 20 "client appears in list"
  Capture "04-client-saved"
  Check "Client visible after native Rust save" $true $name
  StopNative
  StartNative @("--bando-developer-test")
  Click "거래처 관리"
  WaitFor { @(Nodes | Where-Object { $_.name -eq $name }).Count -gt 0 } 30 "saved client survived app restart"
  Check "Client persisted in TEST SQLite after restart" $true $name
  Capture "05-client-reloaded"
  $report.status = "PASSED_NATIVE_INPUT_RUST_SAVE_SQLITE_REOPEN"
  SaveReport
} catch {
  $report.status = "FAILED"
  $report.failures += $_.Exception.ToString()
  SaveReport
  try { Capture "failure" } catch {}
  Write-Error "CLIENT_NATIVE_UIA_FAILED $($_.Exception.Message)"
  exit 1
} finally { StopNative }
