# BANDO HUB 모달 및 팝업 디자인 시스템

기준: 7단계 React 브라우저 검증(공통 상태 9종, 업무 팝업 14종 / 전체 23개 상태). 새 팝업은 기존 규격을 **자동 상속**해야 한다. 이 문서는 UI 스타일 및 회귀 검사 규약이며, 저장/취소/데이터 처리 정책을 변경하지 않는다.

## 1. 공통 규격 (UI 배율 100% 기준)

| 역할 | 기본값 | 소유권 |
| --- | --- | --- |
| 편집창/확인창 제목 | 18px, 행간 1.35, 기본 굵기 650 | `--modal-title-size` |
| 본문/안내문 | 13px, 행간 1.5 | `--modal-body-size` |
| 일반 편집창 작업 버튼 글씨 | 14px | `--modal-action-size` |
| 확인/입력/저장 선택창 버튼 글씨 | 13px | `--modal-decision-action-size` |
| 닫기 버튼 높이 | 32px | `--modal-close-height` |
| 편집창 기본 최대 너비 | 880px, 좌우 여백 최소 18px | `--modal-width`, `--modal-viewport-gutter` |
| 확인/입력 대화상자 최대 너비 | 560px, 카카오톡 예약 공간 제외 | `--modal-decision-width` |
| 일반 편집창 내부 패딩 | 상하 16px, 좌우 18px | `--modal-panel-padding` |
| 제목과 본문 간격, 제목 내부 간격 | 12px | `--modal-header-gap` |
| 기본 입력창/선택창 | 관리 컨트롤 공통 높이 40px | `--control-height` |
| 기본 작업 버튼 | 관리 컨트롤 공통 높이 40px | `--control-height` |

- 타이포그래피 및 컨트롤 크기는 `--ui-scale` 설정을 따른다. 고정 픽셀 수치는 **100% 배율 예시**다.
- 도움말 아이콘 같은 작은 보조 버튼은 일반 작업 버튼과 달리 약 22px 높이로 허용한다. 기능별 CSS에서 해당 역할을 명시한다.
- 상품 상세처럼 강조를 위해 **굵기만 달리해야 하는 모달**은 글씨 크기를 바꾸지 않고 font-weight만 별도 지정한다.
- 본문이 많을 때는 페이지 전체가 아니라 **모달 내부의 스크롤 소유 영역**만 움직인다. 상품 상세는 `.product-detail-body`, 거래처 상세는 `.client-editor-body`, 일반 편집창은 `.modal-fields`가 소유한다.
- 편집창 헤더와 저장/취소 푸터를 고정하는 특수 화면은 구조를 유지하며, 내용이 화면을 밀어내거나 컨트롤이 좌우로 잘려서는 안 된다.
- 표 형태 검토 창은 자체 스크롤을 가질 수 있다. 긴 문자열, 폼 컨트롤, 오류문이 있더라도 닫기 및 취소 동작에 접근 가능해야 한다.
- 확인창(`.app-action-dialog`)은 `--kakao-reserved-width`를 고려하여 **카카오톡 예약 공간을 제외한 작업 영역 중앙**에 배치한다. 편집창 위에 확인창이 쌓일 때 배경 어둡기를 낮추는 규칙은 유지한다.

## 2. 새 팝업 작성 규칙: 추가 CSS 없이 기본 규격 자동 적용

**일반 편집/검색/상세/검토 팝업:** `src/ui/Modal.tsx`의 `Modal`을 사용한다.

```tsx
import { Modal } from "./ui";

{open && (
  <Modal title="새 작업" onClose={close} busy={busy} draft={draft}>
    {/* Field, Button 또는 기존 표준 폼 컨트롤을 사용 */}
    <div className="actions">
      <button type="button" onClick={close}>취소</button>
      <button type="button" className="primary" onClick={save}>저장</button>
    </div>
  </Modal>
)}
```

- `Modal`이 제공하는 `dialog.app-modal-layer > section.modal > header + fieldset.modal-fields` 구조를 삭제하거나 직접 복제하지 않는다. 브라우저 native `showModal()`, Escape, 포커스, busy 비활성화, 미저장 상태를 그대로 유지한다.
- 새로운 JSX에서 modal/dialog 태그를 직접 작성하지 않는다. 별도 확인 대화상자가 필요하면 `src/dialogs.ts`의 `confirmAction`, `promptText`, `askSaveChanges`를 사용한다.
- `src/styles/tokens.css`만 기본 숫자값을 정의한다. `src/styles/modals.css`은 공통 `Modal` 스타일 소유자, `src/styles/dialogs.css`는 확인/입력/저장 선택 대화상자의 소유자이며 `src/styles/components.css`가 일반 편집창 버튼의 역할 토큰을 적용한다.
- 개별 기능 CSS는 자신의 모달 너비/본문 그리드/스크롤 소유자/색상과 같은 **업무별 예외**만 정의한다. 모달 제목 font-size를 다시 적지 않는다. 비슷한 스타일을 끝쪽 파일에 덧씌우는 대신 기존 규칙의 소유권을 이동한다.
- `--modal-title-size`, `--modal-body-size` 등은 임의 글씨 크기 숫자 대신 사용한다. 규격을 바꿀 때는 토큰과 브라우저 회귀 검사를 함께 수정한다.
- 모달은 앱 상단의 작업/저장 데이터와 별개다. 스타일 변경을 이유로 데이터 저장, 확인 팝업 순서, 주문/가격/운임 비즈니스 규칙을 변경하지 않는다.

## 3. 허용되는 예외

| 구성요소 | 현재 의도된 예외 |
| --- | --- |
| 상품 상세 `product-detail-dialog` | 이미지 영역과 고정 푸터, 자체 본문 스크롤, 제목 굵기 750 |
| 거래처 상세 `client-editor-modal` | 2열 필드, 자체 본문 스크롤과 고정 저장 푸터 |
| 카테고리 선택 `category-picker-dialog` | 600px 최대 높이와 목록 전용 스크롤 |
| 원문/수동 분류 등 특수 작업 | 도킹/카카오톡 공간 보존, 자체 그리드 또는 원문 스크롤 |
| 확인/입력/저장 선택 `app-action-dialog` | 560px 최대 너비, 버튼 글씨 13px, 카카오톡 예약 영역 기반 위치 계산 |
| 도움말 아이콘 | 작은 보조 버튼 크기 유지(일반 작업 버튼 40px 강제 금지) |

## 4. 자동 검사와 완료 기준

1. `tests/tauri-modal-design-contract.test.mjs`: 누군가 제목 크기/기본값을 다른 파일에 숫자로 덮어쓰면 실패한다. `Modal` 구조와 두 대화상자 계열이 공통 토큰을 사용함을 확인한다.
2. `scripts/receipt-audit-ui-smoke.mjs`: mock Tauri IPC에서 실제 React 화면을 열고 **23개 팝업 상태**, 339개 입력창 및 버튼 표본을 측정한다. 제목 18px, 닫기 높이, 가로 잘림, 스크롤 가능 여부, 푸터 경계와 실제 저장 확인창 배치를 검사한다.
3. 기존 Node/TypeScript/Rust/Windows SQLite 회귀 검사를 유지한다. 모달 UI 통과가 Windows EXE를 직접 열어 눈으로 검증했다는 뜻은 아니다.
4. UI 배율 90%/110%/125% 및 다른 화면 크기는 별도 8단계 교차 검증 대상이다. 검증되지 않은 조합을 통과했다고 보고하지 않는다.

새 모달을 추가할 때는 해당 기능의 실제 열기/닫기 경로를 브라우저 테스트에 추가하고, 기존 공통 컴포넌트로 기본 디자인을 상속한 뒤 필요한 예외만 리뷰한다.
