param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [Parameter(Mandatory=$true)][string]$OutDir
)
$ErrorActionPreference="Stop"
New-Item -Path $OutDir -ItemType Directory -Force | Out-Null
$result=[ordered]@{
  engine="Real Windows UIAutomation targeting Tauri EXE"
  status="STARTED"; processId=$ProcessId
  checks=@(); captures=@(); initialNodes=0; finalNodes=0
  failure=$null
}
$report=Join-Path $OutDir "native-reception-uia.json"
function Save { $result | ConvertTo-Json -Depth 12 | Set-Content $report -Encoding utf8 }
Save
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BandoNativeTestInput {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,int x,int y,uint data,UIntPtr extra);
}
'@
  $proc=Get-Process -Id $ProcessId -ErrorAction Stop
  if($proc.MainWindowHandle -eq [IntPtr]::Zero){throw "Native window has no handle"}
  [BandoNativeTestInput]::ShowWindow($proc.MainWindowHandle,3)|Out-Null
  [BandoNativeTestInput]::SetForegroundWindow($proc.MainWindowHandle)|Out-Null
  Start-Sleep -Milliseconds 700
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  if($null -eq $root){throw "Unable to attach Windows UIAutomation"}
  $scope=[System.Windows.Automation.TreeScope]::Descendants
  $filter=[System.Windows.Automation.Condition]::TrueCondition
  function Nodes {
    $rows=@()
    $all=$root.FindAll($scope,$filter)
    for($i=0;$i -lt $all.Count;$i++){
      $node=$all.Item($i)
      try {
        $label=$node.Current.Name
        $rect=$node.Current.BoundingRectangle
        if([string]::IsNullOrWhiteSpace($label)){continue}
        $rows+= [PSCustomObject]@{
          name=$label; type=$node.Current.ControlType.ProgrammaticName
          hidden=$node.Current.IsOffscreen
          x=[int]$rect.X;y=[int]$rect.Y;w=[int]$rect.Width;h=[int]$rect.Height
          node=$node
        }
      }catch{}
    }
    return ,$rows
  }
  function Capture([string]$name){
    $nodes=Nodes
    $bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $image=[System.Drawing.Bitmap]::new($bounds.Width,$bounds.Height)
    $graphics=[System.Drawing.Graphics]::FromImage($image)
    try {
      $graphics.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)
      $image.Save((Join-Path $OutDir "$name.png"),[System.Drawing.Imaging.ImageFormat]::Png)
    }finally{$graphics.Dispose();$image.Dispose()}
    $result.captures+=@{
      name=$name;file="$name.png";size="$($bounds.Width)x$($bounds.Height)"
      count=$nodes.Count;names=@($nodes|Select-Object -First 100 name,type,x,y,w,h)
    }
    Save
  }
  function Verify([string]$check,[bool]$condition,[string]$detail){
    $result.checks+=@{check=$check;passed=$condition;detail=$detail}
    Save
    if(-not $condition){throw "$check : $detail"}
  }
  function Press([string]$name){
    $matches=@(Nodes|Where-Object {
      $_.name -eq $name -and $_.type -match "Button|TabItem" -and
      !$_.hidden -and $_.w -gt 0 -and $_.h -gt 0
    })
    if($matches.Count -eq 0){throw "Native button was not found: $name"}
    $target=$matches[0]
    $done=$false
    try {
      $invoke=$target.node.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      if($null -ne $invoke){$invoke.Invoke();$done=$true}
    }catch{}
    if(-not $done){
      $x=[int]($target.x+$target.w/2);$y=[int]($target.y+$target.h/2)
      [BandoNativeTestInput]::SetForegroundWindow($proc.MainWindowHandle)|Out-Null
      [BandoNativeTestInput]::SetCursorPos($x,$y)|Out-Null
      [BandoNativeTestInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
      Start-Sleep -Milliseconds 85
      [BandoNativeTestInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
    }
    Start-Sleep -Milliseconds 420
  }
  $before=Nodes
  $result.initialNodes=$before.Count
  Capture "01-test-reception-initial"
  Verify "Native reception command visible" (@($before|Where-Object {
    $_.name -eq "대리발송" -and $_.type -match "Button"
  }).Count -gt 0) "Missing 대리발송 button"
  Verify "Native startup passed" (-not (@($before|Where-Object {
    $_.name -match "시작하지 못했습니다|기존 업무 DB를 읽을 수 없습니다"
  }).Count -gt 0)) "Native startup recovery screen is still shown"
  $raw=@'
김가상
010-1234-5678
경기도 의정부시 시민로 100
709 2개
박가상
010-2345-6789
서울특별시 마포구 월드컵로 20
GT-1 1개
'@
  [System.Windows.Forms.Clipboard]::SetText($raw)
  Press "대리발송"
  Start-Sleep -Seconds 5
  $after=Nodes
  $result.finalNodes=$after.Count
  Capture "02-test-reception-pasted-two-shipments"
  $labels=@($after|Where-Object {
    $_.name -match "김가상|박가상|709|GT-1"
  }|Select-Object -First 90 name,type)
  $bothNames=(@($labels|Where-Object {$_.name -match "김가상"}).Count -gt 0) -and
             (@($labels|Where-Object {$_.name -match "박가상"}).Count -gt 0)
  Verify "Two recipients visible" $bothNames "Both customer names must appear in the real UI"
  $bothModels=(@($labels|Where-Object {$_.name -match "709"}).Count -gt 0) -and
              (@($labels|Where-Object {$_.name -match "GT-1"}).Count -gt 0)
  Verify "Product tokens visible" $bothModels "Both product tokens must appear in the real UI"
  $stillRunning=($null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
  Verify "Native EXE survived reception" $stillRunning "Tauri process exited"
  $result.status="NATIVE_RECEPTION_UIA_PASSED"
  Save
  Write-Host "NATIVE_RECEPTION_UIA_PASS checks=$($result.checks.Count) nodes=$($after.Count)"
}catch{
  $result.status="FAILED"
  $result.failure=$_.Exception.Message
  Save
  Write-Error "NATIVE_RECEPTION_UIA_FAILURE $($result.failure)"
  exit 1
}
