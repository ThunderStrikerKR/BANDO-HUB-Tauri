# TSBH Rust 이전 세션 1 — recognition 인계 기록

**최신 판정 (2026-11-13): 수취인/근거 실엔진 동등성 44건에서 39건 완전 일치(근거 배열은 위치/ID로 대응), 기존 78개 차이를 Rust 소관 수정으로 65개로 축소. 남은 65개는 TypeScript 원본의 수취인/주소/품목 오인식 5개 입력에 한정하며 정확한 TS/Rust 값으로 CI 예외 검증. 재분석 9건 중 8건 일치, 나머지 5개 차이는 원본 TS의 오래된 recipientId. 상품 Item 35건 중 32건 일치, TS 원본 문제 22개만 남음. Rust 독립 CI 57/57 통과. 세션 1 독점 파일만 수정, 전체 기능 완전동등성 및 Windows/Tauri 통합 미완료.**

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


## 2026-11-13: 원본 기준 색상 불일치 15개 SKU 정정안 검증

### 확인된 원인 및 데이터 기준

- source: src-tauri/resources/state-seed.json (등록 제품명/variant ID/등록 상세페이지 URL 포함), TypeScript src/parser.ts, src/product-name-match.ts, src/domain.ts의 itemFromProduct, validateProduct.
- 15개 상품의 이름에 각각 명시된 블랙, 실버, 레드 값이 defaultColor/variants[0].color 양쪽에서 모두 '색상 미표기'인 데이터 불일치다.
- TypeScript도 실제 variant.color를 근거로 명시 색상과 대조하므로, **인식 로직에서 색상 불일치를 무시하거나 자동 추측해 확정하는 것은 TypeScript 동등성을 훼손**한다.
- 정정 대상: Red 1개(bando-site-104); Black 8개(bando-site-337, 334, 321, 320, 319, 252, 251, 250); Silver 6개(bando-site-324, 323, 322, 249, 248, 247).
- 색상 근거는 현재 **상품 원본 데이터에 기록된 정식 상품명**의 단독 슬래시 옵션(레드/블랙/실버)이다. 외부 상세페이지의 최신 현행 상태까지 확인했다는 뜻은 아니다.
- 등록 SKU와 단일 variant ID, 원본 상품명, 기존 색상값, 등록 URL, 활성 상태까지 확인해야만 정정하도록 안전 검사한다.

### 적용 가능한 결과물과 검증

- JSON 정정 명세: tests/rust-migration/recognition/catalog-color-corrections-15.json (15개 SKU, expectedName 및 variantId, 색상 Before/After, 기존 source URL 명시).
- 사전 확인/별도 데이터 소유 세션 적용 도구: tests/rust-migration/recognition/apply-catalog-colors.mjs
  - 검사만: node tests/rust-migration/recognition/apply-catalog-colors.mjs --check
  - 실제 seed 반영: node tests/rust-migration/recognition/apply-catalog-colors.mjs --apply
  - 스크립트의 seed 정정은 운영 SQLite 데이터 이관이 **아니다**. 운영 앱 데이터 정정과 동기화 책임은 별도로 확인해야 한다.
- 실제 Rust CI 실행: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43366087879
- 테스트 대상 소스 SHA: f6fc17d3d7c13b9cf61fc66f4e2f8c41b7bdf573
- cargo test 결과: **51 passed / 0 failed**. 기존 발주서 **20/20 PASS**.
- 새 테스트 fifteen_registered_title_colors_become_matchable_after_validated_data_repair:
  1. 원본 360개 데이터 복제 후 15개만 두 색상 필드를 수정하고 상품명·원본 옵션·URL·활성 여부가 여전히 일치하는지 확인
  2. 정정한 SKU 15개 전부 원본 상품명을 입력하여 올바른 productId와 variantId, color를 받는지 검증 (**15/15 PASS**)
  3. 나머지 **345개 상품 데이터 불변** 확인
  4. 오리지널 seed 파일과 운영 SQLite는 시험 과정에서 **수정하지 않음**
- 정정 후 실제 등록명 전수검사 360건 전체의 새로운 요약 통계는 계산하지 않았다. 기존 seed 기준 실측은 정상 확정 328, 대체 SKU 2, 중복 예외 14, 활성 미확정 16(그중 마우스트레이 1)이다. 정정안을 적용한 15개 별도 테스트가 전부 PASS인 사실과 혼동하지 않는다.

### 세션 1 역할 경계 및 인계

- 이번 세션은 인식 모델의 색상 후보 필터를 느슨하게 만들지 않고 **정정 목록과 검증 코드만 소유 경로에 추가**했다.
- **현재 공용 src-tauri/resources/state-seed.json 파일은 변경하지 않았다.** 이는 병렬 세션 2/3 및 3/3의 공유 자원을 손대지 않는 원래 작업 경계 때문이다.
- 실제 상품 원본 정정(단일 variant.color + defaultColor 각 15개)은 데이터 변경 권한을 가진 통합 담당자가 적용한 후 전체 CI/앱 통합 테스트에서 검증해야 한다.
- 사용자 승인으로 제외한 마이크물림쇠/마우스트레이 중복은 이번 색상 정정에 포함하지 않았다.


## 2026-11-13: 실제 TypeScript/Rust 상품 매칭 전 필드 차등 비교 — 최신 판정

### 실제 원본 실행과 동등성 판정

- 검증 대상 소스: 513369276af3aeab8917f81d2f08f060ee78112d.
- CI 실행 및 로그: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43371988997
- Rust 기존 회귀 및 차등 감사 실행: **52 passed / 0 failed**. 이는 테스트가 정상 실행된 결과이지 동등성 0건을 입증한 것이 아니다.
- 테스트 코드: tests/rust-migration/recognition/src/differential.rs, tests/rust-migration/recognition/compare-ts-rust.mjs.
- 실제 생산 TS src/parser.ts의 parseEvidence 함수를 tsx/esm/api로 직접 import하고, Rust src-tauri/src/business_core/recognition/mod.rs의 analyze_order를 동일 raw/client/state로 실행했다. TS 알고리즘 재구현이나 예상 결과 수기 대체를 하지 않았다.
- 상태: 원본 seed를 복사해 기존 색상 정정 15건을 양쪽 엔진의 인메모리 상태에만 동일하게 적용했다. 실제 공용 seed 및 운영 SQLite는 변경하지 않았다.
- 입력: 색상 정정 15개 상품의 상품명+수량을 포함한 주문과 원본 발주서 20건, 총 35건.
- Item 모든 키, 누락 키, match, productCandidates, issues, sources까지 재귀 비교했다. 임의 생성 UUID/대상 ID만 정규화하고 필드 존재 여부는 비교했다.
- 원본 TS가 앞에 추가 상품을 만든 경우는 상품 ID와 raw로 대응시키고 추가 항목을 별도로 기록했다. Rust 전용 match_products는 TS에 직접 대응하는 공개 진입점이 없고 비교 입력이 달라 동일 입력 차이 건수에서 제외했다.
- **전체 219개 실제 필드 차이 JSON:** tests/rust-migration/recognition/ts-rust-product-differential-20261113.json. CI 로그 219건 전부 저장.

### 결과

- **35개 입력, 1,478개 하위 필드 비교, 차이 219개, 차이가 있는 입력 35개.**
- 자주 발생한 차이: match.aliasId 39건, productCandidates.end 36건, productCandidates.label 36건, recognitionReason 36건, match.term 25건, productCandidates.start 17건. 단순한 undefined/null 구조 차이와 UI가 쓰는 상품 후보 범위/표시 차이가 섞여 있으므로 무조건 무시하지 않는다.
- 상품 ID 확정의 실제 차이는 **1건:** BD 911R / 레드. 나머지 색상 정정 14개는 양쪽에서 동일한 상품 ID를 확정했다.
- 원본 발주서 **19번과 20번**에서는 TS가 발주일자의 2026 또는 2026-11-03을 가짜 미등록 상품으로 추가하고 Rust는 추가하지 않는다. 실제 상품의 quantity는 TS null / 미확정, Rust 1 / 확정. 해당 표본의 원래 기대 수량은 1이다. TypeScript 원본의 잘못된 상품 생성을 Rust에서 다시 재현해서는 안 된다.
- 기타 상품명/raw 범위: 원본 05/13번 표시명, 08/18/19번 원문 범위 등에서 출력 계약 차이가 있다.
- 이 검사는 35개 지정 입력의 전 필드 비교이지, 가능한 모든 입력의 완전한 동등성 증명은 아니다.

### BD 911R 불일치의 원인

- 두 엔진 모두 등록 후보 bando-site-104를 검출한다. 교정된 variant.color와 defaultColor는 Red이다.
- TS src/parser.ts에는 레드라는 색상 단어가 등록되어 있으나 src/domain.ts의 normalizeColor 색상 별칭에는 red 및 빨강만 있고 **레드 -> Red**가 빠져 있다.
- 따라서 TS는 레드와 Red를 다르게 판단하여 productId=null, variantId=null, match.kind=UNKNOWN을 반환한다.
- Rust norm_color는 레드 -> Red를 지원해 productId=bando-site-104와 variantId=bando-104-single로 연결한다.
- 이 문제를 감추기 위해 Rust를 원본 버그대로 퇴행시키지 않는다. TypeScript 원본 소스가 공통 소유 파일이므로 세션 1에서는 수정하지 않았고, 데이터/통합 책임자와 조정이 필요하다.

### 후속 처리

1. 상품 후보 label/start/end, match.term, aliasId, recognitionReason의 undefined/null와 표현 계약을 원본 및 UI 소비 기준에 맞춰 대조 후 수정.
2. 원본 19/20번의 날짜 가짜 상품과 Rust 수량 확정은 별도 의도적 개선/원본 버그 분류를 보존하고 통합 시 확인.
3. 직원 확정값 보존, 재분석 및 추가 실발주서에 대한 동일 입력 전 필드 비교 확대.
4. 현재 테스트는 불일치를 숨기지 않고 상세 로그에 남기는 **감사 테스트**이며 차이 0개를 강제하는 parity gate는 아니다. 전체 이식 완료로 보고 금지.
5. 세션 2 가격/운임 및 세션 3 Tauri/React/Windows 연결, 공용 seed, 운영 SQLite, 원본 TS 파일은 수정하지 않았다. 마이크물림쇠/마우스트레이 중복은 사용자 승인대로 예외로 유지한다.


## 2026-11-13: P1 전체 필드 불일치 197개 수정 및 예외 게이트 완료

### 실제 수정 범위 및 측정 근거

- 기준: 이전 실제 TypeScript `parseEvidence()` 대 Rust `analyze_order()` 감사, 35건/1,478개 leaf 비교, **219개 불일치**.
- Rust 구현 수정: `src-tauri/src/business_core/recognition/mod.rs`만 변경. TS 원본 동작을 재구현한 가짜 comparator, 기존 주문 표본 기대값 변경, 공용 상품 원본 수정 없음.
- 구현한 개선: (1) `productCandidates`의 색상 포함 표기(`colorLabel`) (2) 후보 `start/end`를 TS의 행 내부 위치로 재배치 (3) 없는 `aliasId` 및 `recognitionReason`은 null이 아닌 필드 생략 (4) 등록 SKU와 3자리 모델 코드의 `match.term` 선택 규칙 (5) 미등록 상품명 뒤 수량 제거 (6) 상품과 수취인/연락처가 같은 행의 `raw` 분리 (7) 번호형 표 열과 모델 코드형 상품 열의 구별 (8) 상품 원문 근거에 붙은 색상 괄호와 모델 코드 경계 분리 (9) 불필요한 수량 경고 중복 제거.
- 성공한 테스트: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43374760179
- 최종 검증 소스 SHA: `79583388d99b3a7dab496b5d328f9e718107c5fc`
- **52 passed / 0 failed**, 기존 원본 발주서 20건 회귀 포함.
- 실제 비교 결과: 35개 입력 중 **32개는 전 필드 일치**, 다른 3개 입력에서 **22개 차이**.
- 변화: **219개 → 22개 (197개 감소)**. 마지막 비교 실행은 1,442개 leaf를 실제 재귀 비교했으며, 비교 leaf 수는 공통/누락 필드 변화에 따라 달라질 수 있다.
- 수정 전 원시 로그 JSON: `tests/rust-migration/recognition/ts-rust-product-differential-20261113.json`.
- 수정 후 전체 22건 JSON: `tests/rust-migration/recognition/ts-rust-product-differential-after-fixes-20261113.json`.

### 남아 있는 22개 차이: 원본 결함에 한해 명시적 허용

| 실제 입력 | 남은 세부 필드 차이 | 원인 및 정책 |
| --- | ---: | --- |
| corrected-01: BD 911R / 레드 | 10 | TS `domain.ts::normalizeColor`에 레드 → Red 별칭 누락. Rust는 등록 상품과 Red 옵션을 정상 선택. 세션 1에서 TS 공용 소스 수정 권한이 없으므로 원본 코드 개선 대상으로 인계. |
| original-19 | 6 | TS가 발주일자 `2026`을 상품으로 오인식, 표의 기재 수량 `1`은 미확정. Rust는 날짜 상품을 만들지 않고 근거 있는 수량 1을 확정. |
| original-20 | 6 | TS가 발주일 `2026-11-03`을 상품으로 오인식, 표의 수량 `1`은 미확정. Rust는 가짜 상품 생성을 방지하고 근거 있는 수량을 확정. |
| **총합** | **22** | 원본에서 확인된 세 부류 밖의 불일치는 허용하지 않는다. |

- `tests/rust-migration/recognition/src/differential.rs`에 **허용하는 입력 ID와 JSON 필드 경로를 각각 정확히 열거한 CI 게이트**를 추가했다.
- 검사 도구가 누락/요약(truncated) 결과를 돌려주거나, 허용하지 않은 입력/필드에서 차이가 생기거나, 22건보다 차이가 많아지면 테스트 실패.
- 나중에 TS 원본 버그가 수정되어 차이가 감소하는 경우는 허용. **3건/22개 예외가 있다는 이유만으로 전체 기능 동등성 완료라고 보고하지 않는다.**
- 마이크물림쇠/마우스트레이의 사용자 확인 중복 데이터는 그대로 유지하고, 명확한 구분 근거 없는 임의 SKU 확정 방지를 유지한다.

### 역할 분리 및 다음 단계

- 이번 수정 파일은 `src-tauri/src/business_core/recognition/mod.rs` 와 `tests/rust-migration/recognition/**`, 본 문서로만 한정.
- TypeScript의 색상 별칭 누락이나 발주일 오인식에 대한 원본 수정은 관련 공용 소스 책임자에게 인계할 문제. Rust를 원본 버그와 동일하게 퇴행시키지 않음.
- 세션 1에서 남은 미검증 영역: **수취인/주소/연락처/재분석 및 직원 확정값의 전 필드 동등성**. 이번 35건 비교는 상품 Item 필드에 한정.
- 세션 3 Windows Tauri 통합 빌드 및 운영 SQLite/공용 색상 정정 15개 적용은 이 세션 범위 아님.


## 2026-11-13: 수취인, 주소, 연락처, 근거 및 직원 확정값 전 필드 차등 검사

### 테스트 방법과 범위

- TypeScript 실제 생산 코드: `src/parser.ts::parseEvidence`, `reanalyzeWithAliases`; 직원 확정값 병합은 원본 `mergeParsedItem` 사용.
- Rust 실제 생산 코드: `src-tauri/src/business_core/recognition/mod.rs`의 `analyze_order`와 `reanalyze_order`. TS 분석 알고리즘을 시험용으로 베껴 만든 모의 엔진은 사용하지 않음.
- 차등 검증 전용 코드: `tests/rust-migration/recognition/compare-ts-rust-recipients.mjs`, `tests/rust-migration/recognition/src/differential.rs`.
- 동일한 상품 데이터 및 상태: 기존 등록 seed 360개와 이전에 검증한 15개 색상 정정안을 양쪽 런타임의 **메모리상 상태에만** 동일 적용. 실제 seed 및 운영 SQLite 불변.
- **수취인 분석 44개 입력**: 기존 주문 표본 20개, 색상 정정 품목 주문 15개, 다중 수취인/명시 이름/연락처/메모/동일행 주문/상세주소/이름 중복/공통 상품 9개.
- 비교 필드: 모든 수취인 속성(이름, 주소, 전화, 휴대폰, 메모, 주소 상태 및 부분값, 확인 상태, 후보, 원문 근거, 배송건 증거 앵커), 최상위 candidates 및 unassigned. 상품 Item 하위는 이미 이전 35건 차등 감사로 분리했기 때문에 수취인 분석 시 중복 집계하지 않음.
- **재분석 9개 시나리오**: 아무 수정 없이 재분석, 수취인 필드 수동 확정, 상품 수동 확정, 기존 운임/부가세 설정 승계, 수량 수정, 수취인명 변경, 신규 배송지 추가, 두 배송건, 수취인명 중복, 수동 분류. 재분석은 원본 TS에서 준비한 완전히 동일한 주문 객체를 양쪽 재분석 엔진에 입력해 **주문 전체 필드, Item, 원문 근거 및 ID 연결을 검사**함.
- 생성된 UUID/자동 생성 Rust ID만 값 비교에서 정규화하고, **직원 확정 배송건 ID와 기존 Item ID는 그대로 비교**. 근거 후보 목록은 고정된 소스 ID/원문 위치로 대응시켜 중간 항목 하나가 달라 뒤따르는 모든 항목을 허위 불일치로 분류하지 않음. 근거 후보 배열의 표시 순서 자체는 별도로 차이 건수에 반영하지 않았음.

### 최종 실측 및 보고서

- 검사 소스 커밋: `cc5a73a4bbe3996a2856ab548a4d7a4db877652b`.
- CI 전체 검증: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43381317874
- **Rust 독립 테스트 55/55 통과.** 20개 원본 발주서 상품/수량 회귀 및 기존 35개 상품 Item 차등 예외 게이트도 통과.
- 수취인 분석: **44건**, leaf 비교 **4,982회**, 차이가 없는 주문 **29건**, 차이가 있는 주문 **15건**, 세부 필드 차이 **78개**.
- 재분석: **9건**, leaf 비교 **1,738회**, 차이가 없는 주문 **8건**, 차이가 있는 주문 **1건**, 세부 차이 **5개**.
- 수정 전 첫 감사 수치는 수취인 1,284개, 재분석 201개 차이였으나 배열 순서로 인한 연쇄 오비교가 포함된 **조정 전 집계**다. 수정 전후 숫자를 모두 개별 실제 업무 결함 수로 해석하면 안 된다.
- 기계 판독 가능한 **수취인 78개 차이** 전체: `tests/rust-migration/recognition/ts-rust-recipient-differential-20261113.json`.
- 기계 판독 가능한 **재분석 5개 차이** 전체: `tests/rust-migration/recognition/ts-rust-reanalysis-differential-20261113.json`.
- 두 JSON에는 입력 ID별 결과, 필드별 빈도, TS 원본 값과 Rust 실제 값을 기록함. 이름/주소/연락처처럼 실제 업무 값의 차이와 reason/근거 span 같은 출력 설명 차이는 구분해서 판단해야 함.

### 이번 세션의 Rust 수정 및 직원 확정 검증

- `recognition/mod.rs`에서 배송 주소의 시군구/읍면동, 우편번호 접두표기, 지번 건물 번호 선택을 원본 TypeScript 주소 처리 정책과 비교해 수정함.
- 복합 수취인명(띄어 쓴 두 단어 및 님), 직함 포함 이름의 표시값과 원문 앵커 범위를 정렬함.
- 후보 근거의 표시 이유 `reason`과 정렬을 원본 TS 기준에 맞추고, 미등록된 `confirmedFields: []`의 임의 생성 및 TS에 없는 `dispatchOrigin` 승계를 제거함.
- 재분석 시 새로운 Item이 생성되어도 **기존 안정 배송건 ID에 모든 새 Item source.recipientId를 다시 결속**하도록 개선함. 새 Item의 targetId도 현재 Item ID에 연결하며 별도 회귀 테스트 추가.
- CI에서 별도 강제 판정: 동일 원문이면 수동 상품 확정/수량 승인 보존, 상품 수량 근거가 달라지면 과거 수동 선택과 승인 무효화, 수취인명이 바뀌면 이전 직원 설정을 새 배송건에 승계하지 않기, 신규 배송건 ID 분리, 동일 이름의 복수 배송건 ID 혼동 금지, 수동 분류에서 자동 재분석 차단.
- Rust 수취인/Item source의 안정 참조 무결성은 실제 테스트에서 오류 0건.

### 남은 차이의 사실관계 — 자동 승인 금지

- 재분석 잔여 **5개**는 `reanalyze-edit-quantity`의 단일 근본 원인이다. 원본 TS가 변경된 Item 근거의 recipientId 2곳을 오래된 임시 배송건 ID에 남김. Rust는 안정 배송건 ID로 정상 재결속함. 나머지 3개는 참조 무결성 검사에서 파생된 길이/항목 차이다. **TypeScript 공용 소스 결함**으로 인계, Rust를 잘못된 상태로 퇴행시키지 않음.
- 수취인 78개는 **아직 전체 승인 예외가 아님**. 원본 TS 결함이 명확한 사례와 별도 조사가 필요한 사례가 섞여 있다.
  - 원본 발주서 19번: TypeScript가 상품 `연주용의자`를 수취인명으로 오인식한 반면 Rust는 표의 실제 이름 `여가상`을 추출.
  - 원본 발주서 20번: TS가 `발주일`을 이름으로 오인식해 추가 배송건을 생성하고 실제 연락처·주소가 아닌 빈 배송건을 먼저 노출. Rust는 실제 `이가상` 및 연락처·주소를 배송건 1개로 구성.
  - 같은 행 주문 예시 `BD 709 민판 한개 이가상 ...`: TS 수취인명 공란, Rust `이가상` 추출.
  - 들여쓰기 상세주소 예시: TS는 다음 행의 `101동 1102호`를 배송주소에 결합하지 않았지만 Rust는 결합함. 배송지 상세정보 소실을 Rust에서 복제하지 않음.
  - 원본 1번: 연락처를 phone/mobile 중 어느 항목으로 보아야 하는지 실제 연락처 표기 정책 확인 필요.
  - original-03 및 공통상품 합성 사례: `unassignedEvidence`의 잔여 수량 근거 출력 차이가 있으므로 별도 검증 필요.
  - original-08/18: 최상위 상품 후보의 원문 `value` 범위가 서로 다름. 기존 상품 Item 출력 일치는 유지되나 근거 후보 UI 소비 전에 정렬 필요.
  - original-17: `BD 709 (블랙)`의 최상위 상품 근거 길이 차이가 남음. Item 안의 source span은 이전 작업에서 정렬됨.
- 기존 35건 상품 Item 감사의 TS 원본 문제 **3건 / 22개 차이**도 여전히 별도로 존재하며 이번 수취인 수치에 포함되지 않는다.
- **최종 판정: 검사 범위 내 직원 결정 보존 및 Rust 참조 무결성은 검증됐지만 수취인 전체 필드/재분석 결과의 완전 동등성은 미완료**. 남은 수취인 차이를 모두 원본 버그로 확정하거나 전부 허용 처리하지 말 것.

### 소유권 및 통합 인계

- 이번 차수의 수정은 `src-tauri/src/business_core/recognition/mod.rs`, `tests/rust-migration/recognition/**`, 본 문서로만 제한했다.
- 공용 TypeScript 원본, 공용 상품 seed, 운영 SQLite, 세션 2 가격/운임, 세션 3 Tauri/React/Windows 실행 코드는 변경하지 않았다.
- 기존에 사용자 승인으로 제외한 마이크물림쇠/마우스트레이의 중복 상품명은 수정하지 않았다. 잘못된 SKU 임의 선택 방지 규칙은 유지한다.
- 실제 Windows 앱에서 수취인/배송건을 확정하고 표/엑셀을 생성하는 통합 검증은 세션 3 범위이며 별도 수행해야 한다.


## 2026-11-13: 수취인 78→65 불일치 정리 및 세션 1 안전 회귀 게이트

### 이번 요청에서 수정한 Rust 원인

- **연락처 2개 귀속:** 동일 행 또는 문서에 휴대전화 두 개가 들어올 때 원본 TS `source(row,c,other)`처럼 첫 번호는 `mobile`, 두 번째 번호를 대체 `phone` 필드에 넣은 경우 근거 `sources[].field` 및 `candidates[].field`도 실제 저장 필드를 따라가게 수정. 원본 1번의 2개 차이 해소.
- **미귀속 수량 후보 소실:** `serde_json::Value`에 존재하지 않는 `unassignedEvidence`를 인덱싱하면 `null`이 먼저 생성되어 배열 초기화 조건이 동작하지 않는 버그 수정. 원본 3번과 공통상품 사례에서 독립 수량 근거 보존.
- **근거 이유 문구:** 두 단어 이름, 직함 포함 이름, `TEL`로 시작하는 연락처, 단위 없는 수량 후보의 `reason`을 실제 `order-evidence.ts` 규칙과 대조해 수정.
- **상품 후보 값 범위:** `src/parser.ts::logicalLines`의 조건에 맞춰 주소가 한 행에 있는 경우에는 상품 부분만 추출하고, 주소가 없는 행에서는 동일 행 수취인/연락처를 포함한 원문 후보값을 보존. 물리적 원문 근거 위치 및 상품 Item 내부 raw는 독립적으로 관리.
- **모델 근거 전파:** `BD 709 (블랙)`처럼 색상이 괄호에 있을 때 Item 내부 근거뿐 아니라 최상위 `candidates`도 `BD 709` 원본 구간과 일치시키도록 수정. 후보 ID와 종료 위치까지 TS 원본과 일치 확인.
- 모두 `src-tauri/src/business_core/recognition/mod.rs`의 소유 범위에만 수정함. 상품 가격·운임 및 TypeScript 원본 소스는 변경하지 않았음.

### 최종 실측 결과 및 버전

- 최종 실코드 커밋: `ce8440116a9bae92263757d9d176f8963c7a4061`.
- 실제 TS `parseEvidence()`와 Rust `analyze_order`를 **같은 인메모리 상태와 44개 발주서**로 실행: **근거 leaf 5,009회 비교, 정확히 일치하는 입력 39개, 차이가 있는 입력 5개, 필드 불일치 65개**.
- 시작 기준: 같은 비교기의 보고서 78개 → 첫 수정 후 68개 → 모델 근거 위치 통합 후 66개 → TS 논리행 규칙 반영 후 **65개**. 합계 13개 차이 제거.
- 기존 상품 Item 35개 입력은 여전히 TS 결함 3건/22개를 제외한 32건 일치. 직원 확정 재분석 9건은 TS의 낡은 ID 참조 1건/5개를 제외한 8건 일치.
- 실행 및 출처 로그: https://github.com/ThunderStrikerKR/TSBH/actions/runs/43384721427 — 원본 TypeScript와 Rust 독립 코드 실행 포함, Rust 회귀 테스트 **57 passed / 0 failed**.
- 이전 78개 전체 실측: `tests/rust-migration/recognition/ts-rust-recipient-differential-20261113.json`.
- 최신 65개 원본 TS 값 / Rust 값 및 입력 ID를 모두 보존한 파일: `tests/rust-migration/recognition/ts-rust-recipient-reviewed-exceptions-20261113.json`.
- `tests/rust-migration/recognition/src/differential.rs`에 이번 65개를 단순 숫자 허용하지 않고 **`caseId`, `path`, TS/Rust 값 전체로 비교하는 엄격한 자동 회귀 게이트**를 설치. 추가되거나 값이 달라진 차이는 CI 실패, 원본 TS가 수정되어 차이가 줄어드는 것은 허용. 같은 방식으로 재분석 TS 낡은 `recipientId` 5개 차이도 리뷰된 실측 파일과 비교.

### 남은 65개 차이의 원인별 분류

| 입력 | 세부 필드 차이 | 실제 판단 |
| --- | ---: | --- |
| `original-19` | 12 | TS가 발주일자 `2026`을 상품으로 보고, `연주용의자`를 수취인명으로 취급. Rust는 표 비고란의 실제 `여가상`을 수취인으로 인식하고 1개 상품을 보존 |
| `original-20` | 30 | TS가 발주일 및 납품장소를 수취인으로 취급해 배송건 2개 생성. Rust는 실제 `이가상`의 배송건 1개, 경산시 주소, 일반전화/휴대전화를 보존 |
| `recipient-name-contact` | 4 | TS가 `709 민판`의 `민판`을 사람 이름으로 보아 불필요한 배송건을 추가. Rust는 실제 `김가상` 배송건 1개로 유지 |
| `recipient-inline` | 10 | 상품과 같은 행의 명시적 `이가상` 이름을 TS에서 잃는 데 반해 Rust는 이름과 모바일번호를 추출 |
| `recipient-address-detail` | 9 | 들여쓰기된 `101동 1102호`를 TS는 상세주소에 결합하지 않고 `101`을 상품 코드로 오인식. Rust는 상세주소를 보존하고 가짜 상품을 생성하지 않음 |
| **합계** | **65** | **5개 실제 원인**에서 발생한 파생 JSON 필드 차이. 별개의 비즈니스 오류 65건이 아님 |

- 이 표의 5개 사례는 TS 현재 결과를 무조건 동등하다고 승인한 것이 아니다. **사용자 주문 데이터 보호를 위해 Rust가 원본의 잘못된 수취인 해석을 재현하지 않도록 유지하는 의도적인 불일치**다. 실제 원본 TS 개선은 공통 소스 담당 세션과 협의한다.
- 각 문제의 동작을 검증하는 새 독립 회귀 2개 추가: 실제 수취인 보호(날짜/상품 옵션/혼합 이름/상세주소) 및 이중 연락처/미귀속 수량 보존. 기준값과 달라지면 CI 실패.
- 입력 데이터 44건의 근거 후보 배열은 명확한 소스 ID/원문 위치로 먼저 대응하여 순서 차이만으로 연쇄 오비교하지 않음. 따라서 일치 39건은 **표시 배열 순서까지 포함한 바이트 단위 JSON 동일**이라는 뜻이 아니다.
- 44건이라는 제한된 테스트 집합에서 안전하게 수정할 수 있는 Rust 출력 계약 차이를 모두 처리했으나 **모든 실제 주문 원문의 전수 동등성 증명은 아직 아님**. 세션 3 Windows Tauri/React/UI/Excel 통합 실행과 공용 TS의 원본 결함 수정 필요.

### 범위 및 보고 원칙

- 세션 1 소유 파일: `src-tauri/src/business_core/recognition/mod.rs`, `tests/rust-migration/recognition/**`, `docs/rust-migration/01-recognition.md`. 타 세션 파일 변경 없음.
- 사용자 합의로 제외한 마이크물림쇠/마우스트레이 중복 데이터는 그대로 두며 근거 없는 SKU 자동 선택 금지 유지.
- Rust 테스트 57개 통과는 검증 로직과 회귀가 성공했다는 뜻이지 TypeScript와 Rust의 모든 반환값이 완전히 같다는 뜻은 아니다.
