# TS → Rust 차등 테스트 실측 보고 (2026-11-13)

## 판정

**PARTIAL PASS / 전체 Rust 이전 완료 아님.** TypeScript 원본은 수정하지 않았고, 실제 실행 결과를 Rust의 실제 운영 모듈과 비교했다. 독립 Rust 단위 테스트를 기능 동등성의 근거로 사용하지 않는다.

- 마지막 실제 3종 차등 테스트 성공 소스 커밋: `2db4a1ba36ddeb3df7049254950816d2dbc2323f`
- 검증 실행: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43356375386
- 세 차등 테스트 job: `output-ts-rust-parity`, **3개 테스트 모두 성공**. 테스트 내부 입력 사례 **109 + 11 + 65 = 185개**, 정상 결과와 오류를 동일 입력으로 비교.
- Rust 출력 자체 단위 테스트 job: **성공**.
- 전체 프런트엔드 Node 회귀: 475개 중 473개 성공, 기존 발주서 표본 19/20 실패. 따라서 전체 CI는 초록색이 아니다.

## 원본 실행과 비교한 함수

| TypeScript 실제 참조 | Rust 실제 구현 | 입력 사례 | 판정 |
| --- | --- | ---: | --- |
| `src/factory-export.ts::previewFactoryExport`, `src/store-export.ts::previewStoreExport` | `src-tauri/src/business_core/output/export.rs` | 1차 합산 109개 중 일부 | 범위 내 일치 |
| `src/automatic-message-templates.ts::renderAutomaticTemplate/validateAutomaticMessageTemplates` | `output/messages.rs` | 1차 합산 109개 중 일부 | 범위 내 일치 |
| `src/app/settlement-report.ts::dailySettlement` | `output/settlement.rs` | 1차 합산 109개 중 일부 | 범위 내 일치 |
| `src/hub-messages.ts::hubMessages(payment)` | `output/messages.rs::payment` | 11개 | 범위 내 일치. Rust가 받을 금액/운임/계좌 데이터는 TS 규칙으로 먼저 계산하는 **비교용 어댑터**를 사용; 독립 엔드투엔드 검증은 아님 |
| `src/domain.ts::resolvePrice/totals/repriceOrder`, `src/orders/passive-pricing.ts::shouldRefreshUncommittedOrderPricing`, `src/shipping.ts::recommendShipping` | `rules/pricing.rs`, `rules/shipping.rs` | 2차 합산 65개 중 일부 | 범위 내 일치 |
| `src/workflow.ts::shipmentTotals/groupStep/stageIssues/groupShipments` | `rules/workflow.rs` | 2차 합산 65개 중 일부 | 범위 내 일치 |

각 비교는 TypeScript를 `tsx/esm/api`로 실제 로드하고, 별도 `cargo run` Rust 실행 파일에 같은 JSON을 전달한다. 출력 JSON을 깊은 동일성 검사하고, 실패 케이스는 **정확한 오류 메시지**까지 비교한다. 비교가 실패하면 전체 테스트가 실패하며 차이를 로그에 출력한다.

## 실제로 발견하고 수정한 차이

- **매장 Excel 특수 색상 뒤 공백:** `단일 `은 TypeScript에서 뒤 공백을 제거한 후에도 색상을 표시한다. Rust가 임의로 숨기던 처리 수정.
- **메시지 템플릿 오류 3개:** 미지원 변수, 필수 변수 삭제, 변수 괄호 오류에 TypeScript와 같은 한국어 서식명 사용.
- **선입금 부족 금액:** `36300원` → TS처럼 `36,300원` 및 금액 미확정 문구 유지.
- **계좌 재안내 오류:** 수취인 이름 접두사 복원.
- **업무 오류 표시 순서:** Rust의 가나다순 정렬 제거. TypeScript의 최초 발견 순서와 중복 제거 방식 유지.

이 수정은 모두 **`migration/03-integration`에만 반영**했으며 기존 원본 TypeScript 및 다른 세션의 소유 브랜치는 수정하지 않았다. 세션 2의 마지막 독립 Rust 자체 테스트를 통과한 모듈만 통합 브랜치에 **비활성 복사**하여 비교했으며, 주문 승인 결정권을 Rust에 넘기지 않았다.

## 남은 검증 / 절대 완료로 보고하지 말 것

1. **발주서 인식 전면 비교 실패:** `migration/01-recognition` 작성자의 독립 20건 회귀 보고서는 6건 조건 통과, 나머지 실패. 표의 원문 바이트 경계 panic, 전화번호의 가짜 상품 처리, 잘못된 수취인 경계 등이 남아 있으며 소스 병합/실사용 전환 금지.
2. **전체 업무 상태 전환 미검증:** `apply_workflow_action`, `complete_delivery`, 결제 증빙, 과거 주문 스냅샷, 다양한 승인/취소/재출고와 원본 TS 간 완전한 상태 그래프/이벤트/SQLite 영속 차등 테스트 미실시.
3. **실제 자동 메시지 전체 미검증:** 11개 사례는 지불안내(payment) 문자열만의 비교이며 주문 확인 요청(options), 전체 검증 이슈, 메시지 복사 이벤트 및 조건부 안내문의 다양한 조합은 미완료.
4. **Excel 파일 바이트 동등성 미검증:** Rust는 출력 준비 행을 만든다. 실제 XLSX 서식/보관/저장 및 DB 이력 흐름은 여전히 ExcelJS와 네이티브 저장 계층을 사용한다.
5. **완전한 프런트엔드 TS 핵심 알고리즘 제거 아님:** 기존 TS 함수 여전히 존재, 정식 번들의 잔여 로직 감사 및 제거 필요.
6. **Windows 전체 GUI/직원 시연 검증 아님:** Windows 네이티브 테스트의 기존 카카오톡 UI 두 건이 실패했던 점을 포함해 별도 검증 필요.
7. **차등 테스트 성공의 범위:** 185개 테스트 입력에서 동일하다는 뜻이지 가능한 모든 발주서/회사 데이터에서 논리 동등성의 수학적 증명은 아니다.

## 실행 명령

```sh
npm install --no-audit --no-fund --ignore-scripts
node --test tests/rust-migration/output/parity.test.mjs
node --test tests/rust-migration/output/payment-parity.test.mjs
node --test tests/rust-migration/rules/parity.test.mjs
cargo test --manifest-path tests/rust-migration/output/Cargo.toml
cargo test --manifest-path tests/rust-migration/rules/Cargo.toml
```

새 사례를 추가할 때는 원본 TS 기대 결과를 하드코딩하지 않고 **실제 TS 함수를 호출해 oracle을 생성**한다. Rust의 기존 구현을 근거로 TS 기대값을 역으로 고치지 않는다.
