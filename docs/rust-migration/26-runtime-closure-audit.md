# 반도허브 26차 — 실제 런타임 Rust 이전 인수인계 및 잔여 감사

작성 기준: 2026-11-15 KST. 통합 기준선 `migration/03-integration` @
`c6b254a72afa8c7b67a2d9c07959527bf3309bfa`.
작업 전용 브랜치: `migration/08-runtime-closure-26`.

**판정: 핵심 실행 경로 일부 Rust 이전 구현·차등 검사 진행. 전체 TS 업무 엔진 제거는 미완료.**
최신 브랜치 CI가 모두 완료되기 전까지 운영 배포 또는 통합 병합 승인은 하지 않는다.

## 이번 차수 실제로 변경한 런타임

1. `app/useAppModel.ts`: 저장 직전 `persisted_reception_state`를 Rust로 실행.
   오래된 JSON 객체 키 순서만 다른 상태는 의미 비교로 불필요한 저장 방지.
   `finalize_billing_history`가 **원본 저장 주문**의 가격·부가세·운임·거래처를
   동결한 뒤 임시 초안을 정리한다. 최종 SQLite 쓰기는 기존 revision-checked
   단일 `window.bando.save`만 사용한다. 확정 주문은 커밋 결과로 재조회한다.
2. `orders/useOrderDesk.tsx`: 편집 중 TS `billingSnapshot` 호출 제거.
   첫 편집 시각·이유·그룹 정보만 임시 기록하고 Rust가 저장 시 동결한다.
   Rust는 오래된 초안이 기존 청구 이력을 삭제·변형하는 것을 거부한다.
3. `CorrectionPanel.tsx`: 공장 정정 상태/변경 문구를
   `output.render_correction_summaries`에서 읽고 그대로 클립보드 복사.
   이전 상태의 응답이 화면을 덮어쓰거나 복사되지 않게 한다.
4. `SourceDocument.tsx`/`KakaoClients.tsx`: 카카오톡 제목 매핑 저장과
   기존 매핑의 자동 거래처 선택을 `catalog_clients` Rust로 이전.
   비활성 거래처·중복 제목 방지, 실패 시 명시적 거래처 선택 가능,
   주문 및 원문을 교체하는 OCR·붙여넣기·비우기는 Rust `replace_reception`.
   비동기 응답은 원래 주문·원문으로만 반영.
5. `orders/ManualClassification.tsx`: 최종 완료 시
   `rules.apply_manual_classification`로 수량 확인, 출처 연결,
   주문 재조립 및 직원 이슈 상태 동기화.
   **셀 타이핑/상품·수량 임시 해석은 아직 TypeScript로 실행**한다.
6. `FactoryNotifications.tsx`, `FactoryReplyHistory.tsx`,
   `App.tsx`: 공장 회신의 검토 필요, 행별 승인/이력, 안내/확인 문구 및
   상단 알림 배지를 모두 같은 `output.project_factory_reply_review`로 산출.
   회신 최종 승인은 기존 Rust 네이티브 SQLite 절차를 유지.
7. `ShippingManager.tsx`/`ProductFreightPanel.tsx`: 상품별 현재 운임,
   그룹 기준 수정용 정규화, 조합의 현재 유효/과거 이력 판단을
   `rules.shipping_read`로 이전. 운임 설정/저장은 기존 native reducer 사용.

## 자동 비교와 증거

- `tests/rust-migration/output/correction-parity.test.mjs`: 정정 안내/상태 9개.
- `tests/rust-migration/catalog-clients/title-clients-parity.test.mjs`: 제목 기억/거래처 15개.
- `tests/rust-migration/rules/billing-commit-parity.test.mjs`: 과거 청구 동결 9개.
- `tests/rust-migration/rules/manual-apply-parity.test.mjs`: 수동 완료 11개.
- `tests/rust-migration/output/factory-review-parity.test.mjs`: 회신/승인 12개.
- `tests/rust-migration/rules/shipping-read-parity.test.mjs`: 운임 투영 11개.
- 기존 `tests/rust-migration/rules/parity/compare.mts`:
  접수 원문 교체/초안 저장 이전 TS 비교 보존.
- `tests/tauri-native-operational-actions.test.mjs`:
  실 React 진입점→IPC/순서/TS 복귀 방지에 대한 정적 회귀.
- 병합 이전 **성공한 전체 CI**: `43617686714`
  (변경된 `0ce35b3f` 기준 11/11 워크플로 성공).
  이후 추가된 앱 알림/통합 테스트 반영 커밋은 해당 HEAD에서 별도 CI 확인 필요.
- TS 차등 테스트, 실제 컴파일, Windows Rust/SQLite 테스트의 통과가
  설치된 최신 Windows GUI의 마우스·키보드 E2E 전체 통과를 의미하지는 않는다.

## 남은 업무/차단 조건

- **P0** 수동 분류 `orders/manual-classification.ts`의
  `setManualValue`, `assignManualBlock`, `releaseManualBlock` 및
  상품 셀 `parseOrder`, `quantities`, 주소 분리의 업무 판단.
  React 타이핑은 즉시 반응하되 확정 판단이 TS와 Rust로 둘로 갈리지 않게
  비동기 시퀀스/undo/블록 연결 수명과 원본 TS 차등 검사가 필요하다.
- **P1** `domain.itemFromProduct` 호출 경로:
  `orders/useOrderDesk.tsx`, `OrderItemEditor.tsx`,
  `CorrectionPanel.tsx`, `orders/RetailOrderDialog.tsx`.
  기존 Rust 가격 결정은 이미 살아 있으므로 객체 정체성/옵션/근거 필드만
  원본과 동등하게 옮긴다. 현 편집 중 가격을 소급 변경하지 않는다.
- **P1** `OrderDesk.tsx` 등의 원본 주소 분리,
  `SourceDocument.tsx`의 별도 거래처 UI 보조 판단,
  `AutomaticMessageTemplateManager.tsx`/
  `ProvisionalProductNoticeManager.tsx`의 저장 전 설정 검증,
  기타 실호출 TS 규칙을 다시 스캔하고 제거해야 한다.
- **P2** 프런트 번들에 남은 원본 TS 업무 모듈의 실제 실행 경로를
  `scripts/audit-ts-business-retirement.mjs`와 코드 호출 그래프로
  분류한다. ExcelJS XLSX 직렬화·React 컴포넌트·렌더링·TS 타입 및
  차등검사용 원본 함수는 제거 대상이 아니다.
- 사용자의 25차 GUI 오류(가격 임시값, 수량 잠정 처리, 호버 연결)를
  통합된 **실제 Windows EXE**로 다시 연속 조작하고,
  주문 저장 후 재시작/SQLite·공장 엑셀·공장 회신·청구 보존을 확인한다.

## 병렬 통합 주의

기준 통합 브랜치도 다른 작업에서
`useAppModel.ts` 초안 저장·`SourceDocument.tsx` 원문 교체를
별도로 Rust 이전하고 있다. 작업 브랜치에는 이 변경 중
`195dfe3e`까지 두 번의 실제 Git merge-parent로 반영했고,
`useAppModel`의 추가 청구 이력 최종화 및 `SourceDocument`의
카카오톡 자동 매핑·비동기 안전 조건을 유지했다.
**통합 브랜치가 계속 이동 중이면 HEAD를 다시 확인하여 충돌을 분석하고,
무검증 전체 파일 덮어쓰기나 force push를 금지한다.**
