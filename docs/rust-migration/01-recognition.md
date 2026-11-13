# TSBH Rust 이전 세션 1 — recognition 인계 기록

**최신 판정 (2026-11-13): Rust 독립 CI 50/50 통과, 발주서 20/20 통과, 등록 상품 360건 전수 테스트 수행. 잘못된 활성 SKU 확정 0건. 활성 상품 16건은 데이터/표기 모호성으로 미확정. TypeScript 전체 필드 동등성 및 Windows/Tauri 통합은 미검증.**

## 저장소와 커밋
- 저장소: ThunderStrikerKR/TSBH (Public 변경 없음)
- 독점 브랜치: migration/01-recognition
- 공통 기준: d5ea8ed20b8120b844437263c2eb2b8963559e8d
- 선행 모델 선택 구현: 3f8e062e1e049b5297b0fd78a285dad7a679d6f5
- 초기 소스 수정 기록: 24e53a5acfc48301af14e5bf4a2fc201f5b20955 (현재 최신은 문서 최하단 참조)
- 초기 **Rust 컴파일 확인 커밋: `61dc08d428c3447fc0336a0f793587aa04b1b5c8`** (과거 이력). 최신 50개 회귀 통과 커밋은 문서 최하단 참조.
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

## 기존 코드와의 차이 및 위험 (초기 조사 당시 기록)

- 기존 TypeScript의 핵심 호출은 parser.ts의 parseEvidence → order-evidence.ts의 analyzeEvidence → parseLegacy. 상품 후보는 product-name-match.ts의 registeredNameCandidates 등과 별칭 판정.
- Rust는 현 단계에서 **기능 동등성이 검증되지 않은 별도 구현**. 수량/수취인/주소/품목 매칭 결과를 비교해야 함.
- 수량을 찾지 못한 Rust 항목은 quantity=null, quantityConfirmed=false. TypeScript 일부 경로에서 미확정 잠정값 1을 두는 것과 표시값이 다를 수 있으나 임의 확정은 하지 않음.
- Rust 항목의 unitPrice=null은 가격 엔진 미호출을 나타냄. 가격/운임은 세션 2, 적용과 통합은 세션 3 책임.
- 새 임시 Recipient/Item ID는 recognition:recipient:번호 및 recognition:item:오프셋:번호 형식. TypeScript UUID와 다르므로 세션 3에서 요구사항 확인 필수.
- analyze_order 근거와 해당 상품 후보 오프셋은 UTF-16 전체 원문 기준. match_products의 evidence 및 후보 오프셋은 입력 text 내부의 UTF-16 상대 좌표로 변환하도록 수정했으나 실제 검증은 미완료.
- 보존은 유일하게 연결되는 수취인의 동일 원문 근거, 상품의 동일 raw 기준으로 수행. 복수 후보가 있으면 확정값을 임의 이관하지 않음.
- 분할 주소, 일부 비정형 OCR 표, 브랜드/옵션별 정책, 모든 원문 케이스의 동등성 검증은 미완료.
- TS 감사의 18/19/20번 오류는 선행 정보이며 Rust에서 고쳐졌다고 확인한 사실이 아님.

## 실제 검증 결과 (초기 조사 당시 기록)

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
- [x] Rust 컴파일 및 전체 독립 테스트 성공 (GitHub Actions, 최신 50개 통과; 문서 최하단 확인)
- [x] 20건 Rust 회귀 실측: 원본 발주서 표본 20건 모두 합격 (최신 CI 43364615494)
- [ ] TS 결과/신규 오류 비교
- [ ] JSON 스키마/기존 React 연결 실측
- [ ] Windows/Tauri 최종 통합(세션 3)

**최신 상태는 문서 최하단 재이식 검증 결과 참조. 독립 테스트 통과와 TypeScript 전 필드 동등성 및 Windows 통합은 구분한다.**

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


## 2026-11-13 최종: TypeScript 원본 기준 Rust 인식 로직 재이식 및 CI 실측

- 재이식 소스 기준선: src/parser.ts (person, logicalLines, parseLegacy, reanalyzeWithAliases), src/order-evidence.ts (analyzeEvidence, matchingRecipient), src/product-name-match.ts. TypeScript 파일/테스트 원본은 변경하지 않음.
- Rust 모듈: src-tauri/src/business_core/recognition/ts_semantics.rs (원본에서 파생한 처리 조건 및 함수), mod.rs (문서 근거 수집과 수취인/상품 귀속, 다중행 주소와 메모, 재분석), model.rs (기존 상품 매칭).
- 명시적으로 이전하여 검증한 규칙: 거래처 문서의 금액/헤더 및 연락처 제외, 수취인/기관과 배송 요청 문구 분리, 주소 앞 모델/수량 우선순위, 원본 표 문자열을 재조합하지 않는 수량·상품 근거 추출, 전화번호-주소 혼입 방지, 두 배송건의 상품 귀속, 괄호 메모, 들여쓰기 상세주소, 단일 수취인 근거 기반 직원 확정값 연결, 수동 분류 false와 true 구분.
- 테스트: tests/rust-migration/recognition/src/lib.rs가 기존 tests/audit-20-order-samples.test.mjs의 20건 원문과 기대 배송건/수량을 재사용. 13번 SSB와 705의 서로 다른 배송건 귀속, 19/20번 모든 근거의 실제 UTF-16 원문 좌표, 동일 원문 재분석, 07/08번 주소와 전화번호 분리, 08번 배송 메모 및 09번 상세주소 연속 행을 추가 검증.
- **최신 테스트 대상 코드 SHA: f49015bef8fe901ca349054a67b110fffdfb73da.**
- **GitHub Actions: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43356394941**
- **Linux 독립 Rust Cargo test: 39개 통과 / 0개 실패**, 컴파일 성공. 그중 **20건 발주서 표본: 20개 통과 / 0개 실패**. 로그에서 39개 테스트 및 20개의 order_XX 통과를 확인함.
- 이 섹션 이전의 6/20 및 16/20 기록은 이전 커밋의 역사적 실패 내역이며 최신 상태를 뜻하지 않는다.
- **아직 완료로 보고하면 안 되는 범위:** TypeScript parseEvidence와 Rust analyze_order가 모든 JSON 출력 필드(상품ID, 색상, 모델 후보, 발주서 특수 형식, 가격, note/근거 등)에서 동일한지 양측 엔진을 구동해 비교한 전체 differential test는 미실시. 모델 색상/별칭/브랜드 우선순위와 일부 특수 문서의 완전한 함수 단위 동등성도 미검증. 20건 수량 테스트 통과만으로 전체 알고리즘의 완전 동등성을 주장할 수 없음.
- Windows Tauri 앱 빌드, UI 연동, 전역 serde_json/regex 의존성 및 주문 워크플로 통합은 세션 3 담당. 이 세션에서는 다른 세션의 파일을 변경하지 않음.
- 이 섹션과 이후 추가 작업은 반드시 TypeScript 소스 대비 차이를 명시하고, 단순히 기존 Rust 추정 규칙을 기준으로 새 업무 판단을 추가하지 말 것.


## 2026-11-13 P0: TypeScript 원본 기준 불일치 수정 및 47개 Rust 회귀 통과

### 작업 범위 및 확인된 기준선

- 기준 브랜치: migration/01-recognition. 작업 시작 시 SHA: eae9881c244bbc64e1a65e89c8998b9e2a8fa529.
- 기준 소스: src/parser.ts, src/order-evidence.ts, src/product-name-match.ts, src/domain.ts::itemFromProduct, src/product-registry.ts::brandTerms.
- 수정 파일: src-tauri/src/business_core/recognition/model.rs, mod.rs, quantity.rs 및 tests/rust-migration/recognition/src/lib.rs. 테스트 기대값, 원본 TypeScript, 다른 세션 파일 및 공통 Cargo.toml은 수정하지 않았다.
- 임의의 업무 규칙을 더하지 않고 기존 TypeScript의 결정 조건을 Rust로 이식했다. 표본 20건 모두 동일 원문을 그대로 사용한다.

### 변경 사항

1. order-evidence.ts common/each 규칙: 공동 상품의 총수량을 배송건마다 복제하지 않고 명시적인 '각각', '씩' 표현 또는 배송건별 독립 수량 근거가 있을 때만 해당 배송건 수량을 확정한다.
2. domain.ts::itemFromProduct 및 parser.ts: requiresOption=true / 복수 variant면 임의 variantId를 선택하지 않는다. 단일 variant도 명시적 색상과 충돌하면 확정하지 않는다. 기본 색상, defaulted, url, catalog, origin, 상품 표시명 및 issues를 TypeScript 계약에 맞게 생성한다.
3. parser.ts::parseLegacy 필터: 브랜드/브랜드 별칭이 발주서에 있을 때 brandTerms로 등록 상품을 제한한다. BANDOMALL에 대한 코드 우선순위와 DEMO 상품 제외 우선순위를 추가했다.
4. parser.ts::modelColorHint, registeredColorHint: 숫자형 모델의 B, BK, BR, C, W, G 접두/접미 색상과 괄호 색상을 처리한다. 실제 등록된 모델 코드와 충돌하면 기존 모델을 보호한다.
5. parser.ts::quantities: 치수 x10cm 및 x10mm, 단위 오탐 1EAS를 수량으로 인식하지 않고, 실제 수량 '* 1EA'는 추출하도록 경계 조건을 원본과 동등하게 분기한다. 판매단위 '2개 구성'은 별도 수량으로 확정하지 않는다.
6. order-evidence.ts 메모/상품 경계: 메모 연속 행 다음에 등록 상품 코드가 나오면 상품 행으로 분석한다.
7. 가격: itemFromProduct의 인식 결과 스냅샷을 복원하기 위해 src/domain.ts::resolvePrice와 동일한 거래처 등급 및 특별 단가 계산을 인식 출력용으로 구현했다. 별도 가격 및 운임 엔진은 세션 2 소유이며, 세션 3 통합 시 비교해야 한다.

### 실제 Rust 회귀 테스트

- 최종 검증 소스 SHA: df2fc32e708c9d07ccd195ab9105781d4e13443e
- GitHub Actions: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43359770110
- Linux 독립 Rust Cargo test: **47 passed / 0 failed**. 빌드 성공. 발주서 표본 20건 **20 passed / 0 failed**.
- 신규 P0 테스트 7개 모두 PASS: common_total_is_not_copied_to_every_recipient_without_each_evidence, source_requires_option_keeps_variant_unconfirmed, source_item_color_default_url_catalog_and_price_snapshot, original_brand_and_catalog_candidates_are_filtered, original_model_color_prefix_and_suffix, note_stops_when_next_line_is_registered_product, bundled_sale_unit_does_not_become_order_quantity.
- quantity.rs에 추가한 original_type_script_quantity_boundaries 테스트도 PASS. 기존 quantity 테스트와 20건 본래 기대값을 변경하지 않았다.
- 최초 시험 43359275893에서는 45 passed / 2 failed (x/EA 수량 필터 과제한). 수량 필터를 정정한 후 최종 43359770110에서 47 passed / 0 failed. 이전 실패 시험을 성공으로 덮어 쓰지 않는다.

### 남은 제약과 통합 주의

- 47개 회귀 통과는 정의된 테스트 조건의 통과이지 원본 TS/Rust 전 입력 및 전 JSON 필드 differential test 완료가 아니다.
- 가격 스냅샷의 단가 원본과 세션 2 Rust 가격 엔진을 비교하는 통합 테스트, Windows Tauri 연동 및 EXE 빌드는 **미실행**.
- 이 브랜치는 세션 1 인식 모듈만 수정했다. 다른 세션 파일의 병합, 앱 설정과 Cargo.toml 수정, 기존 TS 기준선 수정은 하지 않았다.
- 임시 합성 데이터로 검사한 brand / catalog / requiresOption / 복수 옵션 관련 규칙은 초기 seed의 360개 단일 SKU만으로는 검증할 수 없으므로 별도 테스트를 유지해야 한다.


## 2026-11-13: 상품 360건 실측 전수검사 결과 — 최신 상태

### 검증 원본 및 범위

- immutable 입력 데이터: src-tauri/resources/state-seed.json, blob b1d529237b8cea5a0b91eb8b826e94b5b607484f.
- 총 상품 360개. 이 중 활성 358개, inactive=true 및 supersededBy가 지정된 후속 SKU 교체 2개.
- 실제 Rust 실행 경로: tests/rust-migration/recognition/src/catalog_audit.rs가 src-tauri/src/business_core/recognition/mod.rs의 match_products를 호출. 가짜 엔진 및 예상값 하드코딩으로 전체 결과를 대체하지 않았다.
- 시험 집합: 등록 상품명 360개 전부, 고유 모델명(이름의 첫 / 이전 부분을 공백 제거한 기준) 289개, 정상적으로 등록된 색상과 모델의 의미 있는 입력 조합 84개. 이전 데이터 단순 집계의 78개보다 실제 시험 조합이 큰 것은 한글 색상값과 영문 색상값의 정규화 범위를 확장했기 때문이다.
- 중복 원본 데이터: 동일 상품명 7개 그룹, 총 14개 활성 SKU (마이크물림쇠 세트 관련); 해당 이름만으로 단일 SKU 확정 금지.
- 등록 기본 색상 값 '색상 미표기' 267개. 이 중 이름에 색상 단서가 있으나 등록된 색상값과 불일치하는 사례도 존재.

### 최종 동적 분석 실측

- **검증 소스 SHA: c92de3fca0c80fa4b74db0484dc6b581aab37bf6**
- **GitHub Actions run: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43364615494**
- **독립 Cargo test: 50 passed / 0 failed** (47개 기존 회귀/기타 테스트 + 전수감사 2개 + 등록 모델 접미 문자 보호 테스트 1개).
- 원본 발주서 20건: **20/20 PASS**.
- 등록명 360회 결과:
  - 정확한 활성 SKU 확정: **328**
  - 비활성/대체된 과거 SKU에서 등록된 후속 활성 상품으로 올바르게 연결: **2**
  - 완전히 동일한 이름을 가진 복수 활성 SKU를 안전하게 미확정: **14**
  - 개별 등록명으로도 확정 불가: **16**
  - 잘못된 활성 SKU 선택: **0**
  - 동일 이름에 대해 임의로 한 SKU를 선택한 사례: **0**
  - 합계 328+2+14+16=360.
- 모델명 289회: 고유 모델 확정 250, 미확정 39, 모델 계열 밖 잘못된 확정 0, 모호한 후보 임의 확정 0.
- 모델+등록 색상 84회: 고유 SKU 확정 82, 미확정 2, 잘못된 확정 0, 모호한 후보 임의 확정 0.
- 미확정 16건은 안전한 미확정이므로, **자동확정 정확도/안전성 시험 통과를 '360건 전부 자동확정 성공'으로 보고하지 말 것**.

### 활성 상품 16건 미확정 목록 및 원인

| 원인 | 상품 ID | 등록 상품명 |
| --- | --- | --- |
| 공백 정규화에 따른 다중 후보 | bando-site-81 | 마우스트레이 |
| 상품명에 색상은 있으나 variant/defaultColor='색상 미표기' | bando-site-104 | BD 911R / 레드 |
| 동상 | bando-site-337 | BD Floor-BTS / 블랙 / 높이 27cm |
| 동상 | bando-site-334 | BD Desk-BTS / 블랙 / 높이 27cm |
| 동상 | bando-site-324 | BD Floor TS-3 / 실버 / 높이 32cm |
| 동상 | bando-site-323 | BD Floor TS-2 / 실버 / 높이 22cm |
| 동상 | bando-site-322 | BD Floor TS-1 / 실버 / 높이 17cm |
| 동상 | bando-site-321 | BD FloorJS-4BK / 블랙 / 자바라 길이 60cm |
| 동상 | bando-site-320 | BD FloorJS-3BK / 블랙 / 자바라 길이 43cm |
| 동상 | bando-site-319 | BD FloorJS-2BK / 블랙 / 자바라 길이 35cm |
| 동상 | bando-site-252 | BD Desk IS-1 / 블랙 / Bar 길이 10cm |
| 동상 | bando-site-251 | BD Desk IS-2 / 블랙 / Bar 길이 15cm |
| 동상 | bando-site-250 | BD Desk IS-3 / 블랙 / Bar 길이 26cm |
| 동상 | bando-site-249 | BD Desk TS-3 / 실버 / Bar 길이 32cm |
| 동상 | bando-site-248 | BD Desk TS-2 / 실버 / Bar 길이 22cm |
| 동상 | bando-site-247 | BD Desk TS-1 / 실버 / Bar 길이 15cm |

### 근본 원인 수정 및 데이터 보호 정책

- 이전 360건 감사에서 등록명만으로 미확정인 상품은 28, 잘못 연결된 것으로 잠정 분류된 2건이 있었다.
- 검사 결과 그 2건은 실제로 active=false 및 supersededBy 지정이 존재했고, 정상 후속 SKU로 연결된 것임을 확인해 감사 기준을 교정했다.
- 700W, 801C, 719B, 930BK 등의 정식 모델명 끝 문자(W/C/B/BK)를 실제 색상 약자로 재해석하던 Rust 버그는 원본 parser.ts::protectedCode에 맞춰 고쳤다. 해당 회귀 테스트를 고정했다. 이 변경 후 등록명 미확정 수가 28에서 16으로 감소했다.
- 남은 15개 등록 색상 누락을 코드에서 임의로 'Black' 또는 'Silver'로 확정하여 테스트를 통과시키지 않았다. 상품 데이터 원본의 색상 표준화 확인이 필요하다.
- 마우스트레이와 마우스 트레이의 중복은 사용자 확인 완료된 기존 데이터 예외다. 세션 1에서 중복 제거/표준화/데이터 수정은 하지 않으며 후속 오류 조치 대상에서 제외한다. 단, 이름이 모호할 때 임의 SKU 확정을 하지 않는 안전 검증은 유지한다.
- 독립 rust 모델 파일의 정규표현식 컴파일만 캐시했다. 후보 판단·업무 로직 조건을 바꾸지 않는 성능 개선이며 Rust CI 50개 전체 재검증을 수행했다.

### 세션 경계와 남은 검증

- 작업은 src-tauri/src/business_core/recognition/** 및 tests/rust-migration/recognition/**, 이 문서 경로로 한정했다.
- 상품 원본 seed, TS 원본, 별도 세션 2 가격/운임, 세션 3 Tauri 연동, 공통 설정 파일은 수정하지 않았다.
- 이번 테스트는 Rust 360개 실데이터 인식 검증이다. **TypeScript와 Rust의 동일 JSON 출력 전체 필드 differential 검증은 아직 미수행.**
- Windows Tauri/React 실행 및 엔진 통합, 운영 SQLite 실측은 세션 3 소관이며 이번 시험 범위 밖.

### 2026-11-13 사용자 결정: 중복 상품의 조치 대상 제외

- 사용자가 **마이크물림쇠 세트(동일 등록명 7그룹 / 활성 SKU 14개)** 및 **마우스트레이/마우스 트레이(활성 상품의 정규화 충돌 1건)** 중복을 이미 인지하고 있으므로 이 두 범주는 **알려진 데이터 예외(accepted exception)** 로 분류한다.
- 이 중복을 해결하기 위한 명칭 변경, 상품 병합, 삭제, 별칭 자동 생성 및 데이터 정규화는 **이번 세션의 후속 작업에서 제외**한다.
- 실제 주문에서 구분 근거가 부족할 때는 기존처럼 미확정 상태를 유지한다. **무시한다는 지시는 위험한 임의 SKU 확정 허용을 뜻하지 않는다.**
- 360개 실측 분류: 활성 상품의 올바른 직접 확정 328건, 후속 활성 SKU 매핑 2건, 승인된 마이크물림쇠 중복 14건, 승인된 마우스트레이 중복 1건, **별도 조치가 필요한 색상 미표기 15건**. 합계 360건. 이 분류는 기존 CI 실측값을 변경하지 않은 사용자 결정에 따른 업무 분류이다.
- 다음 세션 1 작업은 **색상 미표기 15건**, TypeScript/Rust 전 필드 결과 동등성 검증 및 다른 인식 예외를 대상으로 한다. 기존 50개 Rust 테스트와 중복 SKU 오확정 방지 테스트는 삭제하거나 완화하지 않는다.
