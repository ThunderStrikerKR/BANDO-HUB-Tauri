"""Verify the *relocated* packaged OCR with the same flags as Tauri runtime.

Uses the bundled interpreter, installed packages, Korean models and a real
synthetic BMP. No employee Python or real customer data is read.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

def main():
    if len(sys.argv) != 3:
        raise ValueError("Expected <OCR bundle directory> <recognize.py path>")
    root = Path(sys.argv[1]).resolve()
    entry = Path(sys.argv[2]).resolve()
    python = root / "runtime" / "python.exe"
    models = root / "models"
    for path in (
        python,
        entry,
        models / "PP-OCRv5_mobile_det",
        models / "korean_PP-OCRv5_mobile_rec",
    ):
        if not path.exists():
            raise RuntimeError(f"Bundled OCR component missing: {path}")

    # External Python settings cannot affect this process or its child.
    env = dict(os.environ)
    for key in ("PYTHONHOME", "PYTHONPATH"):
        env.pop(key, None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["BANDO_OCR_MODEL_ROOT"] = str(models)
    with tempfile.TemporaryDirectory(prefix="bando-ocr-smoke-") as work:
        env["PADDLE_PDX_CACHE_HOME"] = str(Path(work) / "new-model-cache")
        from PIL import Image, ImageDraw
        image = Path(work) / "검증-한글.bmp"
        picture = Image.new("RGB", (960, 220), "white")
        ImageDraw.Draw(picture).text((28, 70), "BANDO 709 1234", fill="black", stroke_width=1)
        picture.save(image)
        code = entry.read_text(encoding="utf-8")
        args = [str(python), "-I", "-B", "-X", "utf8", "-c", code, str(image)]
        result = subprocess.run(args, cwd=root, env=env,
                                capture_output=True, timeout=180, check=False)
        stdout = result.stdout.decode("utf-8", errors="replace")
        stderr = result.stderr.decode("utf-8", errors="replace")
        if result.returncode != 0:
            detail = stderr.strip()[-1800:] or stdout.strip()[-800:]
            raise RuntimeError(f"Packaged OCR subprocess exited with "
                               f"{result.returncode}: {detail}")
        output = next((line.partition("BANDO_OCR_RESULT=")[2]
                       for line in reversed(stdout.splitlines())
                       if line.startswith("BANDO_OCR_RESULT=")), None)
        if output is None:
            raise RuntimeError("OCR subprocess returned no result marker. "
                               + stderr.strip()[-600:])
        recognized = json.loads(output)["text"]
        if not isinstance(recognized, str) or not recognized.strip():
            raise RuntimeError("OCR failed to recognize test text")
        print("PASS: relocated Korean PP-OCRv5 bundle inferred the BMP successfully.")

if __name__ == "__main__":
    main()
