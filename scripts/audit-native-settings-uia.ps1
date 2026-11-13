param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [Parameter(Mandatory=$true)][string]$OutDir,
  [Parameter(Mandatory=$true)][string]$Expected,
  [switch]$VerifyOnly
)
$ErrorActionPreference="Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$name=if($VerifyOnly){"reopen"}else{"save"}
$result=[ordered]@{type="real Windows UIAutomation to native Tauri TEST DB";mode=$name;
  status="STARTED";processId=$ProcessId;expected=$Expected;observations=@();failure=$null}
$out=Join-Path $OutDir ("settings-"+$name+".json")
function Store { $result|ConvertTo-Json -Depth 12|Set-Content -Path $out -Encoding utf8 }
Store
try{
  Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Drawing
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BandoNativeSettings {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,int x,int y,uint data,UIntPtr extra);
}
'@
  $proc=Get-Process -Id $ProcessId -ErrorAction Stop
  for($wait=0;$wait -lt 100 -and $proc.MainWindowHandle -eq [IntPtr]::Zero;$wait++){
    Start-Sleep -Milliseconds 300
    $proc.Refresh()
  }
  if($proc.MainWindowHandle -eq [IntPtr]::Zero){throw "Actual Tauri process has no HWND"}
  [BandoNativeSettings]::ShowWindow($proc.MainWindowHandle,3)|Out-Null
  [BandoNativeSettings]::SetForegroundWindow($proc.MainWindowHandle)|Out-Null
  Start-Sleep -Milliseconds 600
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  if($null -eq $root){throw "No WebView2 UIAutomation tree"}
  $scope=[System.Windows.Automation.TreeScope]::Descendants
  $condition=[System.Windows.Automation.Condition]::TrueCondition
  function Elements {
    $records=@()
    $all=$root.FindAll($scope,$condition)
    for($i=0;$i -lt $all.Count;$i++){
      $el=$all.Item($i)
      try{
        $r=$el.Current.BoundingRectangle
        $records+= [PSCustomObject]@{el=$el;name=$el.Current.Name;
          control=$el.Current.ControlType.ProgrammaticName;
          offscreen=$el.Current.IsOffscreen;
          x=[int]$r.X;y=[int]$r.Y;w=[int]$r.Width;h=[int]$r.Height}
      }catch{}
    }
    return ,$records
  }
  function Visible([string]$label,[string]$kind){
    $matches=@(Elements|Where-Object {$_.name -eq $label -and $_.control -match $kind -and !$_.offscreen -and $_.w -gt 0})
    if($matches.Count){return $matches[0]}
    return $null
  }
  function ClickNative([string]$label){
    $target=Visible $label "Button|TabItem"
    if($null -eq $target){throw "No native visible button: $label"}
    $clicked=$false
    try {
      $pattern=$target.el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      if($null -ne $pattern){$pattern.Invoke();$clicked=$true}
    }catch{}
    if(-not $clicked){
      [BandoNativeSettings]::SetForegroundWindow($proc.MainWindowHandle)|Out-Null
      [BandoNativeSettings]::SetCursorPos([int]($target.x+$target.w/2),[int]($target.y+$target.h/2))|Out-Null
      [BandoNativeSettings]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
      Start-Sleep -Milliseconds 80
      [BandoNativeSettings]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
    }
    Start-Sleep -Milliseconds 400
  }
  $ready=$false
  for($attempt=0;$attempt -lt 70;$attempt++){
    $target=Visible "설정" "Button|TabItem"
    if($null -ne $target){$ready=$true;break}
    Start-Sleep -Milliseconds 350
  }
  if(-not $ready){throw "Tauri settings menu never appeared"}
  $result.observations+=@{check="main HWND and settings button";passed=$true}
  ClickNative "설정"
  $editor=$null
  for($attempt=0;$attempt -lt 55;$attempt++){
    $editor=Visible "작업자 이름" "Edit"
    if($null -ne $editor){break}
    Start-Sleep -Milliseconds 250
  }
  if($null -eq $editor){
    $result.visibleControls=@(Elements|Where-Object {$_.control -match "Edit|Button"}|
      Select-Object -First 75 name,control,x,y,w,h)
    throw "Operator name editor is absent from actual settings screen"
  }
  $getText={
    param($record)
    $value=$record.el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $value.Current.Value
  }
  $before=&$getText $editor
  $result.observations+=@{check="actual settings operator input";passed=$true;before=$before}
  if(-not $VerifyOnly){
    if($before -eq $Expected){throw "Unexpectedly pre-existing test marker; refusing false save pass"}
    $editor.el.SetFocus()
    [BandoNativeSettings]::SetForegroundWindow($proc.MainWindowHandle)|Out-Null
    [System.Windows.Forms.Clipboard]::SetText($Expected)
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 600
    $editor=Visible "작업자 이름" "Edit"
    $typed=if($null -ne $editor){&$getText $editor}else{""}
    $result.observations+=@{check="native keyboard edit";passed=($typed -eq $Expected);value=$typed}
    if($typed -ne $Expected){throw "Typed text did not update real React settings input"}
    ClickNative "설정 저장"
    Start-Sleep -Milliseconds 900
    $result.observations+=@{check="clicked native 설정 저장";passed=$true}
  }else{
    if($before -ne $Expected){throw "Reopened native settings editor did not restore saved operator name"}
    $result.observations+=@{check="reopened EXE displays persisted operator";passed=$true}
  }
  $bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap=[System.Drawing.Bitmap]::new($bounds.Width,$bounds.Height)
  $gfx=[System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $gfx.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)
    $file="settings-"+$name+".png"
    $bitmap.Save((Join-Path $OutDir $file),[System.Drawing.Imaging.ImageFormat]::Png)
    $result.screenshot=$file
  }finally{$gfx.Dispose();$bitmap.Dispose()}
  $result.status=if($VerifyOnly){"NATIVE_SETTINGS_REOPEN_VERIFIED"}else{"NATIVE_SETTINGS_GUI_SAVE_CLICKED"}
  Store
  Write-Host ("NATIVE_SETTINGS_UIA_"+$result.status)
}catch{
  $result.status="FAILED"
  $result.failure=$_.Exception.Message
  Store
  Write-Error ("NATIVE_SETTINGS_UIA_FAILURE "+$result.failure)
  exit 1
}
