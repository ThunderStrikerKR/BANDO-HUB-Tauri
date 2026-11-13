//! Windows per-session single-instance guard for BANDO HUB.
//!
//! The live app and the isolated developer TEST app must be allowed to run
//! side-by-side. The standard application-wide single-instance plugin would
//! reject the TEST child process, so each mode has its own named Windows
//! mutex and activation event. No production SQLite handle is opened by a
//! rejected second launch.
use std::{env, fs::{self, File, OpenOptions}, io, os::windows::fs::OpenOptionsExt, path::PathBuf};
use tauri::{AppHandle, Manager};

type Handle = isize;
const ERROR_ALREADY_EXISTS: u32 = 183;
const WAIT_OBJECT_0: u32 = 0;
const INFINITE: u32 = u32::MAX;
const ERROR_SHARING_VIOLATION: i32 = 32;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateMutexW(attributes: isize, initially_owned: i32, name: *const u16) -> Handle;
    fn CreateEventW(attributes: isize, manual_reset: i32, initial_state: i32, name: *const u16) -> Handle;
    fn SetEvent(event: Handle) -> i32;
    fn WaitForSingleObject(object: Handle, milliseconds: u32) -> u32;
    fn GetLastError() -> u32;
    fn CloseHandle(handle: Handle) -> i32;
}

fn os_error(action: &str) -> String {
    format!("{action}: {}", io::Error::last_os_error())
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn mode_namespace(test_workspace: bool) -> &'static str {
    if test_workspace {
        "BANDO_HUB_TAURI_DEVELOPER_TEST"
    } else {
        "BANDO_HUB_TAURI_PRODUCTION"
    }
}

/// Holding both Windows handles and the exclusive file lock keeps this
/// workspace mode reserved for the entire Tauri process lifetime.
pub(super) struct InstanceGuard {
    mutex: Handle,
    activate_event: Handle,
    // An independent user-scoped Windows file lock protects against duplicate
    // launches even if a future build changes the mutex namespace.
    _file_lock: File,
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.mutex);
            CloseHandle(self.activate_event);
        }
    }
}

pub(super) enum Acquisition {
    First(InstanceGuard),
    Existing,
}

fn acquire_file_lock(namespace: &str) -> Result<File, io::Error> {
    let root = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA is unavailable"))?
        .join("BANDO-HUB").join("instance-locks");
    fs::create_dir_all(&root)?;
    // 0 = no file sharing. Windows releases this exclusive handle
    // automatically when the process exits; the file itself may remain.
    OpenOptions::new().read(true).write(true).create(true)
        .share_mode(0)
        .open(root.join(format!("{namespace}.lock")))
}

fn acquire_namespace(namespace: &str) -> Result<Acquisition, String> {
    // "Local\\" scopes the objects to the current Windows session. Production
    // and TEST objects never share a name.
    let event_name = wide(&format!("Local\\{namespace}_ACTIVATE"));
    let mutex_name = wide(&format!("Local\\{namespace}_MUTEX"));
    let event = unsafe { CreateEventW(0, 0, 0, event_name.as_ptr()) };
    if event == 0 {
        return Err(os_error("기존 창 활성화 이벤트 생성 실패"));
    }
    let mutex = unsafe { CreateMutexW(0, 0, mutex_name.as_ptr()) };
    // GetLastError MUST be captured immediately after CreateMutexW.
    let mutex_error = unsafe { GetLastError() };
    if mutex == 0 {
        let error = os_error("중복 실행 잠금 생성 실패");
        unsafe { CloseHandle(event); }
        return Err(error);
    }
    if mutex_error == ERROR_ALREADY_EXISTS {
        // The primary app may still be initializing. The auto-reset event
        // remains signalled until its activation listener starts waiting.
        let notified = unsafe { SetEvent(event) };
        let failure = if notified == 0 {
            Some(os_error("기존 반도허브 창 활성화 요청 실패"))
        } else {
            None
        };
        unsafe {
            CloseHandle(mutex);
            CloseHandle(event);
        }
        return match failure {
            Some(error) => Err(error),
            None => Ok(Acquisition::Existing),
        };
    }
    let file_lock = match acquire_file_lock(namespace) {
        Ok(file) => file,
        Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION) => {
            // Another instance may hold a lock from a differently configured
            // native mutex. Reject this launch without ever opening SQLite.
            let _ = unsafe { SetEvent(event) };
            unsafe {
                CloseHandle(mutex);
                CloseHandle(event);
            }
            return Ok(Acquisition::Existing);
        }
        Err(error) => {
            unsafe {
                CloseHandle(mutex);
                CloseHandle(event);
            }
            return Err(format!("중복 실행 파일 잠금 생성 실패: {error}"));
        }
    };
    Ok(Acquisition::First(InstanceGuard {
        mutex,
        activate_event: event,
        _file_lock: file_lock,
    }))
}

/// Must be called before creating the Tauri builder or opening SQLite.
/// A duplicate process exits before a second native window or DB connection.
pub(super) fn acquire(test_workspace: bool) -> Result<Acquisition, String> {
    acquire_namespace(mode_namespace(test_workspace))
}

/// Listen in the first instance for duplicate launch notifications. Never
/// changes the active page or form state: only restores and focuses the window.
pub(super) fn listen(guard: InstanceGuard, app: AppHandle) -> Result<(), String> {
    let event = guard.activate_event;
    // IMPORTANT: Guard ownership belongs to the application, not the
    // activation-listener thread. An event wait failure must never allow a
    // second process to start while the first Tauri window is still alive.
    if !app.manage(guard) {
        return Err("중복 실행 잠금 상태 등록 실패".into());
    }
    std::thread::Builder::new()
        .name("bando-single-instance-activation".into())
        .spawn(move || {
            loop {
                if unsafe { WaitForSingleObject(event, INFINITE) } != WAIT_OBJECT_0 {
                    eprintln!("반도허브 기존 창 활성화 이벤트 수신 실패");
                    break;
                }
                let target = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    if let Some(window) = target.get_webview_window("main") {
                        // Minimised and hidden windows require show/unminimise
                        // before set_focus. Never create an additional window.
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }) {
                    eprintln!("반도허브 기존 창 활성화 실패: {error}");
                }
            }
        })
        .map(|_| ())
        .map_err(os_error_from_thread)
}

fn os_error_from_thread(error: io::Error) -> String {
    format!("중복 실행 활성화 수신기 시작 실패: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn unique_namespace(label: &str) -> String {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let id = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        format!("BANDO_HUB_SINGLE_TEST_{label}_{}_{now}_{id}", std::process::id())
    }

    #[test]
    fn duplicate_launch_is_rejected_and_signals_the_first_window() {
        let namespace = unique_namespace("DUPLICATE");
        let first = match acquire_namespace(&namespace).unwrap() {
            Acquisition::First(guard) => guard,
            Acquisition::Existing => panic!("첫 실행이 중복으로 감지됐습니다"),
        };
        assert!(matches!(
            acquire_namespace(&namespace).unwrap(),
            Acquisition::Existing
        ));
        assert_eq!(unsafe { WaitForSingleObject(first.activate_event, 0) }, WAIT_OBJECT_0);
        drop(first);
        assert!(matches!(
            acquire_namespace(&namespace).unwrap(),
            Acquisition::First(_)
        ), "첫 실행이 종료된 뒤 잠금이 해제돼야 합니다");
    }

    #[test]
    fn production_and_developer_modes_have_independent_namespaces() {
        assert_ne!(mode_namespace(false), mode_namespace(true));
        let production = unique_namespace("PRODUCTION");
        let test = unique_namespace("DEVELOPER");
        let primary = acquire_namespace(&production).unwrap();
        let isolated = acquire_namespace(&test).unwrap();
        assert!(matches!(&primary, Acquisition::First(_)));
        assert!(matches!(&isolated, Acquisition::First(_)));
        assert!(matches!(acquire_namespace(&production).unwrap(), Acquisition::Existing));
        assert!(matches!(acquire_namespace(&test).unwrap(), Acquisition::Existing));
    }

    #[test]
    fn concurrent_launches_only_allow_one_first_instance() {
        let namespace = unique_namespace("PARALLEL");
        let primary = acquire_namespace(&namespace).unwrap();
        assert!(matches!(&primary, Acquisition::First(_)));
        let threads: Vec<_> = (0..12).map(|_| {
            let name = namespace.clone();
            std::thread::spawn(move || matches!(
                acquire_namespace(&name).unwrap(), Acquisition::Existing
            ))
        }).collect();
        assert!(threads.into_iter().all(|thread| thread.join().unwrap()));
    }
}
