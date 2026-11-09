import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const native = read("src-tauri/src/ocr.rs");
const runner = read("src-tauri/resources/ocr/recognize.py");
const bundle = read("scripts/package-ocr-runtime.ps1");
const provision = read("scripts/prepare-ocr-bundle.py");
const build = read("BUILD_WINDOWS_TAURI.cmd");
const ci = read(".github/workflows/verify-tauri.yml");
const legacy = read("SETUP_OCR_WINDOWS.cmd");
const portableVerifier = read("scripts/verify-portable-ocr.py");
const verifierScript = read("scripts/verify-packaged-ocr.ps1");
const source = read("src/SourceDocument.tsx");

test("employee Python is never used by OCR", () => {
  assert.match(native, /std::env::current_exe\(\)/);
  assert.match(native, /app_dir\.join\("ocr"\)/);
  assert.match(native, /join\("runtime"\)\.join\("python\.exe"\)/);
  assert.match(native, /env\("BANDO_OCR_MODEL_ROOT", &models\)/);
  assert.match(native, /env_remove\("PYTHONPATH"\)/);
  assert.ok(native.includes('arg("-X").arg("utf8")'));
  assert.doesNotMatch(native, /std::env::var_os\("LOCALAPPDATA"\)|join\("venv"\)|SETUP_OCR_WINDOWS/);
  assert.match(native, /ocr 폴더를 함께 보관하세요/);
});

test("offline OCR demands local Korean PP-OCRv5 model directories", () => {
  assert.match(runner, /BANDO_OCR_MODEL_ROOT/);
  assert.match(runner, /text_detection_model_dir/);
  assert.match(runner, /text_recognition_model_dir/);
  assert.match(runner, /korean_PP-OCRv5_mobile_rec/);
  assert.match(runner, /raise RuntimeError/);
  assert.doesNotMatch(runner, /model_download|requests\.get/);
});

test("build creates portable private Python runtime and fetches models", () => {
  assert.match(bundle, /python-3\.11\.9-embed-amd64\.zip/);
  assert.match(bundle, /python311\._pth/);
  assert.match(bundle, /Lib\\site-packages/);
  assert.match(bundle, /paddlepaddle==3\.2\.0/);
  assert.match(bundle, /paddleocr==3\.2\.0/);
  assert.match(bundle, /prepare-ocr-bundle\.py/);
  assert.match(provision, /text_detection_model_dir/);
  assert.match(provision, /text_recognition_model_dir/);
  assert.match(provision, /model\.predict|model\.predict/);
  assert.ok(!legacy.includes("py -3.11"));
});

test("release and CI never publish standalone EXE without OCR", () => {
  assert.match(build, /ensure-ocr-package\.ps1/);
  assert.match(read("scripts/ensure-ocr-package.ps1"), /package-ocr-runtime\.ps1/);
  assert.match(build, /release\\ocr\.next/);
  assert.match(build, /release\\ocr/);
  assert.match(build, /BANDO-HUB-portable\.zip/);
  assert.match(ci, /BANDO-HUB-portable\.zip/);
  assert.match(ci, /package-ocr-runtime\.ps1/);
  assert.doesNotMatch(ci, /BANDO-HUB-Tauri-v0\.0\.4-Windows-unsigned-test/);
  assert.match(ci, /Validate offline OCR from the extracted ZIP/);
  assert.match(read("scripts/ensure-ocr-package.ps1"), /verify-packaged-ocr\.ps1/);
  assert.match(verifierScript, /verify-portable-ocr\.py/);
  assert.match(portableVerifier, /subprocess\.run/);
  assert.match(portableVerifier, /BANDO_OCR_RESULT=/);
  assert.match(portableVerifier, /-I", "-B", "-X", "utf8"/);
});
test("native OCR failures expose Windows exit codes and copyable details", () => {
  assert.match(native, /fn describe_ocr_failure/);
  assert.match(native, /0xC0000135/);
  assert.match(native, /String::from_utf8_lossy/);
  assert.match(source, /OCR 실행 오류/);
  assert.match(source, /오류 내용 복사/);
});

test("Paddle native OCR loads models through ASCII staging when installed under Korean folders", () => {
  const source = read("src-tauri/resources/ocr/recognize.py");
  const prep = read("scripts/prepare-ocr-bundle.py");
  assert.match(source, /def compatible_model_folders\(root\):/);
  assert.match(source, /def is_ascii_path\(path\):/);
  assert.match(source, /tempfile\.TemporaryDirectory\(prefix="bando-ocr-model-", dir=public\)/);
  assert.match(source, /shutil\.copytree\(det, det_copy\)/);
  assert.match(source, /shutil\.copytree\(rec, rec_copy\)/);
  assert.match(source, /with Image\.open\(sys\.argv\[1\]\) as image:/);
  assert.match(source, /\.predict\(pixels\)/);
  for (const required of ["inference.json","inference.pdiparams","inference.yml"]) {
    assert.ok(source.includes(required), required);
    assert.ok(prep.includes(required), required);
  }
  assert.match(ci, /반도허브-한글경로-검증/);
});
