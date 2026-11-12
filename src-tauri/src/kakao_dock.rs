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
pub struct Inner {
    session: Option<Session>, region: Option<Region>,
    #[cfg(windows)]
    tracked: Vec<native::Tracked>,
    #[cfg(windows)]
    active_chat: Option<isize>,
}

#[cfg(windows)]
impl Inner {
    fn sync_related(&mut self,session:&Session,app:&AppHandle)->Result<(),String>{
        let mut tracked=std::mem::take(&mut self.tracked);
        let mut active=self.active_chat.take();
        let result=native::sync_related(session,&mut tracked,&mut active,app,self.region);
        self.tracked=tracked;
        self.active_chat=active;
        result
    }
    fn restore_related(&mut self) {
        let mut tracked=std::mem::take(&mut self.tracked);
        let mut active=self.active_chat.take();
        native::restore_related(&mut tracked,&mut active);
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::path::Path;
    type Hwnd = isize;
    type Handle = isize;
    #[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
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
    #[repr(C)]
    struct MinMaxInfo {
        reserved:Point,max_size:Point,max_position:Point,
        min_track:Point,max_track:Point,
    }
    const SW_RESTORE:i32=9;
    const SWP_NOACTIVATE:u32=0x10;
    const SWP_NOMOVE:u32=0x2;
    const SWP_NOSIZE:u32=0x1;
    const SWP_NOZORDER:u32=0x4;
    const HWND_TOPMOST:Hwnd=-1;
    const HWND_NOTOPMOST:Hwnd=-2;
    const WS_SYSMENU:isize=0x00080000;
    const WM_GETMINMAXINFO:u32=0x24;
    const SMTO_ABORTIFHUNG:u32=0x2;
    const DWMWA_EXTENDED_FRAME_BOUNDS:u32=9;
    const PROCESS_QUERY_LIMITED_INFORMATION:u32=0x1000;

    #[link(name="user32")]
    unsafe extern "system" {
        fn EnumWindows(cb:Option<unsafe extern "system" fn(Hwnd,isize)->i32>, param:isize)->i32;
        fn EnumChildWindows(hwnd:Hwnd,cb:Option<unsafe extern "system" fn(Hwnd,isize)->i32>,param:isize)->i32;
        fn SendMessageTimeoutW(hwnd:Hwnd,msg:u32,wparam:usize,lparam:isize,
            flags:u32,timeout:u32,result:*mut usize)->isize;
        fn GetDpiForWindow(hwnd:Hwnd)->u32;
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
    #[link(name="dwmapi")]
    unsafe extern "system" {
        fn DwmGetWindowAttribute(hwnd:Hwnd,attribute:u32,value:*mut Rect,size:u32)->i32;
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
            if hwnd==0 || IsWindow(hwnd)==0 || IsWindowVisible(hwnd)==0 {
                return None
            }
            // KakaoTalk chats can be owned top-level windows. EnumWindows
            // still returns them; GW_OWNER != 0 is not a reason to ignore
            // a verified KakaoTalk chat window.
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
            if title.trim().is_empty() { return 1 }
            // The original Electron implementation identified regular KakaoTalk
            // windows by WS_SYSMENU, excluding notifications and floating tips.
            if unsafe {GetWindowLongPtrW(hwnd,-16)} & WS_SYSMENU == 0 { return 1 }
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
        if topmost(hwnd)==ontop{return}
        unsafe{SetWindowPos(hwnd,if ontop{HWND_TOPMOST}else{HWND_NOTOPMOST},
            0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE);}
    }
    fn set_rect(hwnd:Hwnd,r:Rect,above:Hwnd)->Result<(),String>{
        if r.width()<100||r.height()<100{return Err("창을 배치할 공간이 부족합니다.".into());}
        if rect(hwnd).is_ok_and(|now|now==r)&&(above==0||topmost(hwnd)){
            return Ok(())
        }
        let flags=SWP_NOACTIVATE | if above==0 {SWP_NOZORDER}else{0};
        if unsafe{SetWindowPos(hwnd,above,r.left,r.top,r.width(),r.height(),flags)}==0{
            Err(os("창 배치 실패"))
        }else{Ok(())}
    }
    fn visible_rect(hwnd:Hwnd)->Result<Rect,String>{
        let outer=rect(hwnd)?;
        let mut visual=Rect::default();
        let ok=unsafe{DwmGetWindowAttribute(hwnd,DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut visual,std::mem::size_of::<Rect>() as u32)}==0;
        Ok(if ok&&visual.width()>0&&visual.height()>0{visual}else{outer})
    }
    fn set_visible_rect(hwnd:Hwnd,desired:Rect)->Result<(),String>{
        let outer=rect(hwnd)?;
        let visible=visible_rect(hwnd)?;
        if visible==desired{return Ok(())}
        let margins=(visible.left-outer.left,visible.top-outer.top,
            outer.right-visible.right,outer.bottom-visible.bottom);
        set_rect(hwnd,Rect{
            left:desired.left-margins.0,
            top:desired.top-margins.1,
            right:desired.right+margins.2,
            bottom:desired.bottom+margins.3,
        },0)
    }
    fn min_visible_height(hwnd:Hwnd)->Result<i32,String>{
        let mut data=MinMaxInfo{
            reserved:Point::default(),max_size:Point::default(),
            max_position:Point::default(),min_track:Point::default(),
            max_track:Point::default(),
        };
        let mut result=0usize;
        let ok=unsafe{SendMessageTimeoutW(hwnd,WM_GETMINMAXINFO,0,
            &mut data as *mut _ as isize,SMTO_ABORTIFHUNG,500,&mut result)};
        if ok==0||data.min_track.y<=0 {
            return Err("카카오톡 창의 최소 높이를 확인하지 못했습니다.".into())
        }
        let outer=rect(hwnd)?;
        let visual=visible_rect(hwnd)?;
        Ok((data.min_track.y-(outer.height()-visual.height())).max(1))
    }
    unsafe extern "system" fn banner_child(hwnd:Hwnd,param:isize)->i32{
        let (reference,dpi,candidates)=unsafe{
            &mut *(param as *mut (Rect,u32,Vec<i32>))
        };
        if unsafe{IsWindowVisible(hwnd)}==0{return 1}
        if let Ok(child)=rect(hwnd){
            let tolerance=((3.0*(*dpi as f64)/96.0).ceil() as i32).max(2);
            let height=child.height();
            if child.width() as f64>=reference.width() as f64*0.8
                && height as f64>=24.0*(*dpi as f64)/96.0
                && height as f64<=reference.height() as f64*0.35
                && (child.bottom-reference.bottom).abs()<=tolerance {
                candidates.push(child.top);
            }
        }
        1
    }
    fn banner_top(hwnd:Hwnd,reference:Rect)->i32{
        let dpi=unsafe{GetDpiForWindow(hwnd)}.max(96);
        let mut query=(reference,dpi,Vec::<i32>::new());
        unsafe{EnumChildWindows(hwnd,Some(banner_child),
            &mut query as *mut _ as isize);}
        query.2.into_iter().min().unwrap_or(reference.bottom)
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
        if !scale.is_finite()||scale<=0.0||scale>8.0||r.width<100.0||r.height<100.0
            ||r.width>10000.0||r.height>10000.0||r.x.abs()>10000.0||r.y.abs()>10000.0
            ||![r.x,r.y,r.width,r.height].iter().all(|x|x.is_finite()){
            return Err("카카오톡 영역을 확인할 수 없습니다.".into())
        }
        let left=pos.x+(r.x*scale).round() as i32;
        let top=pos.y+(r.y*scale).round() as i32;
        let width=(r.width*scale).round() as i32;
        let height=(r.height*scale).round() as i32;
        Ok(Rect{left,top,right:left+width,bottom:top+height})
    }
    fn focus_on_app_or_kakao(selected:Hwnd,pid:u32)->bool{
        let hwnd=unsafe{GetForegroundWindow()};
        if hwnd==0{return false}
        if hwnd==selected{return true}
        let mut focused_pid=0u32;
        unsafe{GetWindowThreadProcessId(hwnd,&mut focused_pid);}
        // Do not keep a docked Kakao window above another KakaoTalk chat.
        focused_pid==unsafe{GetCurrentProcessId()} || verified(hwnd)==Some(pid)
    }
    #[derive(Clone,Copy,PartialEq,Eq)]
    pub enum Mode {Overlap,Stack}
    impl Mode{pub fn name(self)->&'static str{
        match self{Self::Overlap=>"OVERLAP",Self::Stack=>"STACK"}
    }}
    #[derive(Clone,Copy)]
    pub struct Tracked {
        hwnd:Hwnd, pid:u32, original:Placement, original_topmost:bool,
        kind:&'static str,
    }
    fn tracked_live(t:&Tracked)->bool {
        verified(t.hwnd)==Some(t.pid)
    }
    fn restore_tracked(t:&Tracked) {
        // A stale HWND may already belong to another process.
        if tracked_live(t) {
            set_z(t.hwnd,t.original_topmost);
            unsafe { SetWindowPlacement(t.hwnd,&t.original); }
        }
    }
    pub fn restore_related(tracked:&mut Vec<Tracked>,active_chat:&mut Option<isize>){
        for t in tracked.drain(..){ restore_tracked(&t); }
        *active_chat=None;
    }
    pub fn preserve_original(session:&mut Session,tracked:&[Tracked]) {
        if let Some(t)=tracked.iter().find(|t| t.hwnd==session.hwnd&&t.pid==session.pid){
            session.kakao_original=t.original;
            session.original_topmost=t.original_topmost;
        }
    }
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
    fn belongs_to_current_app(hwnd:Hwnd)->bool {
        if unsafe{IsWindow(hwnd)}==0 {return false}
        let mut pid=0;
        unsafe{GetWindowThreadProcessId(hwnd,&mut pid);}
        pid==unsafe{GetCurrentProcessId()}
    }
    fn belongs_to_original_kakao(s:&Session)->bool {
        if unsafe{IsWindow(s.hwnd)}==0 {return false}
        let mut pid=0;
        unsafe{GetWindowThreadProcessId(s.hwnd,&mut pid);}
        pid==s.pid && exe_is_kakao(pid)
    }
    pub fn live(s:&Session)->bool{
        verified(s.hwnd)==Some(s.pid)&&belongs_to_current_app(s.main)
    }
    // The original v0.8.10 "겹쳐 보기" and "나누어 보기" BOTH use the
    // reserved KakaoTalk panel. STACK vertically divides KakaoTalk's
    // messenger header and conversations; it must NEVER move BANDO HUB.
    pub fn overlap(s:&mut Session,app:&AppHandle,region:Region)->Result<(),String>{
        let target=overlay_region(app,region)?;
        s.width=target.width();
        s.mode=Mode::Overlap;
        Ok(())
    }
    pub fn stack(s:&mut Session,app:&AppHandle,region:Region)->Result<(),String>{
        let target=overlay_region(app,region)?;
        if target.width()<250 || target.height()<360{
            return Err("카카오톡 나누어 보기 영역이 부족합니다.".into())
        }
        s.width=target.width();
        s.mode=Mode::Stack;
        Ok(())
    }
    pub fn sync(s:&mut Session,app:&AppHandle,region:Option<Region>)->Result<(),String>{
        if !live(s){return Err("카카오톡 연결이 끊어졌습니다.".into())}
        if let Some(region)=region {
            s.width=overlay_region(app,region)?.width();
        }
        // All window movement and z-order is performed together by
        // sync_related, so MAIN/CHAT cannot fight one another every 300ms.
        Ok(())
    }
    pub fn measured_ratio(s:&Session)->Result<f64,String>{
        let app=rect(s.main)?.width().max(1) as f64;
        Ok(app/(app+s.width.max(1) as f64))
    }
    // Geometry of the v0.8.10 vertical KakaoTalk split:
    // main messenger at its measured minimum, chat below its banner/ad area.
    fn stack_targets(area:Rect,main:Hwnd,chats:&[Hwnd])
        ->Result<(Rect,Rect),String>{
        if chats.is_empty(){return Ok((area,area))}
        let before=rect(main)?;
        let minimum=min_visible_height(main)?;
        if minimum>=area.height()-100 {
            return Err("대화창과 기본창을 나누어 표시할 높이가 부족합니다.".into())
        }
        let top=Rect{left:area.left,top:area.top,
            right:area.right,bottom:area.top+minimum};
        let outcome=(||{
            set_visible_rect(main,top)?;
            let main_visible=visible_rect(main)?;
            let chat_top=banner_top(main,main_visible).clamp(area.top+1,area.bottom);
            let chat=Rect{left:area.left,top:chat_top,
                right:area.right,bottom:area.bottom};
            if chat.height()<100{
                return Err("대화창 표시 높이가 부족합니다.".into())
            }
            for hwnd in chats {
                if min_visible_height(*hwnd)?>chat.height(){
                    return Err("대화창 최소 높이보다 나누어 보기 영역이 작습니다.".into())
                }
            }
            Ok((top,chat))
        })();
        if outcome.is_err() {
            let _=set_rect(main,before,0);
        }
        outcome
    }
    // Observe KakaoTalk foreground changes without hooking or injecting into
    // KakaoTalk. Only an actively opened chat (or the original main window)
    // is enrolled. Unrelated KakaoTalk settings/photo windows are not moved
    // merely because they exist in the enumeration.
    // The Electron v0.8.10 helper enumerates ALL regular KakaoTalk windows.
    // New conversations enter their original-position registry immediately;
    // foreground changes decide which conversation is visible on top.
    pub fn sync_related(
        s:&Session,tracked:&mut Vec<Tracked>,active_chat:&mut Option<isize>,
        app:&AppHandle,region:Option<Region>,
    )->Result<(),String>{
        tracked.retain(tracked_live);
        let list=candidates();
        let mut newcomers=Vec::new();
        for candidate in list.iter().filter(|c|c.process_id==s.pid) {
            let hwnd=parse(&candidate.handle)?;
            if hwnd==s.hwnd || tracked.iter().any(|t|t.hwnd==hwnd) {continue}
            if tracked.len()>=32 {break}
            newcomers.push((hwnd,candidate.kind));
            tracked.push(Tracked {
                hwnd,pid:candidate.process_id,
                original:placement(hwnd)?,
                original_topmost:topmost(hwnd),kind:candidate.kind,
            });
        }
        let mut all=Vec::new();
        if let Some(root)=list.iter().find(|c|
            c.process_id==s.pid && parse(&c.handle).ok()==Some(s.hwnd)) {
            all.push((s.hwnd,root.kind));
        }
        for tracked_window in tracked.iter().filter(|t|tracked_live(t)){
            all.push((tracked_window.hwnd,tracked_window.kind));
        }
        if all.is_empty(){return Err("연결된 카카오톡 창을 찾지 못했습니다.".into())}
        let foreground=unsafe{GetForegroundWindow()};
        if let Some((hwnd,_))=all.iter().find(|(hwnd,kind)|
            *kind=="CHAT" && *hwnd==foreground) {
            *active_chat=Some(*hwnd);
        } else if let Some((hwnd,_))=newcomers.iter().rev()
            .find(|(_,kind)|*kind=="CHAT") {
            *active_chat=Some(*hwnd);
        }
        if active_chat.is_some_and(|hwnd|
            !all.iter().any(|(h,kind)|*h==hwnd&&*kind=="CHAT")){
            *active_chat=all.iter().rev()
                .find(|(_,kind)|*kind=="CHAT").map(|(hwnd,_)|*hwnd);
        }

        // When BANDO HUB is minimized, leave minimized KakaoTalk windows
        // alone. The original placement remains available for disconnect.
        if unsafe{IsIconic(s.main)}!=0{return Ok(())}
        let area=overlay_region(app,region.ok_or(
            "카카오톡 배치 영역을 확인하지 못했습니다.")?)?;
        let base=all.iter().find(|(_,kind)|*kind=="MAIN")
            .map(|(hwnd,_)|*hwnd);
        let chats=all.iter().filter(|(_,kind)|*kind=="CHAT")
            .map(|(hwnd,_)|*hwnd).collect::<Vec<_>>();
        let snapshots=all.iter().filter_map(|(hwnd,_)|
            rect(*hwnd).ok().map(|before|(*hwnd,before))).collect::<Vec<_>>();
        // No global HWND_TOPMOST flags: order KakaoTalk relatively to the hub.
        // A foreign active application must never be covered by the dock.
        let layout=(||->Result<(),String>{
            let (main_target,chat_target)=if s.mode==Mode::Stack {
                if let Some(base)=base {
                    if unsafe{IsIconic(base)}!=0{
                        (area,area)
                    }else{
                        stack_targets(area,base,&chats)?
                    }
                }else{(area,area)}
            }else{(area,area)};
            for (hwnd,kind) in &all {
                if unsafe{IsIconic(*hwnd)}!=0{continue}
                let target=if s.mode==Mode::Stack&&*kind=="MAIN" {
                    main_target
                }else if s.mode==Mode::Stack && base.is_some() {
                    chat_target
                }else{area};
                set_visible_rect(*hwnd,target)?;
            }
            Ok(())
        })();
        if let Err(problem)=layout{
            for (hwnd,before) in snapshots{
                // Failure must not leave any KakaoTalk windows half-moved.
                let _=set_rect(hwnd,before,0);
            }
            return Err(problem)
        }

        if focus_on_app_or_kakao(s.hwnd,s.pid) {
            let visible_chat=active_chat.filter(|hwnd|
                all.iter().any(|(item,kind)|*item==*hwnd&&*kind=="CHAT")
                    && unsafe{IsIconic(*hwnd)}==0);
            if let Some(chat)=visible_chat {
                // Put the messenger immediately behind the selected chat.
                if let Some(base)=base {
                    if base!=chat {
                        unsafe{SetWindowPos(base,chat,0,0,0,0,
                            SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE);}
                    }
                }
            }
            if let Some(base)=base.or(visible_chat) {
                // This is relative z-order, not always-on-top over the desktop.
                unsafe{SetWindowPos(s.main,base,0,0,0,0,
                    SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE);}
            }
        }
        Ok(())
    }

    // Report the physical app-area share rather than the historical fixed 0.8.
    // Geometry is authoritative: CSS splitter widths and monitor DPI may change.
    pub fn measured_ratio(s:&Session)->Result<f64,String>{
        let app=rect(s.main)?.width().max(1) as f64;
        let kakao=rect(s.hwnd)?.width().max(1) as f64;
        Ok(app/(app+kakao))
    }
    pub fn restore(s:&Session){
        // HWND values can be recycled by Windows after KakaoTalk exits.
        // Never move an unrelated application that happens to inherit the
        // previously selected handle.
        if belongs_to_original_kakao(s){
            set_z(s.hwnd,s.original_topmost);
            unsafe{SetWindowPlacement(s.hwnd,&s.kakao_original);}
        }
        if s.mode==Mode::Stack && belongs_to_current_app(s.main){
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

        // This test is run exclusively inside a temporary copied test binary named
        // KakaoTalk.exe. It is not the real KakaoTalk application and has no account.
        #[repr(C)]
        struct WndClassW {
            style:u32,
            wnd_proc:Option<unsafe extern "system" fn(Hwnd,u32,usize,isize)->isize>,
            cls_extra:i32,
            wnd_extra:i32,
            instance:Handle,
            icon:Handle,
            cursor:Handle,
            brush:Handle,
            menu:*const u16,
            class:*const u16,
        }
        #[repr(C)]
        #[derive(Default)]
        struct Msg {
            hwnd:Hwnd, message:u32, wparam:usize, lparam:isize,
            time:u32, pt:Point, private:u32,
        }
        #[link(name="user32")]
        unsafe extern "system" {
            fn RegisterClassW(class:*const WndClassW)->u16;
            fn CreateWindowExW(ex:u32, class:*const u16, title:*const u16,
                style:u32, x:i32,y:i32,w:i32,h:i32,parent:Hwnd,menu:Handle,
                instance:Handle,param:*mut std::ffi::c_void)->Hwnd;
            fn DestroyWindow(hwnd:Hwnd)->i32;
            fn DefWindowProcW(hwnd:Hwnd,msg:u32,wparam:usize,lparam:isize)->isize;
            fn PeekMessageW(msg:*mut Msg,hwnd:Hwnd,min:u32,max:u32,remove:u32)->i32;
            fn TranslateMessage(msg:*const Msg)->i32;
            fn DispatchMessageW(msg:*const Msg)->isize;
        }
        #[link(name="kernel32")]
        unsafe extern "system" {
            fn GetModuleHandleW(name:*const u16)->Handle;
        }
        unsafe extern "system" fn simple_window_proc(
            hwnd:Hwnd,msg:u32,wparam:usize,lparam:isize,
        )->isize {
            unsafe { DefWindowProcW(hwnd,msg,wparam,lparam) }
        }
        fn wide(s:&str)->Vec<u16> {
            use std::os::windows::ffi::OsStrExt;
            std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
        }
        fn spawn_fixture_window(title:&str)->Hwnd {
            let cls=wide("BandoSyntheticKakaoWin32CI");
            let text=wide(title);
            let instance=unsafe{GetModuleHandleW(std::ptr::null())};
            let def=WndClassW {style:0,wnd_proc:Some(simple_window_proc),
                cls_extra:0,wnd_extra:0,instance,icon:0,cursor:0,brush:0,
                menu:std::ptr::null(),class:cls.as_ptr()};
            let registered=unsafe{RegisterClassW(&def)};
            assert_ne!(registered,0,"Cannot register synthetic Win32 window");
            // WS_OVERLAPPEDWINDOW | WS_VISIBLE: real enumerated top-level GUI window.
            let hwnd=unsafe{CreateWindowExW(0,cls.as_ptr(),text.as_ptr(),
                0x00CF0000|0x10000000,100,100,450,630,0,0,instance,std::ptr::null_mut())};
            assert_ne!(hwnd,0,"Cannot create synthetic Win32 window");
            assert_eq!(unsafe{IsWindowVisible(hwnd)},1);
            hwnd
        }
        #[test]
        #[ignore = "Launched as a temporary KakaoTalk.exe synthetic process by a Windows CI test"]
        fn synthetic_kakao_window_fixture() {
            let ready=std::path::PathBuf::from(
                std::env::var("BANDO_DOCK_SYNTHETIC_READY_FILE").expect("fixture marker env"));
            let hwnd=spawn_fixture_window("카카오톡");
            std::fs::write(&ready,format!("{:016X}",hwnd as usize)).expect("fixture marker write");
            let started=std::time::Instant::now();
            while ready.exists() && started.elapsed()<std::time::Duration::from_secs(45) {
                unsafe {
                    let mut msg=Msg::default();
                    while PeekMessageW(&mut msg,0,0,0,1)!=0 {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            unsafe{DestroyWindow(hwnd);}
        }
        #[test]
        fn synthetic_win32_kakao_window_is_moved_and_restored() {
            use std::{process::Command, time::{Duration,Instant}};
            let folder=std::env::temp_dir().join(
                format!("bando-win32-dock-{}-{}",std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                    .unwrap().as_nanos()));
            std::fs::create_dir_all(&folder).unwrap();
            let binary=folder.join("KakaoTalk.exe");
            std::fs::copy(std::env::current_exe().unwrap(),&binary).unwrap();
            let ready=folder.join("ready.txt");
            let child=Command::new(&binary)
                .arg("--ignored").arg("--exact")
                .arg("kakao_dock::native::tests::synthetic_kakao_window_fixture")
                .arg("--nocapture")
                .env("BANDO_DOCK_SYNTHETIC_READY_FILE",&ready)
                .spawn().expect("launch synthetic KakaoTalk.exe test fixture");
            struct Cleanup {
                child:std::process::Child,
                folder:std::path::PathBuf,
                ready:std::path::PathBuf,
            }
            impl Drop for Cleanup {
                fn drop(&mut self) {
                    let _=std::fs::remove_file(&self.ready);
                    for _ in 0..120 {
                        if self.child.try_wait().ok().flatten().is_some(){break}
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    let _=self.child.kill();
                    let _=self.child.wait();
                    let _=std::fs::remove_dir_all(&self.folder);
                }
            }
            let mut process=Cleanup{child,folder,ready:ready.clone()};
            let started=Instant::now();
            while !ready.exists() && started.elapsed()<Duration::from_secs(12) {
                if let Some(result)=process.child.try_wait().unwrap() {
                    panic!("synthetic window child terminated early: {result}");
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            assert!(ready.exists(),"The synthetic KakaoTalk.exe did not create a visible window");
            let handle=std::fs::read_to_string(&ready).unwrap();
            let fixture_hwnd=parse(&handle).unwrap();
            assert!(verified(fixture_hwnd).is_some(),"real exe-name/Win32 verification");
            let matches=candidates();
            assert!(matches.iter().any(|item|item.handle==handle&&item.kind=="MAIN"));
            let main=spawn_fixture_window("BANDO HUB CI test window");
            assert!(attach(main,&format!("{:016X}",main as usize)).is_err(),
                "non-KakaoTalk.exe must not attach");
            let old=rect(fixture_hwnd).unwrap();
            let session=attach(main,&handle).unwrap();
            assert!(live(&session));
            let original_ratio=measured_ratio(&session).unwrap();
            let wider=Rect{right:old.right+80,..old};
            set_rect(fixture_hwnd,wider,0).unwrap();
            assert!(measured_ratio(&session).unwrap() < original_ratio,
                "reported KakaoTalk ratio must follow actual window geometry");
            let shifted=Rect{left:old.left+40,top:old.top+20,
                right:old.right+40,bottom:old.bottom+20};
            set_rect(fixture_hwnd,shifted,0).unwrap();
            assert_eq!(rect(fixture_hwnd).unwrap(),shifted,
                "SetWindowPos must move the actual top-level Win32 window");
            let wrong_owner=Session{pid:session.pid.wrapping_add(1),..session};
            restore(&wrong_owner);
            assert_eq!(rect(fixture_hwnd).unwrap(),shifted,
                "a stale HWND owner must not have its placement restored");
            restore(&session);
            assert_eq!(rect(fixture_hwnd).unwrap(),old,
                "SetWindowPlacement must restore the original window bounds");
            unsafe{DestroyWindow(main);}
            let _=&mut process;
        }


        #[test] fn split_layout_respects_dpi_and_negative_monitor_origins(){
            // 150% scale: at least 588 physical Kakao pixels and 1536
            // physical app pixels; preserve a monitor left of primary.
            let work=Rect{left:-2560,top:-120,right:0,bottom:1320};
            let (kakao,main)=split_rect(work,420,1.5).unwrap();
            assert_eq!(kakao.left,-2560);
            assert_eq!(kakao.width(),588);
            assert_eq!(main.left-kakao.right,12);
            assert_eq!(kakao_width(420,1.5),588);
            assert_eq!(kakao_width(900,1.0),620);
            assert!(main.width()>=1536);
            assert_eq!(main.right,0);
            assert!(split_rect(Rect{left:0,top:0,right:1920,bottom:1080},
                420,1.5).is_err());
            assert!(split_rect(work,420,f64::NAN).is_err());
        }

        #[test] fn split_layout_reserves_main_minimum(){
            let area=Rect{left:0,top:0,right:1920,bottom:1040};
            let (left,right)=split_rect(area,420,1.0).unwrap();
            assert_eq!(left.width(),420);
            assert!(right.width()>=1024);
            assert!(split_rect(Rect{left:0,top:0,right:1280,bottom:1000},420,1.0).is_err());
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
        return Status{active:true,mode:s.mode.name(),
            ratio:native::measured_ratio(&s).unwrap_or(0.8),
            handle:Some(format!("{:016X}",s.hwnd as usize)),
            notice:None,selection_required:false}
    }
    let _=inner;
    inactive()
}
fn start(app:&AppHandle,inner:&mut Inner,handle:&str)->Result<Status,String>{
    #[cfg(windows)]
    {
        let region=inner.region.ok_or("도킹 영역의 크기를 아직 확인하지 못했습니다.")?;
        // A stale/invalid target must never disconnect the current session.
        // Selecting the current window again is idempotent: never capture
        // its already-docked bounds as the new original placement.
        if let Some(current)=inner.session {
            if format!("{:016X}",current.hwnd as usize)==handle {
                if native::live(&current) { return Ok(status(inner)); }
                inner.session=None;
                return Err("기존 카카오톡 창이 종료됐습니다. 창 목록을 다시 확인하세요.".into());
            }
        }
        let mut session=native::attach(native::main_window(app)?,handle)?;
        native::preserve_original(&mut session,&inner.tracked);
        let previous=inner.session.take();
        let previous_tracked=std::mem::take(&mut inner.tracked);
        let previous_active=inner.active_chat.take();
        for t in &previous_tracked { native::restore_related(
            &mut vec![*t], &mut None,
        ); }
        if let Some(old)=previous { native::restore(&old); }
        if let Err(e)=native::overlap(&mut session,app,region){
            native::restore(&session);
            // Best-effort rollback: a failed switch should not discard an
            // otherwise healthy previous docking session.
            if let Some(mut old)=previous {
                let rollback=match old.mode {
                    native::Mode::Overlap=>native::overlap(&mut old,app,region),
                    native::Mode::Stack=>native::stack(&mut old,app),
                };
                if rollback.is_ok(){
                    inner.session=Some(old);
                    inner.tracked=previous_tracked;
                    inner.active_chat=previous_active;
                    if let Some(current)=inner.session {
                        let _=native::sync_related(&current,&mut inner.tracked,
                            &mut inner.active_chat,app,inner.region);
                    }
                }else{native::restore(&old);}
            }
            return Err(e)
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
            native::restore_related(&mut inner.tracked,&mut inner.active_chat);
            native::restore(&session);
            let mut s=inactive();s.notice=Some("카카오톡 창 연결이 해제되었습니다.".into());
            return Ok(s)
        }
        let mut session=session;
        let error=native::sync(&mut session,&app,inner.region)
            .and_then(|()|native::sync_related(&session,&mut inner.tracked,
                &mut inner.active_chat,&app,inner.region)).err();
        inner.session=Some(session);
        if let Some(reason)=error {
            let mut response=status(&inner);
            response.notice=Some(format!("카카오톡 창 위치 동기화 실패: {reason}"));
            return Ok(response);
        }
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
            if !native::live(&session){
                native::restore_related(&mut inner.tracked,&mut inner.active_chat);
                native::restore(&session);return Ok(inactive())
            }
            if session.mode==native::Mode::Overlap{
                if let Err(e)=native::stack(&mut session,&app){inner.session=Some(session);return Err(e)}
                let _=native::sync_related(&session,&mut inner.tracked,
                    &mut inner.active_chat,&app,inner.region);
                inner.session=Some(session);return Ok(status(&inner))
            }
            native::restore_related(&mut inner.tracked,&mut inner.active_chat);
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
    #[cfg(windows)]{
        native::restore_related(&mut inner.tracked,&mut inner.active_chat);
        if let Some(s)=inner.session.take(){native::restore(&s);}
    }
    #[cfg(not(windows))]{inner.session=None;}
    Ok(inactive())
}
#[tauri::command]
pub fn dock_region_native(app:AppHandle,dock:State<'_,Dock>,region:Region)->Result<(),String>{
    let mut inner=lock(&dock)?;
    if region.width>=100.0&&region.height>=100.0
        &&region.width<=10000.0&&region.height<=10000.0
        &&region.x.abs()<=10000.0&&region.y.abs()<=10000.0
        &&[region.x,region.y,region.width,region.height].iter().all(|v|v.is_finite()){
        inner.region=Some(region);
    }
    #[cfg(windows)]if let Some(mut s)=inner.session{
        if native::live(&s) {
            let result=native::sync(&mut s,&app,inner.region)
                .and_then(|()|native::sync_related(&s,&mut inner.tracked,
                    &mut inner.active_chat,&app,inner.region));
            inner.session=Some(s);
            result?;
        }
    }
    #[cfg(not(windows))]{let _=app;}
    Ok(())
}
pub fn restore_on_exit(dock:&Dock){
    if let Ok(mut inner)=lock(dock){
        #[cfg(windows)]{
            native::restore_related(&mut inner.tracked,&mut inner.active_chat);
            if let Some(s)=inner.session.take(){native::restore(&s);}
        }
        #[cfg(not(windows))]{inner.session=None;}
    }
}
