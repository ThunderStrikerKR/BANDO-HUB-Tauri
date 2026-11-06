//! Reversible Win32 KakaoTalk window placement. No window reparenting, hooks,
//! process injection, or message/clipboard inspection.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Candidate {
    handle: String, title: String, class_name: String,
    process_id: u32, kind: &'static str,
}
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Status {
    active: bool, mode: &'static str, ratio: f64,
    handle: Option<String>, notice: Option<String>, selection_required: bool,
}
fn inactive() -> Status {
    Status {active:false, mode:"ORIGINAL", ratio:0.8, handle:None,
        notice:None, selection_required:false}
}
#[derive(Clone, Copy, Deserialize)]
pub struct Region { x:f64, y:f64, width:f64, height:f64 }
#[derive(Default)]
pub struct Dock(pub Mutex<Inner>);
#[derive(Default)]
pub struct Inner { session: Option<Session>, region: Option<Region> }

#[cfg(windows)]
mod native {
    use super::*;
    use std::path::Path;
    type Hwnd = isize;
    type Handle = isize;
    #[derive(Clone, Copy, Default)]
    #[repr(C)]
    pub struct Rect {left:i32, top:i32, right:i32, bottom:i32}
    impl Rect {
        fn width(self)->i32 {self.right-self.left}
        fn height(self)->i32 {self.bottom-self.top}
    }
    #[derive(Clone, Copy, Default)]
    #[repr(C)]
    struct Point { x:i32, y:i32 }
    #[derive(Clone, Copy, Default)]
    #[repr(C)]
    pub struct Placement {length:u32, flags:u32, show:u32,
        min:Point, max:Point, normal:Rect}
    #[repr(C)]
    struct MonitorInfo {size:u32, monitor:Rect, work:Rect, flags:u32}
    const SW_RESTORE:i32=9;
    const SWP_NOACTIVATE:u32=0x10;
    const SWP_NOMOVE:u32=0x2;
    const SWP_NOSIZE:u32=0x1;
    const SWP_NOZORDER:u32=0x4;
    const HWND_TOPMOST:Hwnd=-1;
    const HWND_NOTOPMOST:Hwnd=-2;
    const PROCESS_QUERY_LIMITED_INFORMATION:u32=0x1000;

    #[link(name="user32")]
    unsafe extern "system" {
        fn EnumWindows(cb:Option<unsafe extern "system" fn(Hwnd,isize)->i32>, param:isize)->i32;
        fn IsWindow(hwnd:Hwnd)->i32;
        fn IsWindowVisible(hwnd:Hwnd)->i32;
        fn IsIconic(hwnd:Hwnd)->i32;
        fn GetWindow(hwnd:Hwnd,command:u32)->Hwnd;
        fn GetWindowTextW(hwnd:Hwnd,ptr:*mut u16,len:i32)->i32;
        fn GetClassNameW(hwnd:Hwnd,ptr:*mut u16,len:i32)->i32;
        fn GetWindowThreadProcessId(hwnd:Hwnd,pid:*mut u32)->u32;
        fn GetWindowRect(hwnd:Hwnd,rect:*mut Rect)->i32;
        fn GetWindowPlacement(hwnd:Hwnd,ptr:*mut Placement)->i32;
        fn SetWindowPlacement(hwnd:Hwnd,ptr:*const Placement)->i32;
        fn SetWindowPos(hwnd:Hwnd,after:Hwnd,x:i32,y:i32,w:i32,h:i32,flags:u32)->i32;
        fn ShowWindow(hwnd:Hwnd,cmd:i32)->i32;
        fn GetWindowLongPtrW(hwnd:Hwnd,index:i32)->isize;
        fn GetForegroundWindow()->Hwnd;
        fn MonitorFromWindow(hwnd:Hwnd,flags:u32)->Handle;
        fn GetMonitorInfoW(handle:Handle,info:*mut MonitorInfo)->i32;
    }
    #[link(name="kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access:u32,inherit:i32,pid:u32)->Handle;
        fn QueryFullProcessImageNameW(handle:Handle,flags:u32,name:*mut u16,len:*mut u32)->i32;
        fn CloseHandle(handle:Handle)->i32;
        fn GetCurrentProcessId()->u32;
    }
    fn os(action:&str)->String { format!("{action}: {}",std::io::Error::last_os_error()) }
    fn win_text(hwnd:Hwnd,is_class:bool)->String {
        let mut value=[0u16;512];
        let n=unsafe { if is_class {
            GetClassNameW(hwnd,value.as_mut_ptr(),value.len() as i32)
        } else { GetWindowTextW(hwnd,value.as_mut_ptr(),value.len() as i32) }};
        String::from_utf16_lossy(&value[..n.max(0) as usize])
    }
    fn exe_is_kakao(pid:u32)->bool {
        if pid==0 || pid==unsafe {GetCurrentProcessId()} {return false}
        unsafe {
            let process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,0,pid);
            if process==0 {return false}
            let mut wide=[0u16;2048];
            let mut size=wide.len() as u32;
            let ok=QueryFullProcessImageNameW(process,0,wide.as_mut_ptr(),&mut size)!=0;
            CloseHandle(process);
            if !ok {return false}
            Path::new(&String::from_utf16_lossy(&wide[..size as usize]))
                .file_name().and_then(|n|n.to_str())
                .is_some_and(|n|n.eq_ignore_ascii_case("KakaoTalk.exe"))
        }
    }
    fn verified(hwnd:Hwnd)->Option<u32> {
        unsafe {
            if hwnd==0 || IsWindow(hwnd)==0 || IsWindowVisible(hwnd)==0
                || GetWindow(hwnd,4)!=0 {return None}
            let mut pid=0u32;
            GetWindowThreadProcessId(hwnd,&mut pid);
            if !exe_is_kakao(pid) {return None}
            let r=rect(hwnd).ok()?;
            if r.width()<140 || r.height()<150 {return None}
            Some(pid)
        }
    }
    unsafe extern "system" fn enumerate(hwnd:Hwnd,param:isize)->i32 {
        if let Some(pid)=verified(hwnd) {
            let title=win_text(hwnd,false);
            let class_name=win_text(hwnd,true);
            let kind=if title=="카카오톡"||title.eq_ignore_ascii_case("KakaoTalk")
                {"MAIN"} else {"CHAT"};
            let dest=unsafe {&mut *(param as *mut Vec<Candidate>)};
            dest.push(Candidate{handle:format!("{:016X}",hwnd as usize),
                title,class_name,process_id:pid,kind});
        }
        1
    }
    pub fn candidates()->Vec<Candidate> {
        let mut found: Vec<Candidate> = Vec::new();
        unsafe {EnumWindows(Some(enumerate),&mut found as *mut _ as isize);}
        found.sort_by_key(|c|if c.kind=="MAIN"{0}else{1});
        found
    }
    fn parse(id:&str)->Result<Hwnd,String> {
        if id.is_empty()||id.len()>16||!id.bytes().all(|b|b.is_ascii_hexdigit()){
            return Err("잘못된 카카오톡 창 식별자입니다.".into())
        }
        usize::from_str_radix(id,16).map(|h|h as Hwnd)
            .map_err(|_|"창 식별자를 읽을 수 없습니다.".into())
    }
    pub fn main_window(app:&AppHandle)->Result<Hwnd,String> {
        let window=app.get_webview_window("main").ok_or("반도허브 창을 찾지 못했습니다.")?;
        Ok(window.hwnd().map_err(|e|e.to_string())?.0 as Hwnd)
    }
    fn rect(hwnd:Hwnd)->Result<Rect,String> {
        let mut r=Rect::default();
        if unsafe{GetWindowRect(hwnd,&mut r)}==0 {Err(os("창 위치 조회 실패"))}
        else {Ok(r)}
    }
    fn placement(hwnd:Hwnd)->Result<Placement,String>{
        let mut p=Placement{length:std::mem::size_of::<Placement>() as u32,..Default::default()};
        if unsafe{GetWindowPlacement(hwnd,&mut p)}==0{Err(os("창 복구 정보 조회 실패"))}
        else{Ok(p)}
    }
    fn topmost(hwnd:Hwnd)->bool{unsafe{GetWindowLongPtrW(hwnd,-20)&0x8!=0}}
    fn set_z(hwnd:Hwnd,ontop:bool){
        unsafe{SetWindowPos(hwnd,if ontop{HWND_TOPMOST}else{HWND_NOTOPMOST},
            0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE);}
    }
    fn set_rect(hwnd:Hwnd,r:Rect,above:Hwnd)->Result<(),String>{
        if r.width()<100||r.height()<100{return Err("창을 배치할 공간이 부족합니다.".into());}
        let flags=SWP_NOACTIVATE | if above==0 {SWP_NOZORDER}else{0};
        if unsafe{SetWindowPos(hwnd,above,r.left,r.top,r.width(),r.height(),flags)}==0{
            Err(os("창 배치 실패"))
        }else{Ok(())}
    }
    fn monitor_work(hwnd:Hwnd)->Result<Rect,String>{
        let monitor=unsafe{MonitorFromWindow(hwnd,2)};
        if monitor==0{return Err("모니터를 확인할 수 없습니다.".into())}
        let mut info=MonitorInfo{size:std::mem::size_of::<MonitorInfo>() as u32,
            monitor:Rect::default(),work:Rect::default(),flags:0};
        if unsafe{GetMonitorInfoW(monitor,&mut info)}==0{
            Err(os("모니터 영역 조회 실패"))
        }else{Ok(info.work)}
    }
    fn overlay_region(app:&AppHandle,r:Region)->Result<Rect,String>{
        let main=app.get_webview_window("main").ok_or("반도허브 창을 찾지 못했습니다.")?;
        let pos=main.inner_position().map_err(|e|e.to_string())?;
        let scale=main.scale_factor().map_err(|e|e.to_string())?;
        if !scale.is_finite()||scale<=0.0||r.width<100.0||r.height<100.0
            ||![r.x,r.y,r.width,r.height].iter().all(|x|x.is_finite()){
            return Err("카카오톡 영역을 확인할 수 없습니다.".into())
        }
        let left=pos.x+(r.x*scale).round() as i32;
        let top=pos.y+(r.y*scale).round() as i32;
        let width=(r.width*scale).round() as i32;
        let height=(r.height*scale).round() as i32;
        Ok(Rect{left,top,right:left+width,bottom:top+height})
    }
    fn focus_on_app_or_kakao(pid:u32)->bool{
        let hwnd=unsafe{GetForegroundWindow()};
        if hwnd==0{return false}
        let mut focused_pid=0u32;
        unsafe{GetWindowThreadProcessId(hwnd,&mut focused_pid);}
        focused_pid==pid||focused_pid==unsafe{GetCurrentProcessId()}
    }
    #[derive(Clone,Copy,PartialEq,Eq)]
    pub enum Mode {Overlap,Stack}
    impl Mode{pub fn name(self)->&'static str{
        match self{Self::Overlap=>"OVERLAP",Self::Stack=>"STACK"}
    }}
    #[derive(Clone,Copy)]
    pub struct Session{
        pub(super) hwnd:Hwnd,pid:u32,main:Hwnd,
        kakao_original:Placement,main_original:Placement,
        original_topmost:bool,pub mode:Mode,pub width:i32,
    }
    pub fn attach(main:Hwnd,id:&str)->Result<Session,String>{
        let candidate=candidates().into_iter().find(|c|c.handle==id)
            .ok_or("허용된 카카오톡 창이 아닙니다.")?;
        let hwnd=parse(id)?;
        Ok(Session{hwnd,pid:candidate.process_id,main,
            kakao_original:placement(hwnd)?,main_original:placement(main)?,
            original_topmost:topmost(hwnd),mode:Mode::Overlap,width:420})
    }
    pub fn live(s:&Session)->bool{
        verified(s.hwnd)==Some(s.pid)&&unsafe{IsWindow(s.main)}!=0
    }
    pub fn overlap(s:&mut Session,app:&AppHandle,region:Region)->Result<(),String>{
        let target=overlay_region(app,region)?;
        if s.mode==Mode::Stack && unsafe{SetWindowPlacement(s.main,&s.main_original)}==0 {
            return Err(os("반도허브 창 위치 복원 실패"))
        }
        unsafe{ShowWindow(s.hwnd,SW_RESTORE);}
        set_rect(s.hwnd,target,HWND_TOPMOST)?;
        s.width=target.width();
        s.mode=Mode::Overlap;
        Ok(())
    }
    fn split_rect(work:Rect,desired:i32)->Result<(Rect,Rect),String>{
        let k=desired.clamp(392,620);
        if work.width()<k+8+1024||work.height()<700{
            return Err("나누어 보기는 모니터 공간이 부족합니다. 겹쳐 보기를 이용하세요.".into())
        }
        Ok((
            Rect{left:work.left,top:work.top,right:work.left+k,bottom:work.bottom},
            Rect{left:work.left+k+8,top:work.top,right:work.right,bottom:work.bottom}
        ))
    }
    pub fn stack(s:&mut Session)->Result<(),String>{
        let (kakao,main)=split_rect(monitor_work(s.main)?,s.width)?;
        unsafe{ShowWindow(s.main,SW_RESTORE);}
        if let Err(error)=set_rect(s.main,main,0) {
            unsafe{SetWindowPlacement(s.main,&s.main_original);}
            return Err(error)
        }
        set_z(s.hwnd,s.original_topmost);
        unsafe{ShowWindow(s.hwnd,SW_RESTORE);}
        if let Err(e)=set_rect(s.hwnd,kakao,0){
            unsafe{SetWindowPlacement(s.main,&s.main_original);}
            return Err(e)
        }
        s.mode=Mode::Stack; Ok(())
    }
    pub fn sync(s:&Session,app:&AppHandle,region:Option<Region>)->Result<(),String>{
        if !live(s){return Err("카카오톡 연결이 끊어졌습니다.".into())}
        if s.mode==Mode::Overlap{
            if unsafe{IsIconic(s.main)}!=0 || !focus_on_app_or_kakao(s.pid) {
                set_z(s.hwnd,s.original_topmost);
            }else if let Some(area)=region{
                set_rect(s.hwnd,overlay_region(app,area)?,HWND_TOPMOST)?;
            }
        }else if unsafe{IsIconic(s.main)}==0{
            let main=rect(s.main)?;
            let target=Rect{left:main.left-s.width-8,top:main.top,
                right:main.left-8,bottom:main.bottom};
            if target.left>=monitor_work(s.main)?.left {set_rect(s.hwnd,target,0)?;}
        }
        Ok(())
    }
    pub fn restore(s:&Session){
        if unsafe{IsWindow(s.hwnd)}!=0{
            set_z(s.hwnd,s.original_topmost);
            unsafe{SetWindowPlacement(s.hwnd,&s.kakao_original);}
        }
        if s.mode==Mode::Stack && unsafe{IsWindow(s.main)}!=0{
            unsafe{SetWindowPlacement(s.main,&s.main_original);}
        }
    }
    #[cfg(test)]
    mod tests{
        use super::*;
        #[test] fn non_kakao_process_is_denied(){
            assert_eq!(verified(0),None);
            assert!(!exe_is_kakao(unsafe{GetCurrentProcessId()}));
            assert!(parse("XYZ").is_err());
        }
        #[test] fn split_layout_reserves_main_minimum(){
            let area=Rect{left:0,top:0,right:1920,bottom:1040};
            let (left,right)=split_rect(area,420).unwrap();
            assert_eq!(left.width(),420);
            assert!(right.width()>=1024);
            assert!(split_rect(Rect{left:0,top:0,right:1280,bottom:1000},420).is_err());
        }
    }
}
#[cfg(windows)]
use native::Session;
#[cfg(not(windows))]
#[derive(Clone,Copy)]
pub struct Session;

fn lock(dock:&Dock)->Result<std::sync::MutexGuard<'_,Inner>,String>{
    dock.0.lock().map_err(|_|"카카오톡 연결 상태 잠금 오류".into())
}
fn status(inner:&Inner)->Status{
    #[cfg(windows)]
    if let Some(s)=inner.session{
        return Status{active:true,mode:s.mode.name(),ratio:0.8,
            handle:Some(format!("{:016X}",s.hwnd as usize)),
            notice:None,selection_required:false}
    }
    let _=inner;
    inactive()
}
fn start(app:&AppHandle,inner:&mut Inner,handle:&str)->Result<Status,String>{
    #[cfg(windows)]
    {
        if let Some(old)=inner.session.take(){native::restore(&old);}
        let region=inner.region.ok_or("도킹 영역의 크기를 아직 확인하지 못했습니다.")?;
        let mut session=native::attach(native::main_window(app)?,handle)?;
        if let Err(e)=native::overlap(&mut session,app,region){
            native::restore(&session);return Err(e)
        }
        inner.session=Some(session);
        return Ok(status(inner))
    }
    #[cfg(not(windows))]
    {let _=(app,inner,handle);Err("Windows 전용 기능입니다.".into())}
}
#[tauri::command]
pub fn dock_windows_native()->Result<Vec<Candidate>,String>{
    #[cfg(windows)]{Ok(native::candidates())}
    #[cfg(not(windows))]{Err("Windows 전용 기능입니다.".into())}
}
#[tauri::command]
pub fn dock_status_native(app:AppHandle,dock:State<'_,Dock>)->Result<Status,String>{
    let mut inner=lock(&dock)?;
    #[cfg(windows)]
    if let Some(session)=inner.session.take(){
        if !native::live(&session){
            native::restore(&session);
            let mut s=inactive();s.notice=Some("카카오톡 창 연결이 해제되었습니다.".into());
            return Ok(s)
        }
        let _=native::sync(&session,&app,inner.region);
        inner.session=Some(session);
    }
    #[cfg(not(windows))]{let _=app;}
    Ok(status(&inner))
}
#[tauri::command]
pub fn dock_cycle_native(app:AppHandle,dock:State<'_,Dock>)->Result<Status,String>{
    let mut inner=lock(&dock)?;
    #[cfg(windows)]
    {
        if let Some(mut session)=inner.session.take(){
            if !native::live(&session){native::restore(&session);return Ok(inactive())}
            if session.mode==native::Mode::Overlap{
                if let Err(e)=native::stack(&mut session){inner.session=Some(session);return Err(e)}
                inner.session=Some(session);return Ok(status(&inner))
            }
            native::restore(&session);return Ok(inactive())
        }
        let windows=native::candidates();
        if windows.is_empty(){return Err("실행 중인 카카오톡 창을 찾지 못했습니다.".into())}
        if windows.len()>1{
            let mut s=inactive();s.selection_required=true;
            s.notice=Some("연결할 카카오톡 창을 선택하세요.".into());return Ok(s)
        }
        return start(&app,&mut inner,&windows[0].handle)
    }
    #[cfg(not(windows))]{let _=(app,inner);Err("Windows 전용 기능입니다.".into())}
}
#[tauri::command]
pub fn dock_start_native(app:AppHandle,dock:State<'_,Dock>,handle:String,ratio:f64)->Result<Status,String>{
    if !ratio.is_finite()||!(0.1..=1.0).contains(&ratio){
        return Err("배치 비율이 올바르지 않습니다.".into())
    }
    let mut inner=lock(&dock)?;
    start(&app,&mut inner,&handle)
}
#[tauri::command]
pub fn dock_select_native(app:AppHandle,dock:State<'_,Dock>,handle:String)->Result<Status,String>{
    let mut inner=lock(&dock)?;
    start(&app,&mut inner,&handle)
}
#[tauri::command]
pub fn dock_stop_native(dock:State<'_,Dock>)->Result<Status,String>{
    let mut inner=lock(&dock)?;
    #[cfg(windows)]if let Some(s)=inner.session.take(){native::restore(&s);}
    #[cfg(not(windows))]{inner.session=None;}
    Ok(inactive())
}
#[tauri::command]
pub fn dock_region_native(app:AppHandle,dock:State<'_,Dock>,region:Region)->Result<(),String>{
    let mut inner=lock(&dock)?;
    if region.width>=100.0&&region.height>=100.0
        &&[region.x,region.y,region.width,region.height].iter().all(|v|v.is_finite()){
        inner.region=Some(region);
    }
    #[cfg(windows)]if let Some(s)=inner.session{
        if native::live(&s){let _=native::sync(&s,&app,inner.region);}
    }
    #[cfg(not(windows))]{let _=app;}
    Ok(())
}
pub fn restore_on_exit(dock:&Dock){
    if let Ok(mut inner)=lock(dock){
        #[cfg(windows)]if let Some(s)=inner.session.take(){native::restore(&s);}
        #[cfg(not(windows))]{inner.session=None;}
    }
}
