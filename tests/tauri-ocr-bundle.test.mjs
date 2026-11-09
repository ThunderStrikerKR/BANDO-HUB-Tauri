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
  assert.match(build, /package-ocr-runtime\.ps1/);
  assert.match(build, /release\\ocr\.next/);
  assert.match(build, /release\\ocr/);
  assert.match(build, /BANDO-HUB-portable\.zip/);
  assert.match(ci, /BANDO-HUB-portable\.zip/);
  assert.match(ci, /package-ocr-runtime\.ps1/);
  assert.doesNotMatch(ci, /BANDO-HUB-Tauri-v0\.0\.4-Windows-unsigned-test/);
});
