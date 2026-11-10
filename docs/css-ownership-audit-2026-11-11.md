# BANDO HUB CSS 전수 감사 / 13차 4단계

기준: `feature/tauri-product-bulk-registration`, 2026-11-11. 이 문서는 4단계의 **실행된 조사와 정리 범위**를 기록한다. 전체 UI 정상화 완료 판정이 아니다.

## 분석 범위와 방법
- `src/styles/index.css`의 `@import` 21개, `src/main.tsx`의 별도 CSS 5개: **실제로 불러오는 CSS 26개**를 적용 순서대로 조사.
- 순서: tokens → shell → shipping → application → foundation → fonts → theme → typography → dialogs → receipt-layout → workflow → workflow-states → receipt-document → modals → components → reception-manual → developer → startup-recovery → patch-v0808 → help-tooltip → client-editor → v0809 → product-admin-redesign → tauri-stage2-products → table-density → management-layout.
- `node scripts/audit-css-ownership.mjs`는 파일/행/선택자/속성/값/중첩 at-rule 조건을 수집하고 동일 조건의 중복 및 서로 다른 값을 추적한다. `--json`으로 모든 **정확히 일치하는 선택자**의 충돌 후보를 확인할 수 있다.
- 더 강한 스코프가 붙어 실제로 같은 요소를 선택할 가능성도 별도 `scopedOverlaps`로 수집한다. 이것은 정적 후보 목록이다. :is, :has, 실제 DOM, CSS specificity, 미디어쿼리 및 사용자 배율에 따른 **실제 우선 적용 결과**를 완전히 판정하는 도구는 아니다.
- `tests/tauri-css-ownership.test.mjs`는 스타일 파일 누락, 공통 컴포넌트의 소유권 역전, 제거한 구형 규칙의 재등장을 검사한다. 실제 UI 렌더링 검사는 `scripts/receipt-audit-ui-smoke.mjs`가 별도로 담당한다.

## 최초 감사 기준선
| 항목 | 수량 |
| --- | ---: |
| 불러오는 스타일 파일 | 26 |
| 파싱한 선언 | 6,769 |
| 동일 조건에서 반복되는 선택자+속성 | 343 |
| 파일 간 반복 | 225 |
| 값이 다른 파일 간 반복 | 180 |

위 수치는 **결함 개수가 아니다**. 서로 다른 상태, 화면 스코프, 반응형에서 필요한 재정의가 포함될 수 있다.

## 정리한 주요 중복
1. **상단 헤더**: `application.css`, `theme.css`, `patch-v0808.css`에 중복되었던 배경, 높이, 하단 경계 및 메뉴 선택 색상을 분리했다. 현재 일반 헤더의 최종 배경·높이·경계는 `theme.css`, 헤더 메뉴의 특수 크기 및 선택 상태는 `patch-v0808.css`가 담당한다. 도킹 상태 높이는 `application.css`의 작업 모드 규칙으로 유지한다.
2. **운임관리**: `shipping.css` 내부의 `shipping-stats`, `shipping-tabs` 요약 레이아웃을 앞쪽 기본 규칙으로 합쳐 뒤쪽 반복 선언을 삭제했다. 운임 팔레트와 목록 최대 높이의 기본값은 `theme.css`에서 결정한다. 빈 목록 축소와 업무 전용 선택창 높이는 `shipping.css`에 남긴다.
3. **카드와 필드**: `foundation.css`에서 이후 `theme.css`와 `components.css`에 가려지는 구형 카드 배경, 필드 라벨 색상 및 글씨 크기, 상세정보 글씨 크기 선언을 삭제했다.
4. **접수 및 도킹 화면**: `application.css`의 `pane-heading`, `review-toolbar`, `option-buttons`, `freight-row`, `order-status-actions`, 도킹 헤더 등에 남아 있던 후속 테마 동일 조건의 덮어쓰인 선언을 삭제했다. 기존 CSS의 마지막으로 유효한 값은 유지했다.
5. **공통 필드 라벨**: `theme.css`의 더 강한 라벨 선택자를 제거하고, `tokens.css`의 `--field-label-size`, `--field-label-color`와 `components.css`의 `Field` 스타일 한곳으로 통일했다. 관리 화면과 모달에서 같은 역할을 하는 라벨의 글씨 크기를 14px × UI 배율로 지정한다.
6. **표와 카드 여백**: 이미 `management-layout.css`에서 결정되는 관리 카드 하단 여백의 구형 `application.css` 선언과, 동일 선택자에서 뒤쪽에 100% 너비가 다시 적용되던 가격 입력창의 125px 선언을 제거했다.

## 남은 후보를 판단할 때의 우선순위
- **P1 / 레이아웃 결과 직접 영향**: `.price-cell input`, `.manager-filters > input`, `.management-container .card` 등의 스코프 및 우선순위를 실제 화면에서 측정한다. 상품명 열 너비, 행 높이, 검색창의 정렬, 카카오톡 예약 폭을 보존한다.
- **P1 / 공통 컨트롤**: `button`, `.field`, `input:focus`, `.empty`처럼 구형 기본 스타일과 최신 관리 화면 스타일이 서로 다른 specificity로 존재한다. 전역 값을 강제로 바꾸지 않고 화면 역할에 맞춰 실제 렌더링을 조사한다.
- **P2 / 화면 특화**: 주문접수 작업 패널, 모달, 도움말, 대리발송, 공장 회신 등은 공통 관리 컴포넌트와 요구 높이가 다르므로 사용 현황과 계산 스타일을 확인한 후 옮긴다.
- **유지 대상**: 도킹 모드, 좁은 창, 특수 편집 상태의 미디어쿼리·컨테이너쿼리·상태 선택자 차이는 같은 CSS 속성을 재설정하더라도 필요할 수 있다. 수치만 기준으로 삭제 금지.

## 완료 판정
- CSS 파일과 우선순위의 **정적 감사 수행 및 자동화**: 적용.
- 고위험 중복 선언의 **선별 정리**: 적용.
- 동일한 화면 역할의 라벨 크기 **공통 소유권 회복**: 적용, 브라우저 검증 필요.
- 모든 후보에 대한 무조건 삭제: **미실시**. 잔여 후보는 의도된 변형과 실제 충돌이 섞여 있다.
- 모든 하위 탭·데이터 상태·Windows EXE의 전수 육안 비교: **별도 검증 범위로 남음**.

업무 데이터, 가격/운임 산정, 역사적 주문 스냅샷, 저장 확인 정책, 카카오톡 패널 배치는 CSS 정리 대상이 아니다.
