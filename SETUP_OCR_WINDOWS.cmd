@echo off
setlocal
chcp 65001 >nul
set "OCR_ROOT=%LOCALAPPDATA%\BandoHub\OCR"
set "PYEXE=%OCR_ROOT%\venv\Scripts\python.exe"
echo BANDO HUB local OCR initial setup...
where py >nul 2>nul
if errorlevel 1 goto missing_python
py -3.11 -c "import sys; assert sys.version_info[:2] == (3, 11)" >nul 2>nul
if errorlevel 1 goto missing_python
if not exist "%OCR_ROOT%" mkdir "%OCR_ROOT%"
if errorlevel 1 goto failed
py -3.11 -m venv "%OCR_ROOT%\venv"
if errorlevel 1 goto failed
"%PYEXE%" -m pip install --upgrade pip
if errorlevel 1 goto failed
"%PYEXE%" -m pip install paddlepaddle==3.2.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
if errorlevel 1 goto failed
"%PYEXE%" -m pip install paddleocr==3.2.0
if errorlevel 1 goto failed
echo Downloading Korean PP-OCRv5 models for local use...
"%PYEXE%" -c "from paddleocr import PaddleOCR; PaddleOCR(lang='korean', ocr_version='PP-OCRv5', text_detection_model_name='PP-OCRv5_mobile_det', text_recognition_model_name='korean_PP-OCRv5_mobile_rec', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False, device='cpu')"
if errorlevel 1 goto failed
echo SUCCESS: Local PaddleOCR is ready.
pause
exit /b 0
:missing_python
echo Python 3.11 x64 is required. Install it before running this script.
pause
exit /b 1
:failed
echo OCR setup did not complete. Review the error messages above.
pause
exit /b 1
