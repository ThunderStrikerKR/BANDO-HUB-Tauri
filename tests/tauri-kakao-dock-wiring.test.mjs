import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const native=read("src-tauri/src/kakao_dock.rs");
const bridge=read("src/tauri-bridge.ts");
const shell=read("src/HubShell.tsx");
const header=read("src/app/AppHeader.tsx");
const model=read("src/app/useAppModel.ts");
const app=read("src/App.tsx");

test("all explicit Kakao commands are registered in Tauri and the TypeScript bridge",()=>{
  const rust=read("src-tauri/src/lib.rs");
  for(const c of ["dock_status_native","dock_cycle_native","dock_start_native",
    "dock_stop_native","dock_select_native","dock_windows_native",
    "dock_region_native","dock_mode_native"]){
    assert.ok(rust.includes("kakao_dock::"+c),c+" not registered");
    assert.ok(bridge.includes('invoke("'+c+'"'),c+" not bridged");
  }
});

test("native Kakao process authentication, safe original placement and no injection",()=>{
  for(const fragment of [
    "QueryFullProcessImageNameW","KakaoTalk.exe","GetWindowThreadProcessId",
    "GetWindowPlacement","SetWindowPlacement","restore_on_exit",
    "pub struct Tracked","pub fn restore_related","GetForegroundWindow",
  ]) assert.ok(native.includes(fragment),fragment+" absent");
  assert.doesNotMatch(native,/SetParent|ReadProcessMemory|WriteProcessMemory|SetWindowsHookEx/);
  assert.match(native,/verified\(t\.hwnd\)==Some\(t\.pid\)/);
  assert.match(native,/WS_CAPTION/);
  assert.match(native,/SWP_FRAMECHANGED/);
  assert.match(native,/fn hide_caption\(hwnd:Hwnd\)/);
  assert.match(native,/fn restore_style\(hwnd:Hwnd,original:isize\)/);
  assert.match(native,/original_style:isize/);
  assert.match(native,/restore_style\(t\.hwnd,t\.original_style\)/);
  assert.match(native,/restore_style\(s\.hwnd,s\.original_style\)/);
  assert.match(native,/if IsIconic\(hwnd\)==0/);
});

test("there are precisely two viewing modes and connection is not a view",()=>{
  assert.match(header,/role="group" aria-label="카카오톡 보기 방식"/);
  assert.match(header,/aria-pressed=\{dock.mode === "OVERLAP"\}/);
  assert.match(header,/aria-pressed=\{dock.mode === "STACK"\}/);
  assert.match(header,/겹쳐 보기/);
  assert.match(header,/나누어 보기/);
  assert.match(header,/카카오톡 함께 보기/);
  assert.match(header,/onDockStop/);
  assert.match(header,/카카오톡 연결 해제/);
  assert.doesNotMatch(header,/다음: 카카오톡|다음: 나누어 보기|다음: 카카오톡 창 원래 위치 복구/);
  assert.match(model,/dockMode\(mode\)/);
  assert.match(model,/dockStop\(\)/);
  assert.doesNotMatch(model,/bando!\.dockCycle\(\)/);
  assert.match(app,/onDockMode=/);
  assert.match(app,/onDockStop=/);
});

test("both modes use the original left KakaoTalk pane and never move BANDO HUB",()=>{
  assert.match(shell,/className="hub-panel-slot hub-slot-0 hub-kakao-slot"/);
  assert.doesNotMatch(shell,/hidden=\{stacked\}/);
  assert.match(shell,/--kakao-reserved-width/);
  assert.match(native,/pub fn stack\(s:&mut Session,app:&AppHandle,region:Region\)/);
  assert.match(native,/fn stack_targets\(area:Rect,main:Hwnd,chats:&\[Hwnd\]\)/);
  assert.match(native,/SendMessageTimeoutW/);
  assert.match(native,/WM_GETMINMAXINFO/);
  assert.match(native,/DwmGetWindowAttribute/);
  assert.match(native,/banner_top\(main,main_visible\)/);
  assert.match(native,/if chats\.is_empty\(\) \{/);
  assert.match(native,/previous\.height\(\)<area\.height\(\)/);
  const body=native.split("pub fn stack(s:&mut Session")[1]?.split("pub fn sync(")[0];
  assert.ok(body);
  assert.doesNotMatch(body,/set_rect\(s\.main|SetWindowPlacement\(s\.main|split_rect\(/);
});

test("all regular KakaoTalk MAIN and CHAT windows are tracked and arranged in relative order",()=>{
  assert.match(native,/WS_SYSMENU/);
  assert.match(native,/pub fn sync_related\(/);
  assert.match(native,/for candidate in list\.iter\(\)\.filter\(\|c\|c\.process_id==s\.pid\)/);
  assert.match(native,/if tracked\.len\(\)>=32/);
  assert.match(native,/newcomers\.iter\(\)\.rev\(\)/);
  assert.match(native,/SetWindowPos\(base,chat,0,0,0,0,/);
  assert.match(native,/SetWindowPos\(s\.main,base,0,0,0,0,/);
  assert.doesNotMatch(native,/set_rect\(t\.hwnd,target,HWND_TOPMOST\)/);
  assert.match(model,/300,/);
});

test("failed layout switches are reversible and do not disconnect current KakaoTalk",()=>{
  const mode=native.split("pub fn dock_mode_native(")[1]?.split("#[tauri::command]")[0];
  assert.ok(mode);
  assert.match(mode,/let before=session/);
  assert.match(mode,/session=before/);
  assert.match(mode,/inner\.session=Some\(session\)/);
  assert.match(mode,/return Err\(error\)/);
  const related=native.split("pub fn sync_related(")[1]?.split("pub fn measured_ratio(")[0];
  assert.ok(related);
  assert.match(related,/let snapshots=all\.iter\(\)/);
  assert.match(related,/for \(hwnd,before\) in snapshots/);
  assert.match(native,/inner\.restore_related\(\)/);
  assert.match(native,/native::restore\(&s\)/);
  const restore=native.split("pub fn restore(s:&Session)")[1]?.split("#[cfg(test)]")[0];
  assert.ok(restore);
  assert.doesNotMatch(restore,/SetWindowPlacement\(s\.main/);
  assert.match(restore,/SetWindowPlacement\(s\.hwnd/);
});

test("connecting to an invalid HWND does not drop the existing session",()=>{
  const start=native.split("fn start(app:")[1]?.split("#[tauri::command]")[0];
  assert.ok(start);
  const check=start.indexOf("let requested=native::candidates()");
  const taking=start.indexOf("let previous=inner.session.take()");
  assert.ok(check>=0&&taking>check);
  assert.match(start,/if format!\("\{:016X\}",current\.hwnd as usize\)==handle/);
  assert.match(start,/if rollback\.is_ok\(\)/);
});

test("the synthetic native Windows test covers both chat and main windows",()=>{
  assert.match(native,/spawn_fixture_window\("카카오톡"\)/);
  assert.match(native,/spawn_fixture_window\("합성 대화"\)/);
  assert.match(native,/stack_targets\(pane,fixture_hwnd,&\[chat_hwnd\]\)/);
  assert.match(native,/SetWindowPlacement must restore the original window bounds/);
});

test("Tauri layout still synchronizes region on window movement and monitor scaling",()=>{
  for(const event of ["onMoved","onResized","onScaleChanged","onFocusChanged"]){
    assert.ok(shell.includes("current."+event+"(send)"),event+" event missing");
  }
  assert.match(shell,/unlisten\.forEach\(\(off\) => off\(\)\)/);
  assert.match(shell,/lastDragged\.current = next/);
});
