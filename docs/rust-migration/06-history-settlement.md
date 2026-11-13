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

- 전용 브랜치 코드/자동화 검증: 완료. 원본 동등성 포함.
- `migration/03-integration` 병합: 다른 병렬 세션이 진행 중이므로 아직 미수행.
- 실사용 Windows 설치 앱에서 실제 주문/거래처 데이터로 날짜/검색/결산 화면 검수: 최종 통합 단계에서 실시해야 함.
- 최종 앱 배포 완료나 전체 CI all-green을 이 문서에서 주장하지 않음.
