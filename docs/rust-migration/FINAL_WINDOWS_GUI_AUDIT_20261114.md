# TSBH 실제 Windows GUI / SQLite 통합 감사 — 2026-11-14 (KST)

**판정: 부분 통과 / 최종 실사용 GUI 승인 보류.** 소스 변경 없이 감사 스크립트만 격리 브랜치에서 수정했다.

## 정확한 대상과 안전 경계

- 앱 소스: `migration/03-integration` / `3eca217fe2a045e25c6caf0cbedb0bdd234a9afb`
- 바이너리: 해당 커밋에서 제작한 Windows Portable ZIP, Actions [43460648913](https://github.com/ThunderStrikerKR/TSBH/actions/runs/43460648913)
- GUI 감사 실행: Windows `windows-latest`의 실제 `bando_hub.exe` + WebView2 + UIAutomation. Vite 가상 페이지나 모의 IPC를 실제 GUI로 취급하지 않는다.
- 안전: 일회용 GitHub Windows runner에서 실제 네이티브 앱 실행. 개발자 `--bando-developer-test` 모드의 격리 SQLite만 사용. 실제 운영 DB 및 사용자의 Windows PC에는 접근하지 않는다.
- 감사 수행 브랜치: `audit/windows-e2e-final-20261114`. `main`, `migration/03-integration`, 실제 제품 Rust/React 소스는 수정하지 않았다.

## 실측 통과 증거

최신 감사 실행 [43531360442](https://github.com/ThunderStrikerKR/TSBH/actions/runs/43531360442)의 [원본 증거 ZIP](https://github.com/ThunderStrikerKR/TSBH/actions/runs/43531360442/artifacts/14087717613)에는 화면 캡처 36장 및 `native-uia-audit.json`이 들어 있다.

- 8개 주 메뉴(접수, 주문 내역, 엑셀 관리, 일일 결산, 상품 관리, 운임 관리, 거래처 관리, 설정) 실제 native UIA 탐색 및 캡처.
- Excel·상품·운임·거래처·설정의 하위 탭 탐색. 빈 데이터, 검색창, 헤더, 표, 경고 UI 표시를 캡처.
- 설정 편집 없이 '설정 저장': SQLite `revision=1` 유지 — **PASS**.
- Windows UIA로 '작업자 이름' 수정 후 실제 '설정 저장': 별도 Python SQLite 읽기로 `revision=2`, 저장된 `operatorName` 확인 — **PASS**.
- '상품 관리'로 이동 후 설정 재진입: 실제 설정 입력창에서 `CI-Windows-UIA-검수` 값 복원, `UIA ValuePattern` 결과와 스크린샷에서 확인 — **PASS**.
- SQLite 읽기는 WebView2에서 반환한 React 상태를 검증 결과로 재활용하지 않고, 운영과 격리된 DB에 별도 프로세스로 접속했다.
- 소스 통합 CI는 별개: [43460648799](https://github.com/ThunderStrikerKR/TSBH/actions/runs/43460648799) 프런트엔드 505 통과·0 실패·2 제외, [43460648839](https://github.com/ThunderStrikerKR/TSBH/actions/runs/43460648839) Windows Rust 131 통과·0 실패·1 무시. **이 CI 숫자는 GUI 업무 흐름 테스트 숫자가 아니다.**

## 실제 GUI 미통과 항목

**거래처 신규 등록 — 미통과/원인 미확정.**

최신 감사 [43531360442](https://github.com/ThunderStrikerKR/TSBH/actions/runs/43531360442)는 거래처 등록 모달까지 실제로 열었다. UIA가 거래처명, 거래처 주소, 전화번호 Edit의 위치를 수집해 마우스 클릭·클립보드 입력을 시도했지만, `36-edit-거래처-필수정보-작성.png` 화면에서 **세 필드가 모두 빈 상태**였다. '거래처 등록'을 눌러도 `core_clients`에 신규 행이 들어오지 않아 **FAIL**. 이 결과만으로 앱의 저장 로직 오류라고 결론 내리지 않는다. 먼저 실제 Windows 사용자 입력으로 텍스트가 반영되는지와 모달의 React 제어값 및 필요 송하인 필드를 구분해 재현해야 한다. 테스트 환경의 UIAutomation 입력 포커스 문제일 수 있다.

앞선 감사 오류들은 앱 오류가 아닌 **감사 환경/접근성 제약**으로 구분:
- [43529439996](https://github.com/ThunderStrikerKR/TSBH/actions/runs/43529439996): 초기 Python Windows ANSI 인코딩에 의한 UnicodeEncodeError. UTF-8 환경 설정으로 해결.
- [43530002073](https://github.com/ThunderStrikerKR/TSBH/actions/runs/43530002073): WebView2 입력의 UIA ValuePattern / SetFocus 미지원. 접근성 스크롤 및 실제 컨트롤 대응 추가.
- [43530690370](https://github.com/ThunderStrikerKR/TSBH/actions/runs/43530690370): 설정 입력창의 UIA Edit 시맨틱 누락. 화면 라벨 기준 재진입 검사로 해결. 최신 실행에서는 재진입 검사 PASS.

## GUI에서 아직 검증하지 않은 업무 흐름

- 접수 원문 분석 **후 실제 주문 확인·저장·취소/수정**, 미저장 이탈과 UI 승인 검증
- 주문 진행 단계 1→2→3→4를 실제 버튼으로 수행하고 재시작 후 DB 복구
- 공장/매장 Excel **실제 파일 생성·폴더 열기**, 송장 회신 XLSX 수신·매칭
- 일일 결산의 실제 주문/입금/미수·과거 날짜 조회 결과
- 상품 수정·가격 등급·운임·거래처 변경들의 UI 저장 및 재진입
- 백업·복원, 개발자 TEST DB 격리 전환, OCR 캡처, 실제 카카오톡 도킹
- 1024×768 외 다른 모니터·Windows DPI 배율·시각적 반응형 검증

기존 Rust·SQLite·TS 차등 자동화가 일부 업무 규칙을 검증했더라도 이를 **실제 Windows GUI 전수 검증**으로 대체하지 않는다.

## 배포 판단

**Windows Portable ZIP은 빌드에 성공했지만 GUI 전수 통과와 실운영 설치 승인은 미완료.** 사용자 운영 DB를 대상으로 재현·수정하는 행동을 하지 않는다. 이후 GUI 감사는 각 작업별 실제 스크린샷과 데이터 전후값을 남기고 확인한다.
