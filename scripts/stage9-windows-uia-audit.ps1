param(
  [Parameter(Mandatory=$true)][int] $ProcessId,
  [Parameter(Mandatory=$true)][string] $OutDir
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$report = [ordered]@{
  engine = "Windows UIAutomation / actual native Tauri EXE"
  started = (Get-Date).ToString("o")
  processId = $ProcessId
  passes = @()
  failures = @()
  status = "STARTED"
}
$reportPath = Join-Path $OutDir "native-uia-audit.json"
function Store {
  $report | ConvertTo-Json -Depth 10 | Set-Content -Path $reportPath -Encoding utf8
}
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BandoAuditNative {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint data, UIntPtr extraInfo);
}
'@
  $proc=Get-Process -Id $ProcessId -ErrorAction Stop
  if ($proc.MainWindowHandle -eq [IntPtr]::Zero) { throw "Native window has no handle" }
  # Audit the usable desktop work area, not an oversized restored window
  # that the taskbar can cover on a 1024x768 hosted test monitor.
  [BandoAuditNative]::ShowWindow($proc.MainWindowHandle, 3) | Out-Null
  [BandoAuditNative]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 550

  $root=[System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  if ($null -eq $root) { throw "Unable to attach UIAutomation to WebView2 window" }
  $windowRect=$root.Current.BoundingRectangle
  $workArea=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $report.windowMode="MAXIMIZED"
  $report.windowBounds=@{x=$windowRect.X;y=$windowRect.Y;w=$windowRect.Width;h=$windowRect.Height}
  $report.workArea=@{x=$workArea.X;y=$workArea.Y;w=$workArea.Width;h=$workArea.Height}
  Write-Host "STAGE9_WINDOW_GEOMETRY $($report.windowBounds | ConvertTo-Json -Compress) workArea=$($report.workArea | ConvertTo-Json -Compress)"
  $treeScope=[System.Windows.Automation.TreeScope]::Descendants
  $condition=[System.Windows.Automation.Condition]::TrueCondition
  function Elements {
    $result=@()
    $nodes=$root.FindAll($treeScope,$condition)
    for($i=0;$i -lt $nodes.Count;$i++){
      $el=$nodes.Item($i)
      try {
        $name=$el.Current.Name
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        $r=$el.Current.BoundingRectangle
        $result+= [PSCustomObject]@{
          el=$el
          name=$name
          control=$el.Current.ControlType.ProgrammaticName
          offscreen=$el.Current.IsOffscreen
          x=[int]$r.X
          y=[int]$r.Y
          w=[int]$r.Width
          h=[int]$r.Height
        }
      } catch { }
    }
    return ,$result
  }
  $first=Elements
  $report.accessibilityNodeCount=$first.Count
  $report.initialNames=@($first | Select-Object -First 100 name,control,x,y,w,h)
  Write-Host "STAGE9_UIA_DISCOVERY count=$($first.Count)"
  Write-Host "STAGE9_UIA_TOP_NAMES $((@($first | Select-Object -First 30 name,control)|ConvertTo-Json -Compress -Depth 3))"

  function ClickUI([string]$label){
    $nodes=Elements
    $target=$nodes | Where-Object {
      $_.name -eq $label -and $_.control -match "Button|TabItem" -and !$_.offscreen -and $_.w -gt 0
    } | Select-Object -First 1
    if ($null -eq $target) {
      # A long product-name table intentionally scrolls horizontally. Focus
      # the offscreen row action so native WebView2 can reveal it without
      # shrinking the product-name column or synthesizing DOM interactions.
      $hidden=$nodes | Where-Object {
        $_.name -eq $label -and $_.control -match "Button|TabItem" -and $_.w -gt 0
      } | Select-Object -First 1
      if ($null -ne $hidden) {
        try { $hidden.el.SetFocus(); Start-Sleep -Milliseconds 350 } catch { }
        $nodes=Elements
        $target=$nodes | Where-Object {
          $_.name -eq $label -and $_.control -match "Button|TabItem" -and !$_.offscreen -and $_.w -gt 0
        } | Select-Object -First 1
      }
    }
    if ($null -eq $target) { throw "No visible native UIAutomation button: $label" }
    $success=$false
    try {
      $invoke=$target.el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      if($null -ne $invoke){
        $invoke.Invoke()
        $success=$true
      }
    } catch { }
    if (-not $success) {
      try {
        $selection=$target.el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($null -ne $selection) { $selection.Select(); $success=$true }
      } catch { }
    }
    if (-not $success){
      $cx=[int]($target.x+$target.w/2)
      $cy=[int]($target.y+$target.h/2)
      [BandoAuditNative]::SetForegroundWindow($proc.MainWindowHandle)|Out-Null
      [BandoAuditNative]::SetCursorPos($cx,$cy)|Out-Null
      [BandoAuditNative]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
      Start-Sleep -Milliseconds 80
      [BandoAuditNative]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
    }
    Start-Sleep -Milliseconds 420
  }
  $counter=0
  function Capture([string]$kind,[string]$label) {
    $nodes=Elements
    $global:counter++
    $safe=($label -replace '[^\p{L}\p{N}-]','-')
    if($safe.Length -gt 70){$safe=$safe.Substring(0,70)}
    $file=("{0:d2}-{1}-{2}.png" -f $global:counter,$kind,$safe)
    $bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap=[System.Drawing.Bitmap]::new($bounds.Width,$bounds.Height)
    $gfx=[System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $gfx.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)
      $bitmap.Save((Join-Path $OutDir $file),[System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $gfx.Dispose(); $bitmap.Dispose()
    }
    $head=@($nodes | Where-Object {$_.control -match "Header|Text"} |
      Select-Object -First 24 name,control,x,y,w,h)
    $buttons=@($nodes | Where-Object {$_.control -match "Button"} |
      Select-Object -First 70 name,control,x,y,w,h,offscreen)
    $report.passes+=@{kind=$kind;label=$label;file=$file;
      nodes=$nodes.Count;screen="$($bounds.Width)x$($bounds.Height)";
      headings=$head;buttons=$buttons}
    Store
    Write-Host "STAGE9_UIA_CAPTURE $kind | $label | $file | elements=$($nodes.Count)"
  }
  Capture "initial" "접수-초기"
  $menus=@("접수","주문 내역","엑셀 관리","일일 결산",
    "상품 관리","운임 관리","거래처 관리","설정")
  $children=@{
    "엑셀 관리"=@("공장 엑셀 대기","매장 발송 대기","엑셀 작성 이력")
    "상품 관리"=@("상품 목록","카테고리 관리","모델군 관리","별칭 관리","브랜드 관리")
    "운임 관리"=@("상품별 기본 운임","동급 배송 그룹 지정","동급 그룹 운임표","조합 / 기준 이력")
    "거래처 관리"=@("거래처 목록","자동 메시지 편집")
    "설정"=@("기본 설정","파일 관리","데이터 관리","시스템","개발자 모드")
  }
  foreach($menu in $menus){
    ClickUI $menu
    Capture "menu" $menu
    if($children.ContainsKey($menu)){
      foreach($label in $children[$menu]){
        ClickUI $label
        Capture "subtab" "$menu-$label"
        if ($menu -eq "거래처 관리" -and $label -eq "자동 메시지 편집") {
          foreach ($nested in @("상황별 공통 안내","잠정 상품 선택 안내")) {
            ClickUI $nested
            Capture "nested" "$menu-$label-$nested"
          }
        }
      }
    }
  }
  # Test only opening/closing real edit dialogs. Never press Save or confirm
  # an action: this runner has a fresh isolated DB, but must remain read-only.
  $popups=@(
    @{ menu="상품 관리"; tab="상품 목록"; buttons=@("상세 관리"); label="상품 상세 관리" },
    @{ menu="상품 관리"; tab="상품 목록"; buttons=@("상품 추가","직접 등록"); label="상품 신규 등록" },
    @{ menu="거래처 관리"; tab="거래처 목록"; buttons=@("＋ 거래처 등록"); label="거래처 신규 등록" },
    @{ menu="운임 관리"; tab="상품별 기본 운임"; buttons=@("기본 운임 설정"); label="상품별 기본 운임 설정" }
  )
  foreach($popup in $popups){
    ClickUI $popup.menu
    ClickUI $popup.tab
    foreach($trigger in $popup.buttons){ ClickUI $trigger }
    Capture "popup" $popup.label
    try { ClickUI "닫기 ×" }
    catch {
      [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
      Start-Sleep -Milliseconds 300
    }
  }
  $report.status="NATIVE_UIA_CAPTURED"
  Store
  Write-Host "STAGE9_UIA_SUMMARY pages=$($report.passes.Count),menus=$($menus.Count),popups=$(@($report.passes | Where-Object {$_.kind -eq 'popup'}).Count)"
} catch {
  $report.status="FAILED"
  $report.failures+= $_.Exception.Message
  Store
  Write-Error "STAGE9_UIA_FAILURE $($_.Exception.Message)"
  exit 1
}
