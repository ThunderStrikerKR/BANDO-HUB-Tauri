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
  Write-Host "FINAL_UIA_WINDOW_GEOMETRY $($report.windowBounds | ConvertTo-Json -Compress) workArea=$($report.workArea | ConvertTo-Json -Compress)"
  $treeScope=[System.Windows.Automation.TreeScope]::Descendants
  $condition=[System.Windows.Automation.Condition]::TrueCondition
  function Elements {
    $result=@()
    $nodes=$root.FindAll($treeScope,$condition)
    for($i=0;$i -lt $nodes.Count;$i++){
      $el=$nodes.Item($i)
      try {
        $name=$el.Current.Name
        $ctrl=$el.Current.ControlType.ProgrammaticName
        # WebView2 can expose editable HTML <input> with an empty UIA Name.
        # Retain unnamed native Edit controls for label-relative selection.
        if ([string]::IsNullOrWhiteSpace($name) -and $ctrl -notmatch "Edit|ComboBox") { continue }
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
  Write-Host "FINAL_UIA_UIA_DISCOVERY count=$($first.Count)"
  Write-Host "FINAL_UIA_UIA_TOP_NAMES $((@($first | Select-Object -First 30 name,control)|ConvertTo-Json -Compress -Depth 3))"

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
    Write-Host "FINAL_UIA_UIA_CAPTURE $kind | $label | $file | elements=$($nodes.Count)"
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

  # Verify REAL controls and real SQLite from a separate Python read connection.
  # The native EXE runs with --bando-developer-test and never touches the
  # production business database.
  $sqlite=Join-Path $env:APPDATA "com.bandostand.bandohub.tauri\developer-test\bando-hub-test.sqlite"
  if(!(Test-Path -LiteralPath $sqlite)){throw "Isolated TEST SQLite absent: $sqlite"}
  $report.sqlitePath="developer-test/bando-hub-test.sqlite"
  function Snapshot {
    $script=@'
import sqlite3,json,sys
from pathlib import Path
con=sqlite3.connect(Path(sys.argv[1]).resolve().as_uri()+"?mode=ro",uri=True,timeout=20)
try:
    raw=json.loads(con.execute("SELECT payload FROM app_state WHERE id=1").fetchone()[0])
    n=con.execute("SELECT COUNT(*) FROM core_clients").fetchone()[0]
    match=con.execute("SELECT id,name FROM core_clients WHERE name=?",("CI-TEST-거래처-UIA",)).fetchone()
    print(json.dumps({"revision":raw.get("revision"),"operatorName":raw.get("settings",{}).get("operatorName"),"clientCount":n,"testClientId":match[0] if match else None},ensure_ascii=False))
finally:
    con.close()
'@
    $value=& python -c $script $sqlite
    if($LASTEXITCODE -ne 0){throw "SQLite separate-process read failed"}
    return $value | ConvertFrom-Json
  }
  function FillEdit([string]$label,[string]$value){
    $all=Elements
    # A prior click on the footer Save button can scroll the settings form
    # down. The operator field is still a native UIA Edit, but IsOffscreen=true.
    # SetFocus first so WebView2 scrolls it into the viewport.
    $matches=@($all | Where-Object {
      $_.name -eq $label -and $_.control -match "Edit" -and $_.w -gt 0
    })
    if($matches.Count -gt 0 -and $matches[0].offscreen) {
      try { $matches[0].el.SetFocus(); Start-Sleep -Milliseconds 420 } catch {}
      $all=Elements
      $matches=@($all|Where-Object {
        $_.name -eq $label -and $_.control -match "Edit" -and !$_.offscreen -and $_.w -gt 0
      })
    }
    if($matches.Count -eq 0){
      # The accessibility provider sometimes gives the HTML input no Name.
      # Pair the real visible Edit rectangle to its nearby UIA label.
      $lab=@($all|Where-Object {$_.name -eq $label -and !$_.offscreen})|Select-Object -First 1
      if($null -ne $lab){
        $matches=@($all|Where-Object {
          $_.control -match "Edit" -and !$_.offscreen -and $_.w -gt 75 -and
          $_.y -ge ($lab.y-5) -and $_.y -le ($lab.y+100) -and
          [Math]::Abs($_.x-$lab.x) -lt 180
        }|Sort-Object @{Expression={[Math]::Abs($_.y-$lab.y)+[Math]::Abs($_.x-$lab.x)}})
      }
    }
    $report.editsObserved=@($all|Where-Object {$_.control -match "Edit"}|
      Select-Object -First 55 name,control,offscreen,x,y,w,h)
    Store
    if($matches.Count -gt 0){
      $matches[0].el.SetFocus()
      $method="UIAutomation Edit focus"
    }else{
      # Last fallback uses the *measured* native label rectangle, not a
      # hard-coded pixel location or a synthetic DOM interaction.
      $lab=@($all|Where-Object {$_.name -eq $label -and !$_.offscreen})|Select-Object -First 1
      if($null -eq $lab){throw "Native editable field or its label not found: $label"}
      $cx=[int]($lab.x+[Math]::Min(100,[Math]::Max(40,$lab.w/2)))
      $cy=[int]($lab.y+$lab.h+22)
      [BandoAuditNative]::SetForegroundWindow($proc.MainWindowHandle)|Out-Null
      [BandoAuditNative]::SetCursorPos($cx,$cy)|Out-Null
      [BandoAuditNative]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
      Start-Sleep -Milliseconds 75
      [BandoAuditNative]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
      $method="Measured native label-relative mouse"
    }
    [System.Windows.Forms.Clipboard]::SetText($value)
    Start-Sleep -Milliseconds 110
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 600
    $report.inputActions+=@{field=$label;method=$method}
    Store
  }
  $report.inputActions=@()
  $report.sqliteChecks=@()
  ClickUI "설정"
  ClickUI "기본 설정"
  $before=Snapshot
  ClickUI "설정 저장"
  Start-Sleep -Milliseconds 350
  $afterNoChange=Snapshot
  if($afterNoChange.revision -ne $before.revision){
    throw "No-edit settings Save incorrectly changed SQLite revision ($($before.revision) to $($afterNoChange.revision))"
  }
  $report.sqliteChecks+=@{check="unchanged_settings_no_write";status="PASS";revision=$before.revision}
  FillEdit "작업자 이름" "CI-Windows-UIA-검수"
  Capture "edit" "설정-작업자명-변경"
  ClickUI "설정 저장"
  Start-Sleep -Seconds 1
  $afterSettings=Snapshot
  if($afterSettings.operatorName -ne "CI-Windows-UIA-검수"){
    throw "Edited operator name not persisted in SQLite: $($afterSettings.operatorName)"
  }
  if($afterSettings.revision -le $before.revision){throw "Settings UI Save did not advance revision"}
  $report.sqliteChecks+=@{check="settings_ui_persisted";status="PASS";revision=$afterSettings.revision}
  Capture "saved" "설정-저장완료"
  # Reopen the exact settings screen through native UI, then inspect its
  # UIAutomation ValuePattern rather than trusting a fake React state.
  ClickUI "상품 관리"
  ClickUI "설정"
  ClickUI "기본 설정"
  $operator=@(Elements | Where-Object {$_.name -eq "작업자 이름" -and $_.control -match "Edit"}) | Select-Object -First 1
  if($null -eq $operator){throw "Saved operator field missing after page re-entry"}
  $pattern=$operator.el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  if($pattern.Current.Value -ne "CI-Windows-UIA-검수"){
    throw "Saved settings value not restored after leaving and reentering screen"
  }
  $report.sqliteChecks+=@{check="settings_ui_reopen";status="PASS";value=$pattern.Current.Value}
  Capture "reopened" "설정-재진입-값유지"
  ClickUI "거래처 관리"
  ClickUI "거래처 목록"
  ClickUI "＋ 거래처 등록"
  Capture "popup" "거래처-신규등록"
  FillEdit "거래처명" "CI-TEST-거래처-UIA"
  FillEdit "거래처 주소" "서울특별시 가상구 테스트로 123"
  FillEdit "전화번호" "02-1234-5678"
  Capture "edit" "거래처-필수정보-작성"
  ClickUI "거래처 등록"
  Start-Sleep -Seconds 1
  $afterClient=Snapshot
  if(-not $afterClient.testClientId){throw "Client registration UI did not persist a core_clients row"}
  if($afterClient.revision -le $afterSettings.revision){throw "Client UI save did not advance SQLite revision"}
  $report.sqliteChecks+=@{check="client_ui_persisted";status="PASS";revision=$afterClient.revision;id=$afterClient.testClientId}
  Capture "saved" "거래처-등록-완료"
  # UI relaunch is intentionally not simulated with a mock. SQLite was
  # reopened independently by Python after the native UI saved its rows.
  # Cover real editor opening without changing product prices or freight.
  ClickUI "상품 관리"
  ClickUI "상품 목록"
  ClickUI "상세 관리"
  Capture "popup" "상품-상세관리"
  ClickUI "닫기 ×"
  ClickUI "운임 관리"
  ClickUI "상품별 기본 운임"
  Capture "native" "운임-기본상품"
  $report.sqliteChecks+=@{check="test_db_separate_process_reopen";status="PASS";revision=(Snapshot).revision}
  $report.status="FINAL_NATIVE_UIA_TEST_DB_PASSED"
  Store
  Write-Host "FINAL_UIA_UIA_SUMMARY pages=$($report.passes.Count),menus=$($menus.Count),popups=$(@($report.passes | Where-Object {$_.kind -eq 'popup'}).Count)"
} catch {
  $report.status="FAILED"
  $report.failures+= $_.Exception.Message
  Store
  Write-Error "FINAL_UIA_UIA_FAILURE $($_.Exception.Message)"
  exit 1
}
