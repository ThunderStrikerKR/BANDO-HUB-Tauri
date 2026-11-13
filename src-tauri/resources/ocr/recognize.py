"""BANDO HUB offline Korean PP-OCRv5, independent of non-ASCII install paths."""
import json
import os
from contextlib import contextmanager
from pathlib import Path
import shutil
import sys
import tempfile

DETECTION = "PP-OCRv5_mobile_det"
RECOGNITION = "korean_PP-OCRv5_mobile_rec"
REQUIRED = ("inference.json", "inference.pdiparams", "inference.yml")


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


def validate_model_folder(folder):
    missing = [item for item in REQUIRED if not (folder / item).is_file()]
    if missing:
        raise RuntimeError(
            f"OCR 모델 파일 누락: {folder.name} / {', '.join(missing)}"
        )


def is_ascii_path(path):
    try:
        os.fspath(path).encode("ascii")
        return True
    except UnicodeEncodeError:
        return False


@contextmanager
def compatible_model_folders(root):
    det = root / DETECTION
    rec = root / RECOGNITION
    validate_model_folder(det)
    validate_model_folder(rec)

    if is_ascii_path(det) and is_ascii_path(rec):
        yield det, rec
        return

    # PaddlePaddle's Windows inference C++ file loader can fail to open
    # inference.json from a directory whose path contains Korean characters.
    # Stage *only public model weights* under the standard ASCII Public path.
    # Never copy captured screenshots or any customer text into Public.
    public = Path(os.environ.get("PUBLIC") or
                  (os.environ.get("SystemDrive", "C:") + r"\Users\Public"))
    if not is_ascii_path(public) or not public.is_dir():
        raise RuntimeError("OCR 모델용 Windows 공용 영문 경로를 찾을 수 없습니다.")
    try:
        with tempfile.TemporaryDirectory(prefix="bando-ocr-model-", dir=public) as temp_dir:
            staging = Path(temp_dir)
            det_copy = staging / DETECTION
            rec_copy = staging / RECOGNITION
            shutil.copytree(det, det_copy)
            shutil.copytree(rec, rec_copy)
            validate_model_folder(det_copy)
            validate_model_folder(rec_copy)
            yield det_copy, rec_copy
    except OSError as exc:
        raise RuntimeError(
            "한글 경로 호환용 OCR 모델 임시 폴더를 만들지 못했습니다: "
            + str(exc)
        ) from exc


def make_pipeline(detection_dir, recognition_dir):
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
    root_value = os.environ.get("BANDO_OCR_MODEL_ROOT")
    if not root_value:
        raise RuntimeError("반도허브에 포함된 OCR 모델 경로가 없습니다.")
    from PIL import Image
    import numpy as np
    # Avoid OpenCV's Windows Unicode filename issue for captured BMP images.
    # PaddleOCR accepts a BGR NumPy image, eliminating native file path IO.
    with Image.open(sys.argv[1]) as image:
        pixels = np.asarray(image.convert("RGB"))[:, :, ::-1].copy()
    with compatible_model_folders(Path(root_value).resolve()) as (det, rec):
        text = extract(make_pipeline(det, rec).predict(pixels))
    print("BANDO_OCR_RESULT=" + json.dumps({"text": text}, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("BANDO_OCR_ERROR=" + str(exc), file=sys.stderr, flush=True)
        sys.exit(1)
