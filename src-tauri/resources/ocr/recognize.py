"""BANDO HUB local OCR subprocess. Prints one machine-readable result line."""
import json
import sys

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

def main():
    if len(sys.argv) != 2:
        raise ValueError("OCR 이미지 경로 누락")
    from paddleocr import PaddleOCR
    model = PaddleOCR(
        lang="korean",
        ocr_version="PP-OCRv5",
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="korean_PP-OCRv5_mobile_rec",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
    )
    text = extract(model.predict(sys.argv[1]))
    print("BANDO_OCR_RESULT=" + json.dumps({"text": text}, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("BANDO_OCR_ERROR=" + str(exc), file=sys.stderr, flush=True)
        sys.exit(1)
