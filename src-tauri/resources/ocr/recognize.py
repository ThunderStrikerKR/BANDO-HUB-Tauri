"""BANDO HUB offline Korean PP-OCRv5. Uses ONLY bundled model folders."""
import json
import os
from pathlib import Path
import sys

DETECTION = "PP-OCRv5_mobile_det"
RECOGNITION = "korean_PP-OCRv5_mobile_rec"

def extract(predictions):
    lines = []
    for page in predictions:
        record = page.json
        if not isinstance(record, dict):
            continue
        section = record.get("res", record)
        if not isinstance(section, dict):
            continue
        for line in section.get("rec_texts", []):
            if isinstance(line, str) and line.strip():
                lines.append(line.strip())
    return "\n".join(lines)

def make_pipeline():
    root_value = os.environ.get("BANDO_OCR_MODEL_ROOT")
    if not root_value:
        raise RuntimeError("반도허브에 포함된 OCR 모델 경로가 없습니다.")
    root = Path(root_value).resolve()
    detection_dir = root / DETECTION
    recognition_dir = root / RECOGNITION
    if not detection_dir.is_dir() or not recognition_dir.is_dir():
        raise RuntimeError("반도허브 OCR 모델 파일이 누락되었습니다.")
    from paddleocr import PaddleOCR
    return PaddleOCR(
        lang="korean",
        ocr_version="PP-OCRv5",
        text_detection_model_name=DETECTION,
        text_detection_model_dir=str(detection_dir),
        text_recognition_model_name=RECOGNITION,
        text_recognition_model_dir=str(recognition_dir),
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
    )

def main():
    if len(sys.argv) != 2:
        raise ValueError("OCR 이미지 경로 누락")
    text = extract(make_pipeline().predict(sys.argv[1]))
    print("BANDO_OCR_RESULT=" + json.dumps({"text": text}, ensure_ascii=True), flush=True)

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("BANDO_OCR_ERROR=" + str(exc), file=sys.stderr, flush=True)
        sys.exit(1)
