import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("all seven KakaoTalk dock IPC commands call the Tauri native backend",()=>{
  const rust=read("src-tauri/src/lib.rs");
  const bridge=read("src/tauri-bridge.ts");
  for(const command of ["dock_status_native","dock_cycle_native",
    "dock_start_native","dock_stop_native","dock_select_native",
    "dock_windows_native","dock_region_native"]) {
    assert.ok(rust.includes("kakao_dock::"+command),command+" missing Rust command");
    assert.ok(bridge.includes('invoke("'+command+'"'),command+" missing TypeScript bridge");
  }
  assert.doesNotMatch(bridge,/dockCycle: async \(\) => notReady/);
  assert.match(rust,/RunEvent::Exit/);
  assert.match(rust,/restore_on_exit/);
});

test("native docking is restricted to KakaoTalk process, restores position, and does not reparent",()=>{
  const native=read("src-tauri/src/kakao_dock.rs");
  assert.match(native,/QueryFullProcessImageNameW/);
  assert.match(native,/eq_ignore_ascii_case\("KakaoTalk.exe"\)/);
  assert.match(native,/GetWindowThreadProcessId/);
  assert.match(native,/GetWindowPlacement/);
  assert.match(native,/SetWindowPlacement/);
  assert.match(native,/IsWindowVisible/);
  assert.match(native,/restore_on_exit/);
  assert.doesNotMatch(native,/SetParent/);
  assert.doesNotMatch(native,/ReadProcessMemory|WriteProcessMemory|SetWindowsHookEx/);
});

test("screen supports choosing among multiple KakaoTalk windows and three view modes",()=>{
  const header=read("src/app/AppHeader.tsx");
  const shell=read("src/HubShell.tsx");
  const app=read("src/App.tsx");
  const model=read("src/app/useAppModel.ts");
  assert.match(header,/data-tauri-drag-region/);
  assert.match(read("src-tauri/capabilities/default.json"),/core:window:allow-start-dragging/);
  assert.match(header,/dock\.mode === "OVERLAP"/);
  assert.match(header,/dock\.mode === "STACK"/);
  assert.match(shell,/stacked = dock\.active && dock\.mode === "STACK"/);
  assert.match(shell,/hidden=\{stacked\}/);
  assert.match(app,/KakaoDockPicker/);
  assert.match(model,/setDockCandidates\(await window\.bando!\.dockWindows\(\)\)/);
  assert.match(model,/dockSelect\(handle\)/);
});

test("KakaoTalk region resyncs on window moves, focus and monitor scale changes",()=>{
  const shell=read("src/HubShell.tsx");
  for(const event of ["onMoved","onResized","onScaleChanged","onFocusChanged"]){
    assert.ok(shell.includes("current."+event+"(send)"),event+" listener missing");
  }
  assert.match(shell,/unlisten\.forEach\(\(off\) => off\(\)\)/);
  const native=read("src-tauri/src/kakao_dock.rs");
  assert.match(native,/IsIconic\(s\.hwnd\)/);
  assert.match(native,/split_rect\(work:Rect,desired:i32,scale:f64\)/);
  assert.match(native,/s\.main_original=before_split/);
});


test("native docking preserves current window when a new target is invalid",()=>{
  const source=read("src-tauri/src/kakao_dock.rs");
  const start=source.slice(source.indexOf("fn start(app:"),source.indexOf("#[tauri::command]\npub fn dock_windows_native"));
  const validate=start.indexOf("let mut session=native::attach(");
  const release=start.indexOf("inner.session.take()");
  assert.ok(validate>=0 && release>validate,
    "candidate must be authenticated before previous dock is released");
  assert.match(start,/if format!\("\{:016X\}",current\.hwnd as usize\)==handle/);
  assert.match(start,/if rollback\.is_ok\(\)\{inner\.session=Some\(old\);\}/);
});

test("native overlap sizing tracks final CSS region and returns live ratio",()=>{
  const source=read("src-tauri/src/kakao_dock.rs");
  const shell=read("src/HubShell.tsx");
  assert.match(source,/pub fn sync\(s:&mut Session/);
  assert.match(source,/s\.width=target\.width\(\);/);
  assert.match(source,/pub fn measured_ratio\(s:&Session\)/);
  assert.match(source,/ratio:native::measured_ratio\(&s\)/);
  assert.match(shell,/lastDragged\.current = next/);
  assert.match(shell,/const next = lastDragged\.current/);
  assert.match(shell,/onLostPointerCapture/);
});

test("failed layout switch rolls native windows back and reports sync failures",()=>{
  const source=read("src-tauri/src/kakao_dock.rs");
  assert.match(source,/let before_kakao=placement\(s\.hwnd\)\?/);
  assert.match(source,/SetWindowPlacement\(s\.hwnd,&before_kakao\)/);
  assert.match(source,/set_z\(s\.hwnd,kakao_was_topmost\)/);
  assert.match(source,/let error=native::sync\(&mut session,&app,inner\.region\)\.err\(\)/);
  assert.match(source,/response\.notice=Some\(format!\("카카오톡 창 위치 동기화 실패/);
  assert.match(source,/inner\.session=Some\(s\);\s*result\?;/);
});
