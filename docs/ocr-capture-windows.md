# 반도허브 OCR - Python 설치 없이 사용하는 배포판

## 배포 정책

- 업무용 PC에는 Python, pip, PaddleOCR를 설치하지 않습니다. 설치된 Python 3.15.2도 그대로 유지합니다.
- 한글 인식 엔진은 기존 PaddleOCR PP-OCRv5 (CPU)입니다.
- 배포 결과는 기존 실행파일명인 `bando_hub.exe`와 같은 위치의 `ocr` 폴더입니다.
- `ocr/runtime/python.exe`는 프로그램 전용 내장 Python 3.11.9입니다. 직원 PC의 PATH, Python 버전이나 AppData의 이전 가상환경과 관계없습니다.
- `ocr/models`에는 `PP-OCRv5_mobile_det`, `korean_PP-OCRv5_mobile_rec`을 빌드 시 미리 저장합니다.
- OCR은 로컬에서 실행하며 클라우드 유료 OCR API를 호출하지 않습니다. 패키지를 만든 뒤 사용하는 PC에는 OCR 모델 다운로드가 필요 없습니다.

## 직원 PC에 배포

1. `release/BANDO-HUB-portable.zip`을 전체 압축 해제합니다.
2. `bando_hub.exe`를 실행합니다. 반드시 같은 폴더에 `ocr` 디렉터리가 있어야 합니다.
3. `발주 원문`의 `캡처 범위 지정`을 누른 뒤 Windows 캡처 UI에서 범위를 선택합니다.
4. 이미지와 인식된 글자를 검토하고 필요하면 수정해 `원문 교체` 또는 `원문에 추가`를 누릅니다.
5. 확인하지 않고 `취소`하면 원문과 주문 데이터는 변경하지 않습니다.

`SETUP_OCR_WINDOWS.cmd`는 과거 버전 호환 안내만 표시하며, 이제 더는 실행할 필요가 없습니다.
기존에 실패한 `%LOCALAPPDATA%/BandoHub/OCR/venv` 설치 흔적은 새 배포판이 사용하지 않습니다. 삭제를 자동 실행하지도 않습니다.

## 개발 PC에서 배포판 만들기

Windows 64비트 개발 PC에서 `BUILD_WINDOWS_TAURI.cmd`를 실행합니다.

1. Node.js와 Rust로 Tauri EXE를 빌드합니다.
2. `scripts/package-ocr-runtime.ps1`이 별도의 64비트 CPython embeddable 압축 파일을 공식 사이트에서 다운로드합니다.
3. 해당 전용 Python 안에 `paddlepaddle==3.2.0`, `paddleocr==3.2.0`의 Windows 바이너리 패키지를 설치합니다. 개발 PC의 Python을 수정하지 않습니다.
4. `scripts/prepare-ocr-bundle.py`가 두 한글 PP-OCRv5 모델을 미리 내려받고, 복사된 모델 폴더에서 추론을 실제로 실행해 검사합니다.
5. `release/bando_hub.exe`와 `release/ocr`을 발행하고 `release/BANDO-HUB-portable.zip`을 만듭니다. 기존 프로그램과 데이터베이스를 덮어쓰지 않습니다.

**주의:** 배포판 생성 PC에서는 처음 패키징 시 인터넷 연결 및 충분한 디스크 여유 공간이 필요합니다. 다운로드 용량 및 생성 파일 크기는 실제 Windows 빌드에서 확인해야 합니다. 업무용 PC에는 별도 Python 설치 또는 모델 다운로드가 필요 없습니다.

GitHub Actions는 Windows 빌드와 동일한 OCR 생성 작업을 검증하며, 성공한 경우 전체 파일을 포함한 portable ZIP만 배포 아티팩트로 업로드합니다.

## 오류 및 데이터 보호

- `ocr` 폴더, Python 런타임 또는 모델 디렉터리가 누락되면 실행 중인 주문에는 영향을 주지 않고 복구 방법을 안내합니다.
- 임시 캡처 BMP와 OCR 출력은 자동 삭제됩니다. OCR 원문 및 이미지가 주문 DB에 자동 저장되지 않습니다.
- 기존 미확정 원문 교체 시 별도 확인을 요구합니다. 주문 확정 후에는 OCR로 원문을 변경할 수 없습니다.
- 실제 사무실 Windows 10 PC의 보안 설정, 마우스 캡처, 모델 인식률은 배포 후 실기기 검증이 필요합니다.
- 지정 폴더의 자동 OCR 감시는 이번 배포 변경 범위에 포함되지 않습니다.

기술 근거: [PaddleOCR 공식 OCR 모델 경로 가이드](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/OCR.en.md), [PaddlePaddle 3.2.0 Windows 패키지](https://pypi.org/project/paddlepaddle/3.2.0/).
