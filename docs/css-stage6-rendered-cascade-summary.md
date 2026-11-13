# 반도허브 UI 정상화 6단계 — CSS 충돌의 실제 화면 대조

검증 소스 커밋: `27255da36a46e02b634ea9ac93123eec23a3064f`  
브라우저/Node/Rust CI: [GitHub Actions #42911261363](https://github.com/ThunderStrikerKR/BANDO-HUB-Tauri/actions/runs/42911261363)  
전체 후보별 근거: [css-stage6-rendered-cascade-report.json](./css-stage6-rendered-cascade-report.json)

## 범위와 수치

- 실제로 불러오는 **26개 CSS 파일**의 같은 선택자/속성/조건을 조사했다.
- 이 단계 직전의 파일 간 다른 값 충돌 후보 **132개**에서 **120개**로 감소했다. 이는 **화면 결함 12개 해결**이 아니라, 더 이상 적용되지 않는 선언과 명백히 충돌하던 배치 규칙 등을 정리한 결과다.
- **21개 주요/하위 관리 화면 표본**, 접수 기본 화면 및 대표 편집/저장 모달을 포함한 **25개 상태**에서 실제 DOM 선택자 매칭 및 최종 계산값을 검사했다.
- 120개 모두 JSON 보고서에 `selector`, `property`, `context`, 파일별 원본 값, 최종 계산값 표본, 관측된 화면, 상태 분류를 기록했다.

| 분류 | 건수 | 의미 |
| --- | ---: | --- |
| `MATCHED_IN_RENDERED_VIEW` | 41 | 검사한 실제 화면의 요소에 규칙이 매칭됨. 이 자체가 오류 판정은 아님 |
| `NOT_OBSERVED_IN_SAMPLED_VIEWS` | 78 | 이번 표본에서는 발견되지 않음. 사용하지 않는 CSS라는 뜻은 아님 |
| `UNSUPPORTED_SELECTOR` | 1 | 전역 `::selection` 의사 요소는 DOM 선택자 검사로 직접 확인되지 않음 |
| 합계 | **120** | 남은 파일 간 동일 선택자/속성의 서로 다른 값 후보 |

참고: **선택자 우선순위가 서로 다른 규칙의 중첩 후보 75개**도 별도 정적 감사 목록에 남아 있다. 위 120개에 포함된 일부와 교차할 수 있어 두 숫자를 합쳐 결함 개수로 사용하지 않는다.

## 실제 수정

1. **저장 확인창 위치와 너비**: `modals.css`가 `dialogs.css`의 카카오톡 예약 영역을 고려한 중심 계산을 덮고 있었다. 덮어쓰기 규칙을 제거했다. 모의 Tauri React 브라우저에서 **1520px 화면, 320px 예약 영역**을 적용했을 때 중심 좌표 **920px**을 확인했다.
2. **접수 하단 버튼 크기**: `theme.css`에서 `receipt-layout.css`의 확정값에 덮인 이전 font-size, padding 제거.
3. **거래처 목록 열 너비**: `workflow.css`의 이전 첫 번째와 두 번째 열 너비 제거. `client-editor.css`의 기존 최종 적용값 유지.
4. **메시지 편집 영역**: `workflow-states.css`의 이전 여백, 최소 높이 및 resize 지정 제거. `reception-manual.css`의 접수 전용 배치 유지.
5. **원문 작업 버튼**: `receipt-document.css`의 덮인 font-size 제거. `reception-manual.css`의 버튼 규격 유지.
6. **관리 화면 소제목**: `components.css`의 이전 h3 크기 제거. `management-layout.css`가 최종 크기를 관리.
7. **원문 영역 상단 버튼**: `reception-manual.css`에서 뒤의 `patch-v0808.css`에 덮인 padding과 font-size 제거. 높이 정책 유지.

## 관측되었지만 보존한 규칙 예시

- `.tier-wholesale`: 거래처 등급에 따른 녹색 표시는 업무상 의미 있는 색상 변형.
- `.hub-shell`, `.hub-shell .hub-panels`: 이전의 넓은 최소 너비보다 좁은 화면에서의 유동 배치가 필요한 규칙.
- `.source-pane .source-actions`: 접수 버튼을 좁은 화면에서 두 행으로 구성하는 후속 레이아웃.
- `.catalog-admin-workspace`: 현재 카테고리 관리의 전체 작업 영역을 위한 블록 배치.
- 화면별 배경/글씨 색상과 모달의 스크롤 예외: 현재 UI 최종값은 수집했지만, 모든 상태에서 필요한 예외인지의 판정은 향후 시각 검증에 포함한다.

## 검증 경계와 다음 감사 대상

- **통과**: TypeScript, Node 테스트 337개, React 브라우저 회귀 테스트(모의 Tauri IPC), Rust 접수 경계 테스트, Windows SQLite/Rust 통합 테스트.
- **실제 Windows EXE를 수동으로 열어 전 화면을 육안 검수한 것은 아님.** Windows 실행 파일 빌드 상태는 연결된 CI에서 별도로 확인한다.
- 검증된 것은 **해당 화면 표본의 계산 스타일**이다. 78개 미관측 후보를 불필요한 규칙이라고 단정하거나 삭제하지 않는다.
- 특히 `.muted`와 모달 내부 타이포그래피, 창 너비와 90%/110%/125% 배율, 오류/빈 상태/편집 상태에서만 표시되는 컴포넌트는 **7단계(모달), 8단계(다중 해상도/배율)** 검증으로 넘긴다.
- 이번 작업은 주문 저장, 상품 가격, 운임 계산, 이력 보존, 카카오톡 예약 영역 자체의 업무 동작을 변경하지 않았다.

## 재현

`node scripts/audit-css-ownership.mjs --json`: 파일별 선언과 중복 후보 전수 목록  
`node --test tests/tauri-css-ownership.test.mjs`: 디자인 토큰 및 CSS 소유권 회귀 검사  
`node scripts/receipt-audit-ui-smoke.mjs`: 화면별 계산값과 `CSS_CASCADE_CLASSIFICATION` 로그 생성

목표는 충돌 후보 숫자만 0으로 만드는 것이 아니라, **같은 역할의 UI는 공통 소유권으로 관리하고 업무·상태별 예외는 의도적으로 남기는 것**이다.
