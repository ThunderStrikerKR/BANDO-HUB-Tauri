import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const source = read("src/SourceDocument.tsx");
const bridge = read("src/tauri-bridge.ts");
const lib = read("src-tauri/src/lib.rs");
const ocr = read("src-tauri/src/ocr.rs");
const script = read("src-tauri/resources/ocr/recognize.py");
test("source header has four intake controls and no duplicated buttons below", () => {
  assert.match(source, /source-heading-actions/);
  for (const label of ["대리발송", "대리점 납품", "직접 입력", "캡처 범위 지정"])
    assert.ok(source.includes(label), label);
  assert.equal((source.match(/<button disabled=\{busy\} onClick=\{\(\) => void paste\(undefined, "AGENCY"\)\}>/g) ?? []).length, 1);
});
test("OCR result requires user review before replacing a provisional order", () => {
  assert.match(source, /confirmAction\("기존 미확정 원문/);
  assert.match(source, /replaceReception\(order, raw\)/);
  assert.match(source, /setOcrResult\(null\)/);
  assert.match(source, /if \(formal\) return/);
  assert.doesNotMatch(ocr, /state_save/);
});
test("Windows local PP-OCRv5 uses new clipboard images only", () => {
  assert.match(lib, /ocr::capture_ocr/);
  assert.match(bridge, /invoke<OcrCapture>\("capture_ocr"\)/);
  assert.match(ocr, /GetClipboardSequenceNumber/);
  assert.ok(ocr.includes('include_str!("../resources/ocr/recognize.py")'));
  assert.match(script, /ocr_version="PP-OCRv5"/);
  assert.match(script, /lang="korean"/);
});

test("OCR progress is shown prominently over the source body and never replaces button text", () => {
  const css = read("src/styles/receipt-document.css");
  assert.match(source, /const \[ocrBusy, setOcrBusy\] = useState\(false\)/);
  assert.match(source, /setOcrBusy\(true\)/);
  assert.match(source, /setOcrBusy\(false\)/);
  assert.match(source, /className="source-ocr-progress"/);
  assert.match(source, /<strong>OCR 처리 중…<\/strong>/);
  assert.match(source, /<button disabled=\{busy\} onClick=\{\(\) => void captureOcr\(\)\}>\s*캡처 범위 지정\s*<\/button>/);
  assert.doesNotMatch(source, /\{busy \? "처리 중…"/);
  assert.match(css, /\.source-pane \.source-ocr-progress\s*\{[\s\S]*?position: absolute/);
});
