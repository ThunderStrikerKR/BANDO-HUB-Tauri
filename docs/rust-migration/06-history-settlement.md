# Session C — 주문 이력 및 결산 Rust 이전

## 작업 분리

- 기준 브랜치: `migration/03-integration` (`a1444be0a524dae250587b0bf513061fb452be5f`에서 분기)
- 전용 브랜치: `migration/06-history-settlement`
- 대상: 주문 이력 및 결산의 기존 TypeScript 업무 규칙을 Rust에서 동일하게 실행
- 비대상: 자동 메시지(3-2), 카카오톡, 공장 회신(05), 상품/거래처, 업무 단계 UI 및 Excel 출력 변경

## 구현

1. `src-tauri/src/business_core/rules/history.rs`
   - `list_order_history` 및 `order_history_status`
   - 확정/레거시 접수일의 한국시간 필터, 검색, 삭제 주문 및 삭제 묶음 제외
   - 처리 중 / Excel 추출 대기 / 추출 완료 / 공장 회신 완료 판정
   - 확정 거래처 스냅샷 보존
   - 기존 Rust `pricing::totals`, `workflow::shipment_totals` 재사용
   - 출력 이력의 고정 스냅샷을 현재 상품 가격으로 재계산하지 않음
2. `src/app/OrderHistory.tsx`: Rust 읽기 IPC 연결, 비동기 요청 ID 및 오래된 조회 응답 차단, 로딩과 빈 결과 구별
3. `src/app/DailySettlement.tsx`: Rust 주문 이력 결과를 기존 Rust `output.prepare_settlement`에 직접 전달. TypeScript의 `orderHistory()` 호출 제거
4. `tests/rust-migration/rules/history-parity.test.mjs`: 실제 TypeScript 원본과 컴파일된 Rust 엔진 비교. TypeScript 구현은 테스트 참고 원본으로만 유지
5. `tests/tauri-settlement-order-history.test.mjs`: 운영 화면이 기존 TS 계산이 아니라 Rust를 호출하는지 확인하도록 검사 갱신

## 결정적으로 지켜야 할 규칙

- 조회 전용: 주문, 배송건, 입금, 운임, 상태 스냅샷을 저장하거나 변경하지 않음
- 청구 금액과 실제 입금액의 기준일은 분리. 실제 은행 입금과 내부 입금 승인은 합산하지 않음
- 확인되지 않은 합계, 실제 운임, 미수금은 임의로 0원 처리하지 않고 미확정으로 유지
- 레거시 TypeScript 파일 `src/app/order-history.ts` 및 `settlement-report.ts`는 동등성 검증을 위해 보존하고 운영 화면에서 실행하지 않음
- 공유 `.github/workflows/migration-output.yml`의 임시 변경은 원상복구하여 타 세션 CI와 충돌하지 않음

## 확인한 검증 결과

기준 CI: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43436489823

- 기존 TS 원본 vs Rust 주문 이력 + 상태: **52개 상태/조회 시나리오에서 104개 결과 비교 통과**
- 기존 TS 결산 vs Rust 주문 이력 → Rust 결산 연결: **동등성 검증 통과**
- 전체 프런트엔드 회귀: **499 passed, 0 failed, 2 skipped (총 501)**
- TypeScript 빌드 및 Vite 번들 생성: **통과**
- Rust 통합 코어, 가격/운임 규칙, 출력 및 주문 저장 차등: **통과**
- Windows `cargo test --lib`: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43436833228
  - 새 주문 이력 테스트 2건 모두 통과
  - 전체 99 passed, 2 failed, 1 ignored. 실패는 기존 `kakao_dock`의 독립 테스트 2건으로 이 브랜치 업무와 무관하며 PR #4에 별도 수정 존재

## 배포 및 병합 경계

- 최초 주문 이력/결산 핵심 경로: 이전에 차등 테스트가 통과했으나, 후속 화면 업무 규칙 이전은 **최신 HEAD의 컴파일/차등 재검증 대기**.
- `migration/03-integration` 병합: 다른 병렬 세션이 진행 중이므로 아직 미수행.
- 실사용 Windows 설치 앱에서 실제 주문/거래처 데이터로 날짜/검색/결산 화면 검수: 최종 통합 단계에서 실시해야 함.
- 최종 앱 배포 완료나 전체 CI all-green을 이 문서에서 주장하지 않음.

## 후속 전수 감사 — 런타임 TypeScript 잔여 확인

사용자의 Q1 요청에 따라 세션 C 화면의 실제 import/call graph를 추가 조사했다.

### 추가로 발견해 Rust로 이전한 업무 판단

- `OrderHistory.tsx`에서 `factory-replies.ts/trackingMessage`를 직접 실행하던 운송장 복사 텍스트 → `rules.list_order_history_view`의 `display.trackingMessage`
  - 원본 JavaScript `Object.values` 삽입순서를 잃지 않도록 UI가 각 배송건의 **키 순서만** IPC에 전달하며, Rust가 배송건/수취인을 선택해 완성된 문구를 생성
- `historical-product-reference.ts`에 맡긴 과거 부모 상품 ID + 가격기록 ID 연결 → Rust `display.references`
  - 동일 상품명, 모델명, 색상만으로 재연결 금지; 과거 단가/주문 스냅샷 변경 금지
- 기존 `paid` 표시와 실제 계좌 입금 배분이 연동되는지 TS로 검사하던 로직 → Rust `display.paymentEvidenceMissing`
- 렌더링에서 쓰는 `won`, `internalModel`은 업무 계산과 관계없는 `src/app/history-format.ts`로 격리하여 `domain.ts`, `matching.ts` 런타임 import 제거
- 첫 화면 날짜/휴면 Excel 출력의 `seoulDate` 사용을 `src/app/seoul-date.ts`로 격리하여 `settlement-report.ts` 레거시 TS 계산 모듈의 불필요한 런타임 import 제거

### 계속 남겨 두는 TypeScript

- `src/app/order-history.ts` 및 `settlement-report.ts`: **원본 TS와 비교하기 위한 코드**. 운영 화면에서 실행하지 않으며, 화면의 `import type`은 런타임 JS에 포함되지 않음
- `src/app/report-workbook.ts`: 보류 중인 Excel 출력기. 실제 Excel 셀 표현 및 입금 표시 안내문 같은 로직은 TS로 남아 있지만 현재 다운로드 UI는 비활성. **추후 Excel 출력 재활성 시 별도 이전·검수 필수**
- `OrderHistory.tsx`의 상품명 축약, 금액 로케일 표시, 표의 펼치기/필터, 일부 라벨 분기는 **사용자 화면 표시**이며 상태 변경/가격/입금 집계가 아님
- `useAppModel.ts`의 다른 업무에 필요한 `orderClient` 의존성 등 **애플리케이션 전체** TS 제거는 본 세션의 범위가 아님

### 후속 변경의 검증 상태

- 최신 소스의 **16개 정적 호출/의존성 감사 항목 확인**: 통과
- 신규 원본 TS 대조 시나리오 **18개**, Rust 순서 및 금액/상품 연결 단위 테스트 추가: 코드 작성 완료
- 새로운 `tests/tauri-settlement-order-history.test.mjs` 화면/로케일 회귀 테스트 추가
- **최신 HEAD에서의 Rust 컴파일, 신규 TS/Rust 차등 테스트 및 Windows 실행 확인: 미완료.** GitHub Actions의 신규 브랜치 push workflow 실행이 job 0개로 종료되어 결과를 얻지 못함. 앞선 통과 CI는 후속 수정 전의 소스이므로 새 변경의 PASS 근거로 사용하지 않음
- 공유 `.github/workflows/migration-output.yml`은 변경 사항을 원상복구했으며, 병렬 통합 브랜치는 미변경
- PR #6은 이 검증이 끝날 때까지 Draft로 유지한다
