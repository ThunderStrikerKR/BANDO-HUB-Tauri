//! Windows screen region capture with local PP-OCRv5.
//! Captures are never saved in the order database or retained after the request.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

static OCR_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrCapture {
    text: String,
    image_data_url: String,
    width: usize,
    height: usize,
}

struct RunningGuard;
impl Drop for RunningGuard {
    fn drop(&mut self) { OCR_RUNNING.store(false, Ordering::Release); }
}

#[tauri::command]
pub async fn capture_ocr() -> Result<OcrCapture, String> {
    if OCR_RUNNING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return Err("이미 OCR 캡처를 진행 중입니다.".into());
    }
    let guard = RunningGuard;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        capture_blocking()
    }).await.map_err(|e| format!("OCR 캡처 작업 중단: {e}"))?
}

#[cfg(not(windows))]
fn capture_blocking() -> Result<OcrCapture, String> {
    Err("화면 캡처 OCR은 Windows에서만 사용할 수 있습니다.".into())
}

#[cfg(windows)]
fn capture_blocking() -> Result<OcrCapture, String> {
    use base64::Engine;
    use std::{fs, io::Write, process::{Command, Stdio}, time::{Duration, Instant}};

    let (width, height, rgba) = screen_snip::snip()?;
    let count = width.checked_mul(height).and_then(|n| n.checked_mul(4))
        .ok_or("캡처 이미지의 크기를 확인할 수 없습니다.")?;
    if width == 0 || height == 0 || count > 24_000_000 || count != rgba.len() {
        return Err("캡처 범위가 너무 크거나 이미지 형식이 잘못됐습니다. 더 작은 범위를 선택해 주세요.".into());
    }
    let bmp = bmp_from_rgba(width, height, &rgba)?;
    // Locate the private, relocatable OCR runtime next to bando_hub.exe.
    // Never read the employee's system Python, PATH or old AppData venv.
    let executable = std::env::current_exe()
        .map_err(|e| format!("실행파일 위치 확인 실패: {e}"))?;
    let app_dir = executable.parent().ok_or("프로그램 설치 폴더를 찾을 수 없습니다.")?;
    let ocr_dir = app_dir.join("ocr");
    let python = ocr_dir.join("runtime").join("python.exe");
    let models = ocr_dir.join("models");
    if !python.is_file()
        || !models.join("PP-OCRv5_mobile_det").is_dir()
        || !models.join("korean_PP-OCRv5_mobile_rec").is_dir()
    {
        return Err("OCR 실행 파일 또는 한글 모델이 없습니다. 배포 ZIP을 모두 압축 해제하고 bando_hub.exe와 ocr 폴더를 함께 보관하세요.".into());
    }
    let temp = TempWorkspace::create()?;
    let input = temp.path.join("capture.bmp");
    let stdout = temp.path.join("output.txt");
    let stderr = temp.path.join("error.txt");
    fs::write(&input, &bmp).map_err(|e| format!("OCR 임시 이미지 쓰기 실패: {e}"))?;
    let mut command = Command::new(python);
    command.arg("-I").arg("-c").arg(include_str!("../resources/ocr/recognize.py")).arg(&input);
    command.current_dir(&ocr_dir)
        .env("BANDO_OCR_MODEL_ROOT", &models)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PADDLE_PDX_CACHE_HOME", temp.path.join("paddlex-cache"))
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH");
    command.stdout(Stdio::from(fs::File::create(&stdout).map_err(|e| e.to_string())?));
    command.stderr(Stdio::from(fs::File::create(&stderr).map_err(|e| e.to_string())?));
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000); // no console window
    let mut child = command.spawn().map_err(|e| format!("PaddleOCR 실행 실패: {e}"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
        if started.elapsed() > Duration::from_secs(180) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("OCR 처리 시간이 초과됐습니다. 한글 모델 설치 여부를 확인하세요.".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let out = fs::read_to_string(&stdout).map_err(|e| e.to_string())?;
    let err = fs::read_to_string(&stderr).unwrap_or_default();
    if !status.success() {
        let cause = err.lines().rev().find_map(|l| l.strip_prefix("BANDO_OCR_ERROR="))
            .unwrap_or("한글 OCR 모델 또는 Python 실행 환경을 확인해 주세요.");
        return Err(format!("OCR 인식 실패: {}", cause.chars().take(300).collect::<String>()));
    }
    let payload = out.lines().rev().find_map(|line| line.strip_prefix("BANDO_OCR_RESULT="))
        .ok_or("OCR 결과를 읽을 수 없습니다.")?;
    let json: serde_json::Value = serde_json::from_str(payload)
        .map_err(|e| format!("OCR 결과 형식 오류: {e}"))?;
    let text = json["text"].as_str().ok_or("OCR 문자열 형식 오류")?.trim().to_owned();
    Ok(OcrCapture {
        text,
        image_data_url: format!("data:image/bmp;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bmp)),
        width, height,
    })
}

#[cfg(windows)]
struct TempWorkspace { path: std::path::PathBuf }
#[cfg(windows)]
impl TempWorkspace {
    fn create() -> Result<Self, String> {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let path = std::env::temp_dir().join(format!("bando-ocr-{}-{nanos}", std::process::id()));
        std::fs::create_dir(&path).map_err(|e| format!("OCR 임시 작업공간 생성 실패: {e}"))?;
        Ok(Self { path })
    }
}
#[cfg(windows)]
impl Drop for TempWorkspace {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.path); }
}

// Uncompressed 32-bit BGRA BMP: browser image preview and OpenCV input
// without adding an image encoder dependency to the Windows executable.
#[cfg(windows)]
fn bmp_from_rgba(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let pixels = width.checked_mul(height).and_then(|n| n.checked_mul(4))
        .ok_or("이미지 크기 오류")?;
    if pixels != rgba.len() || width > i32::MAX as usize || height > i32::MAX as usize {
        return Err("이미지 픽셀 크기 오류".into());
    }
    let size = 54usize.checked_add(pixels).ok_or("이미지 파일 크기 오류")?;
    if size > u32::MAX as usize { return Err("이미지 파일이 너무 큽니다.".into()); }
    let mut bytes = Vec::with_capacity(size);
    bytes.extend_from_slice(b"BM");
    bytes.extend_from_slice(&(size as u32).to_le_bytes());
    bytes.extend_from_slice(&[0u8; 4]);
    bytes.extend_from_slice(&54u32.to_le_bytes());
    bytes.extend_from_slice(&40u32.to_le_bytes());
    bytes.extend_from_slice(&(width as i32).to_le_bytes());
    bytes.extend_from_slice(&(height as i32).to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&32u16.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&(pixels as u32).to_le_bytes());
    bytes.extend_from_slice(&[0u8; 16]);
    for y in (0..height).rev() {
        for x in 0..width {
            let i = (y * width + x) * 4;
            bytes.extend_from_slice(&[rgba[i + 2], rgba[i + 1], rgba[i], 255]);
        }
    }
    Ok(bytes)
}

#[cfg(windows)]
mod screen_snip {
    use std::time::{Duration, Instant};
    #[link(name = "user32")]
    unsafe extern "system" {
        fn keybd_event(key: u8, scan: u8, flags: u32, extra: usize);
        fn GetClipboardSequenceNumber() -> u32;
    }
    const RELEASE: u32 = 2;
    pub(super) fn snip() -> Result<(usize, usize, Vec<u8>), String> {
        let original = unsafe { GetClipboardSequenceNumber() };
        unsafe {
            keybd_event(0x5B, 0, 0, 0);  // Win
            keybd_event(0x10, 0, 0, 0);  // Shift
            keybd_event(0x53, 0, 0, 0);  // S
            keybd_event(0x53, 0, RELEASE, 0);
            keybd_event(0x10, 0, RELEASE, 0);
            keybd_event(0x5B, 0, RELEASE, 0);
        }
        // Never consume a prior clipboard image. The screenshot enters the
        // same native selection overlay as pressing Windows+Shift+S.
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(75) {
            if unsafe { GetClipboardSequenceNumber() } != original {
                if let Ok(mut clipboard) = arboard::Clipboard::new() {
                    if let Ok(image) = clipboard.get_image() {
                        return Ok((image.width, image.height, image.bytes.into_owned()));
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(180));
        }
        Err("화면 캡처가 완료되지 않았습니다. 범위를 드래그한 뒤 다시 실행해 주세요.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn busy_request_guard_releases_lock() {
        OCR_RUNNING.store(true, Ordering::Release);
        { let _guard = RunningGuard; }
        assert!(!OCR_RUNNING.load(Ordering::Acquire));
    }
    #[cfg(windows)]
    #[test]
    fn bmp_encoder_has_valid_header_and_bottom_up_bgra_pixels() {
        let out = bmp_from_rgba(1, 1, &[10, 20, 30, 255]).unwrap();
        assert_eq!(&out[..2], b"BM");
        assert_eq!(&out[54..], &[30, 20, 10, 255]);
        assert_eq!(out.len(), 58);
    }
}
