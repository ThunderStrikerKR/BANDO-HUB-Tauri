# TSBH Rust 이전 세션 1 — recognition 인계 기록

**판정: 부분 구현, Rust 컴파일/20건 회귀 검증 미완료. 시연 빌드 통합 금지.**

## 저장소와 커밋
- 저장소: ThunderStrikerKR/TSBH (Public 변경 없음)
- 독점 브랜치: migration/01-recognition
- 공통 기준: d5ea8ed20b8120b844437263c2eb2b8963559e8d
- 선행 모델 선택 구현: 3f8e062e1e049b5297b0fd78a285dad7a679d6f5
- 마지막 소스 수정 커밋: e11b27faaa31b695715674737ac17fcfcbb8c84f
- 마지막 **Rust 컴파일 검증 완료 커밋: 없음.**
- 작업 경로는 사용자 지정 허용 경로로 제한. 기존 TS 및 공통 Rust/설정 파일은 미수정.

## 담당 소스 및 구현 상태

1. src-tauri/src/business_core/recognition/model.rs
   - 등록 판매상품 기준 이름/모델/색상/별칭 후보, 보면대 계열 타공/비타공, 별칭 충돌 판단.
   - 선행 커밋에서 작성됨. 아직 다른 모듈과 컴파일 검증되지 않음.
2. src-tauri/src/business_core/recognition/quantity.rs
   - 한국어 및 숫자 수량, 개/대/세트/EA/PCS, × 및 별도 표 수량 열, 모델 뒤 단독 수량.
   - 하이픈 모델의 -1과 옵션 괄호 뒤 명시된 -1개 구분.
3. src-tauri/src/business_core/recognition/mod.rs
   - execute 진입점, 배송건/수취인/연락처/주소 추출, 상품 근거, 배송건 연결, 보수적 재분석.
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
- analyze_order 근거는 UTF-16 전체 원문 오프셋, match_products의 evidence는 모델 내부 상대 UTF-8 바이트 오프셋. 통합 전에 통일 필요.
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
- cargo/rustc 도구가 현재 실행 환경에 없어 Rust 컴파일과 cargo test 실행 불가.
- 20건 중 실제 통과 건수 **미측정**. 테스트 통과 주장 금지.
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
- [ ] Rust 컴파일 성공
- [ ] 20건 Rust 회귀 실측 및 회귀 없음 입증
- [ ] TS 결과/신규 오류 비교
- [ ] JSON 스키마/기존 React 연결 실측
- [ ] Windows/Tauri 최종 통합(세션 3)

**결론: 작업 중이며 완료 판정 불가.**
