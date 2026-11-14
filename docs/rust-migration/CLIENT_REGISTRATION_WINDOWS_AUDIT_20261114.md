# 거래처 등록 Windows 입력/저장 실패 원인 분리 — 2026-11-14

기준 앱 소스: `migration/03-integration` @ `3eca217fe2a045e25c6caf0cbedb0bdd234a9afb` (테스트 외 앱 소스 변경 없음).

## 3-5 원본 감사 인계

- 원본 Windows GUI 감사 브랜치: `audit/windows-e2e-final-20261114`.
- [원본 기록](https://github.com/ThunderStrikerKR/TSBH/blob/audit/windows-e2e-final-20261114/docs/rust-migration/FINAL_WINDOWS_GUI_AUDIT_20261114.md).
- 실제 Windows Tauri EXE + WebView2 8개 주요 메뉴 및 설정 `operatorName` 저장/재진입/격리 SQLite 리비전 검증 통과.
- 거래처 등록창도 열렸으나 `36-edit-거래처-필수정보-작성.png`에서 거래처명, 주소, 연락처 모두 공란. 신규 `core_clients` 행 미생성. 이 상태는 **저장 함수 실패 증명이 아니라 선행 GUI 입력 실패**다.
- 이전 Python ANSI 출력 오류(`UnicodeEncodeError`), UIA 포커스/ValuePattern 제약은 Windows 감사 자동화 측 문제로 별도 기록되어 있었다.

## 실제 원인 분리 및 재검증

검증 브랜치: `fix/03-client-registration-native-audit`.

- 새 `scripts/migration03-client-registration-native-uia.ps1`은 일회용 Windows CI 환경에서 **정확히 동일한 앱 바이너리**를 실행한다. 기존 운영 DB를 건드리지 않고 `--bando-developer-test`의 격리 DB만 사용한다.
- 입력 제어값을 UIA `ValuePattern.SetValue`로 우회 변경하지 않고, 실제 WebView2 Edit 컨트롤에 포커스를 명시한 뒤 Windows 클립보드/키보드 이벤트를 전송한다.
- **각 필드의 실제 입력 직후와 포커스 이동 후 값 유지**를 개별 확인한다. 실패하면 저장 검증으로 넘어가지 않는다.
- Rust `catalog_clients.upsert_client` → 기존 SQLite 저장 경로를 거친 결과로 신규 거래처가 실제 목록에 표시된다.
- 앱 프로세스를 종료·재시작한 뒤 TEST DB에 저장된 상호/주소/연락처가 화면에 재표시되는지 검증한다.

**성공:** [Windows E2E run 43534441931](https://github.com/ThunderStrikerKR/TSBH/actions/runs/43534441931)
(`PASSED_NATIVE_INPUT_RUST_SAVE_SQLITE_REOPEN`, 9개 검증 항목 성공).
원본 스크린샷 증거: [Artifacts](https://github.com/ThunderStrikerKR/TSBH/actions/runs/43534441931/artifacts/14088527651)
(`03-form-filled.png`, `04-client-saved.png`, `05-client-reloaded.png`).

### 원인 판정

- **실제 앱 정상 등록 경로:** 통과. 현재 확인한 범위에서 앱의 React 입력과 Rust 등록, SQLite 저장/복원 오류를 재현하지 못했다.
- **3-5 원본 등록 실패:** 입력창 3개가 빈 화면을 증거로, 자동화 방식의 포커스/키보드 이벤트 전달 실패로 분류한다. 옛 자동화는 필드별 변경 확인 없이 다음 클릭으로 넘어갔다.
- **새 감사 도구 자체 오류:** PowerShell 예약 자동 변수 `$args`를 인수 이름으로 사용해 TEST 플래그 전달에 실패했고, UIA 배열을 pipeline에서 중첩 출력해 버튼 탐색에 실패했다. 둘 다 새 스크립트에서 수정되었다.
- **별도 후속 경계:** 의도적으로 필수 연락처를 누락한 채 저장을 눌렀다가 입력하는 추가 UIA 시험은 전화번호 입력을 전송하지 못했다. 앱 오류인지 자동화 시점·포커스 오류인지 **아직 미분류**이며, 정상 등록 경로의 성공을 이 별도 사례의 성공으로 확대하지 않는다. Rust 필수값 검증 자체는 별도 단위 테스트가 있다.

## 유지할 검증 방침

1. **실제 Windows EXE만** GUI 통과 근거로 사용한다. Vite/모의 IPC 결과를 대체하지 않는다.
2. 입력할 때는 컨트롤 값이 나타나고 포커스를 잃어도 유지되는지 검증한다. 빈 입력창에서 Save 실패는 DB 저장 오류로 단정하지 않는다.
3. 저장 결과는 앱 재시작 또는 별도 SQLite 조회로 확인한다.
4. 테스트 코드와 정확히 동일한 앱 소스만 인정한다. 현 workflow는 2026-11-14 통합 HEAD의 검증된 ZIP을 고정 참조하므로 이후 앱 소스가 바뀌면 새 HEAD 빌드로 갱신해야 한다.
5. 최종 업무 전수 GUI/실운영 배포 승인과 본 거래처 등록 경로 검증은 별개다.
