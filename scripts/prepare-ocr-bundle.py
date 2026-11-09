"""Build-time Korean PP-OCRv5 model provisioner for a relocatable package."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

DETECTION = "PP-OCRv5_mobile_det"
RECOGNITION = "korean_PP-OCRv5_mobile_rec"

def pipeline_options():
    return {
        "lang": "korean",
        "ocr_version": "PP-OCRv5",
        "text_detection_model_name": DETECTION,
        "text_recognition_model_name": RECOGNITION,
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "device": "cpu",
    }

def exercise(model, image_path):
    list(model.predict(str(image_path)))

def find_model(cache, name):
    expected = cache / "official_models" / name
    if expected.is_dir() and any(expected.iterdir()):
        return expected
    matches = [p for p in cache.rglob(name) if p.is_dir() and any(p.iterdir())]
    if len(matches) != 1:
        raise RuntimeError(f"OCR model {name!r} not found uniquely in {cache}: {matches}")
    return matches[0]

def main():
    if len(sys.argv) != 2:
        raise ValueError("Expected models destination directory")
    from paddleocr import PaddleOCR
    from PIL import Image, ImageDraw
    destination = Path(sys.argv[1]).resolve()
    cache_name = os.environ.get("PADDLE_PDX_CACHE_HOME")
    if not cache_name:
        raise RuntimeError("Isolated PaddleX build cache must be configured")
    cache = Path(cache_name).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="bando-ocr-verify-") as tmp:
        sample = Path(tmp) / "test.png"
        img = Image.new("RGB", (680, 160), "white")
        ImageDraw.Draw(img).text((20, 40), "BANDO 709 1234", fill="black")
        img.save(sample)
        print("Downloading PP-OCRv5 Korean models for the portable bundle...", flush=True)
        exercise(PaddleOCR(**pipeline_options()), sample)
        destination.mkdir(parents=True, exist_ok=True)
        for model_name in (DETECTION, RECOGNITION):
            source = find_model(cache, model_name)
            target = destination / model_name
            shutil.copytree(source, target)
            if not any(path.is_file() for path in target.rglob("*")):
                raise RuntimeError(f"Bundled OCR model {model_name} is empty")
        print("Verifying copied models with actual offline inference...", flush=True)
        local = pipeline_options()
        local["text_detection_model_dir"] = str(destination / DETECTION)
        local["text_recognition_model_dir"] = str(destination / RECOGNITION)
        exercise(PaddleOCR(**local), sample)
    details = {
        "engine": "PaddleOCR 3.2.0 / PaddlePaddle 3.2.0 CPU",
        "runtime": "Embedded CPython 3.11.9 x64",
        "models": [DETECTION, RECOGNITION],
        "employee_python_required": False,
    }
    (destination.parent / "bundle-info.json").write_text(
        json.dumps(details, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("Portable OCR verification passed.", flush=True)

if __name__ == "__main__":
    main()
