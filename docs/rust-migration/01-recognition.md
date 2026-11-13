# TSBH Rust 이전 세션 1 — recognition 인계 기록

**판정: Rust 컴파일 성공, 발주서 회귀 검증 실패/중단. 시연 빌드 통합 금지.**

## 저장소와 커밋
- 저장소: ThunderStrikerKR/TSBH (Public 변경 없음)
- 독점 브랜치: migration/01-recognition
- 공통 기준: d5ea8ed20b8120b844437263c2eb2b8963559e8d
- 선행 모델 선택 구현: 3f8e062e1e049b5297b0fd78a285dad7a679d6f5
- 마지막 소스 수정 커밋: 24e53a5acfc48301af14e5bf4a2fc201f5b20955
- 마지막 **Rust 컴파일 확인 커밋: `61dc08d428c3447fc0336a0f793587aa04b1b5c8`**, GitHub Actions에서 컴파일 성공 후 테스트 실행 확인. 전체 테스트 통과는 아님.
- 작업 경로는 사용자 지정 허용 경로로 제한. 기존 TS 및 공통 Rust/설정 파일은 미수정.

## 담당 소스 및 구현 상태

1. src-tauri/src/business_core/recognition/model.rs
   - 등록 판매상품 기준 이름/모델/색상/별칭 후보, 보면대 계열 타공/비타공, 별칭 충돌 판단.
   - 선행 커밋에서 작성됨. 아직 다른 모듈과 컴파일 검증되지 않음.
2. src-tauri/src/business_core/recognition/quantity.rs
   - 한국어 및 숫자 수량, 개/대/세트/EA/PCS, × 및 별도 표 수량 열, 모델 뒤 단독 수량.
   - 하이픈 모델의 -1과 옵션 괄호 뒤 명시된 -1개 구분.
3. src-tauri/src/business_core/recognition/mod.rs
   - execute 진입점, 배송건/수취인/연락처/주소와 행정구역 구성요소 추출, 상품 근거, 배송건 연결, 보수적 재분석.
   - UI에 넘기는 분석 원문 span은 UTF-16 코드 유닛 기준.
   - 기존 확정 필드 및 명확하게 식별된 상품 직원 확정값 보존.
4. tests/rust-migration/recognition/Cargo.toml 및 src/lib.rs
   - 운영 Rust 모듈을 실제 참조하는 독립 테스트 크레이트.
   - 변경하지 않은 기존 tests/audit-20-order-samples.test.mjs 20건을 직접 파싱하여 회귀 검사.
   - 독립 모델 규칙/별칭 충돌/수량 미확정 테스트 포함.

## 호출 계약

공개 Rust 함수:

    pub fn execute(operation: &str, payload: serde_json::Value)
      -> Result<serde_json::Value, String>

지원 작업:
- analyze_order: 입력 {raw: string, client: object|null, state: {products: [], aliases: [], clients?: []}}
  결과 {recipients: [], candidates: [], unassigned: []}. Recipient는 기존 name/address/phone/mobile/note/items/sources/candidates 등과 동일한 업무 의미를 갖게 작성. Item에는 productId/variantId/name/color/quantity/quantityConfirmed/unitPrice/origin/match/productCandidates/sources/recognitionReason/issues 포함.
- match_products: 입력 {text: string, client?: object, state:{products:[], aliases:[]}}. text 대신 raw 허용. 결과 productId/variantId/name/color/match/recognitionReason/productCandidates/evidence.
- reanalyze_order: 입력 {order: 기존 Order JSON, state:{products:[], aliases:[], clients?:[]}}. 결과 기존 주문을 복제하고 recipients 및 analysisEvidence를 갱신한 주문 JSON. manualClassification이 있으면 기존 주문 반환.

입력 상태가 잘못되거나 작업명이 지원되지 않으면 명시적 Err 반환.

## 기존 코드와의 차이 및 위험

- 기존 TypeScript의 핵심 호출은 parser.ts의 parseEvidence → order-evidence.ts의 analyzeEvidence → parseLegacy. 상품 후보는 product-name-match.ts의 registeredNameCandidates 등과 별칭 판정.
- Rust는 현 단계에서 **기능 동등성이 검증되지 않은 별도 구현**. 수량/수취인/주소/품목 매칭 결과를 비교해야 함.
- 수량을 찾지 못한 Rust 항목은 quantity=null, quantityConfirmed=false. TypeScript 일부 경로에서 미확정 잠정값 1을 두는 것과 표시값이 다를 수 있으나 임의 확정은 하지 않음.
- Rust 항목의 unitPrice=null은 가격 엔진 미호출을 나타냄. 가격/운임은 세션 2, 적용과 통합은 세션 3 책임.
- 새 임시 Recipient/Item ID는 recognition:recipient:번호 및 recognition:item:오프셋:번호 형식. TypeScript UUID와 다르므로 세션 3에서 요구사항 확인 필수.
- analyze_order 근거와 해당 상품 후보 오프셋은 UTF-16 전체 원문 기준. match_products의 evidence 및 후보 오프셋은 입력 text 내부의 UTF-16 상대 좌표로 변환하도록 수정했으나 실제 검증은 미완료.
- 보존은 유일하게 연결되는 수취인의 동일 원문 근거, 상품의 동일 raw 기준으로 수행. 복수 후보가 있으면 확정값을 임의 이관하지 않음.
- 분할 주소, 일부 비정형 OCR 표, 브랜드/옵션별 정책, 모든 원문 케이스의 동등성 검증은 미완료.
- TS 감사의 18/19/20번 오류는 선행 정보이며 Rust에서 고쳐졌다고 확인한 사실이 아님.

## 실제 검증 결과

확인:
- 원격 브랜치와 지정 기준선 확인.
- 변경 범위는 독점 인식 모듈, 전용 테스트, 인계 문서.
- 원본 20건의 JSON 배열을 추출해 1~20 번호 모두 존재함을 확인.
- 테스트 코드가 실제 운영 모듈을 참조하도록 작성. 모의 함수 아님.
- seed state 상품 360개, 별칭 0개임을 원격 저장소에서 확인.

미확인:
- 로컬 작업 환경에는 cargo/rustc가 없으나, GitHub Actions Rust 러너에서 컴파일 및 테스트 실행 확인 (run 43351947913).
- 20건 회귀 전체 통과 건수 미측정: `order_02`, `order_04` 실패 확인 후 실행이 취소되어 전체 완료 아님.
- Windows 실행 및 Tauri 연동, SQLite 영속, 가격/운임 연동 모두 미검증.

## 다음 담당자가 즉시 실행할 작업

우선 로컬 Rust 환경이 있는 별도 작업 디렉터리에서 다음 명령을 실행:

    git switch migration/01-recognition
    cargo test --manifest-path tests/rust-migration/recognition/Cargo.toml

오류 시 사용자 지정 허용 경로만 수정. 기존 테스트 기대값 변경/삭제 금지. 개별 검사:

    cargo test --manifest-path tests/rust-migration/recognition/Cargo.toml regressions::order_18 -- --nocapture
    cargo test --manifest-path tests/rust-migration/recognition/Cargo.toml regressions::order_19 -- --nocapture
    cargo test --manifest-path tests/rust-migration/recognition/Cargo.toml regressions::order_20 -- --nocapture

테스트 실패 시 실제 값과 원문 근거를 확보하고 mod.rs::analyze, model.rs::decide, quantity.rs::extract, mod.rs::reanalyze 순으로 결함 교정. 처리 후 마지막 검증 커밋 및 실패 항목을 이 문서에 기록.

## 세션 3 연결 요구

- 메인 src-tauri/Cargo.toml에 정규표현식 crate regex = "1" 추가 필요. serde_json은 기존 앱에 있음.
- Rust 비즈니스 모듈과 Tauri 명령 등록은 세션 3 담당.
- 기존 React/TypeScript parseEvidence 호출 시 타입, 주문 Item 필수 필드, 임시 ID, 근거 source, 가격 적용, 직원 확정값 병합을 비교.
- Windows EXE 시연 빌드는 독립 Rust 컴파일과 회귀 테스트 통과 이후에만 실시.
- 다른 두 세션의 파일 변경 및 병합은 하지 않음.

## 완료 상태

- [x] 등록 상품 후보 선택 로직 소스 존재(선행 커밋)
- [x] Rust 공개 진입점 및 원문 분석/재분석 초안
- [x] 수량/주소/연락처/수취인/상품 근거 코드
- [x] 실제 20건 원본 fixture를 참조하는 Rust 테스트 작성
- [x] 독점 브랜치 소스 커밋
- [x] Rust 컴파일 성공 (GitHub Actions, `61dc08d4`; 회귀 테스트는 미통과)
- [ ] 20건 Rust 회귀 실측 및 회귀 없음 입증
- [ ] TS 결과/신규 오류 비교
- [ ] JSON 스키마/기존 React 연결 실측
- [ ] Windows/Tauri 최종 통합(세션 3)

**결론: 작업 중이며 완료 판정 불가.**

## 2026-11-13 추가 검증 기록 (CI 소스 수정 이후)

- 소스 수정: `a46a61576448e712dad059584bbaf9f502669f1e` (후보 범위 변수 e 정정, find_term regex 임시 참조 수명 해결), `61dc08d428c3447fc0336a0f793587aa04b1b5c8` (quantity iterator 수명 해결).
- GitHub Actions: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43351947913
- 확인: 해당 커밋의 독립 Rust 크레이트는 컴파일에 성공하고 테스트 실행에 진입함.
- 확인된 회귀 실패: `recognition::tests::separate_recipients_and_utf16_spans` (기대 수취인 2명, 실제 결과 관련 필드 Null), `regressions::order_02` (배송건 2 / 기대 1), `regressions::order_04` (배송건 2 / 기대 1). 4번에서는 '택배'를 수취인명으로 판단하고 TEL 연락처 행을 상품 행으로 판단함.
- 실행 전체는 다른 워크플로 실행으로 취소되어 20건 최종 합격 건수 미확정. **컴파일 성공과 분석 정확성 합격은 구분할 것.**
- 다음 작업: 위 세 회귀 실패의 원문/분석 근거를 수정하고 전체 20건을 끝까지 통과시킬 것. TS JSON 계약 및 Windows 통합은 여전히 미검증.


## 2026-11-13: 20건 전체 실제 Rust 회귀 테스트 결과

- 테스트 대상 코드 SHA: `61dc08d428c3447fc0336a0f793587aa04b1b5c8`
- 실행: GitHub Actions run `43351947913`, 재실행한 격리 Linux Rust 작업 `131646314040`
- 링크: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43351947913
- **Rust 컴파일 성공**. 테스트 31개 중 16개 통과 / 15개 실패.
- 발주서 20건: **6건 통과 / 14건 실패**. 통과 번호: **07, 08, 09, 10, 16, 18**.
- 개별 다른 단위 테스트는 10개 통과 / 1개 실패: `recognition::tests::separate_recipients_and_utf16_spans`의 첫 상품 수량 `null`(기대 2). 선행 전화번호 행을 상품으로 잘못 인식한 영향 여부를 조사해야 함.
- 이 결과는 **실제 Cargo test 로그** 기준이며 원래 JS 감사 테스트 기대값은 변경하지 않았음.

| 번호 | 실제 판정 | 원인 또는 테스트 증상 |
| --- | --- | --- |
| 01 | FAIL | 두 휴대전화 행이 수량 미확정 가짜 상품 2개로 생성. 실제 품목 708-1(30), CONDUCTOR(1), Cart-10(2)은 식별 |
| 02 | FAIL | `선출고부탁`을 이름으로 오인하여 1건 대신 2건 생성 |
| 03 | FAIL | `104,000`, `6,000`, `110,000 + 부가세`, 이름/연락처 행을 가짜 상품으로 생성 |
| 04 | FAIL | `택배` 이름 오인, `가상월드` 별도 배송건, `TEL 031-...` 가짜 상품 생성. 250CC 크롬은 SKU 이름과 variant.color=색상 미표기 불일치로 미확정 |
| 05 | FAIL | `010-...`을 추가 상품으로 오인 (Z-1 자체는 수량 1 확보) |
| 06 | FAIL | 수량 미기재 상품은 미확정 유지했으나 전화번호를 추가 상품으로 오인 |
| 07 | PASS | 현행 배송건/수량 테스트 조건 통과 |
| 08 | PASS | 현행 배송건/수량 테스트 조건 통과 |
| 09 | PASS | 현행 배송건/수량 테스트 조건 통과 |
| 10 | PASS | 현행 배송건/수량 테스트 조건 통과 |
| 11 | FAIL | `번호 : 010-...`을 가짜 상품으로 오인 |
| 12 | FAIL | `배가상 010-...`을 가짜 상품으로 오인 |
| 13 | FAIL | `SSB 2EA`에서 상품 미인식. 수량 근거만 unassigned, 705(1)가 첫 배송건으로 잘못 귀속되고 둘째 배송건 품목이 비어 있음 |
| 14 | FAIL | `휴대전화 : 010-...`을 가짜 상품으로 오인 |
| 15 | FAIL | `김가상 010-...`을 가짜 상품으로 오인 |
| 16 | PASS | 현행 배송건/수량 및 기관명 구분 테스트 조건 통과 |
| 17 | FAIL | 두 배송건에서 휴대전화를 가짜 상품으로 각각 추가 |
| 18 | PASS | 현행 수취인/709 민판 확인 테스트 조건 통과 |
| 19 | FAIL | Rust 패닉: `end byte index 162 is not a char boundary`. 표의 재구성 텍스트 오프셋을 원문 바이트 위치에 그대로 적용한 문제 의심 |
| 20 | FAIL | `납품장소`를 독립 수취인으로 오인하여 배송건 2개. 수량 1은 얻었으나 quantity 근거 text가 `| | -`로 잘못 연결됨 |

### 실패 원인 그룹과 수정 우선순위

1. **P0: 원문 근거 인덱스 안정성.** `mod.rs::analyze`에서 표 문자열을 `join(" | ")`으로 다시 만들면 원본 바이트 위치와 맞지 않는다. 19번 패닉과 20번 근거 오염을 실제 byte-char boundary 검증 및 원문 구간 보존으로 해결해야 한다.
2. **P0: 비상품 행 상품 오인 방지.** `mod.rs::product_signal`의 광범위한 모델 번호 정규식이 `010-...`, `TEL 031-...`, `104,000`을 상품으로 통과시킨다. 전화번호, 금액, 결제, 개인정보 행을 원문 문맥으로 선제 분리하고 상품 신호는 등록 상품/별칭 및 명시적 모델 증거 기반으로 제한해야 한다.
3. **P0: 배송건 귀속.** 13번 `SSB` 미인식으로 705가 첫 배송건에 잘못 연결됨. 상품 미인식과 배송건 경계 추론을 분리하고, 선행 품목을 다음 수취인에 연결하는 규칙을 단독 테스트로 보강.
4. **P1: 이름/기관/표제어.** 02/04/20의 `선출고부탁`, `택배`, `납품장소` 오인. 길이 2~5의 한글이라는 사실만으로 이름으로 확정하지 말고 명시적 수취인 레이블, 배송건의 실제 근거, 문맥을 우선.
5. **P1: 상품 데이터 대조.** 250CC의 명칭은 크롬, 등록 `variant.color`는 색상 미표기. 자동 확정 규칙을 임의로 완화하지 않고 데이터-정식 판매구성 간 의미를 확인.
6. 테스트 통과한 6건에서도 모든 상품 ID, 색상, 상세주소, 오프셋까지 검증하는 것은 아님. 이후 구체 필드 기대값을 추가해 계약 검사를 강화할 것.

**중요:** 이번 작업에서는 테스트 실행 및 원인 조사만 수행했고, 위 코드 결함은 아직 수정하지 않았다. Rust 독립 테스트 컴파일 가능과 업무 회귀 통과를 혼동하지 말 것. React/Tauri/Windows 전체 통합 검증은 별도 필요.
