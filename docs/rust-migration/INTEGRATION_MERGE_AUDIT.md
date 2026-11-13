# TSBH 세션 1/2 → 세션 3 최신 Rust 통합 기록

기준일: 2026-11-13. 대상: `migration/03-integration`.

## 통합한 검증 출처

| 책임 | 소스 브랜치 | 소스 HEAD | 출처 검증 |
|---|---|---|---|
| 발주 인식 / 상품 선택 | `migration/01-recognition` | `f34e268b353d36c3fe3eaa80ce144e4e6ab03717` | [독립 CI 성공](https://github.com/ThunderStrikerKR/TSBH/actions/runs/43387396980), Rust 57건 |
| 가격 / 운임 / 주문 상태 규칙 | `migration/02-rules` | `467a05548eb007fabea30eaca45265abb0921b83` | [독립 CI 성공](https://github.com/ThunderStrikerKR/TSBH/actions/runs/43389929200), 실제 TS 678건 및 Rust 47건 |
| 출력 / 메시지 / 결산 | `migration/03-integration` 기존 HEAD | `1649e63753a3065e0e902ebecf6644dba7fc23fe` | 기존 output 회귀 및 185개 차등 비교 |

통합 코드 반영 커밋: `49617cb5ad0ced5fd54da600d2f6c1be8582ca35`.

- recognition 전용 Rust 4개 파일 및 해당 세션의 독립 Rust 테스트, 원본 TS 비교 검사와 데이터 스냅샷 반영.
- rules 전용 Rust 16개 파일 및 해당 세션의 독립 Rust 테스트, TS 비교 검사와 실행 파일 반영.
- 두 세션의 최종 인계 문서 동기화.
- 기존 세션 3의 `src-tauri/src/business_core/output/` 및 React/SQLite/기존 TS 원본은 보존.
- 오래된 `migration/01-recognition-parity` 시험 브랜치는 별도로 보존하며 **최신 recognition 소스를 덮어쓰지 않음**.
- 각 세션의 독점 브랜치는 수정하지 않음.

## IPC 통합

- `src-tauri/src/business_core/mod.rs::execute`가 `recognition`, `rules`, `output`을 각각 실제 독립 Rust `execute`에 전달한다.
- `src-tauri/src/lib.rs::business_core_call`은 위 라우터를 사용한다.
- 프론트 `src/tauri-bridge.ts::businessCoreCall`의 타입은 원래 세 도메인으로 선언되어 있었으며 변경 없이 이용한다.
- 새 Rust 통합 라우팅 테스트 4개가 도메인별 호출과 알 수 없는 도메인 오류를 확인한다.
- 직접 실행 가능한 순수 Rust 상태 변경 함수는 **반환된 JSON 상태를 산출할 뿐 SQLite에 쓰지 않는다**. 최신 DB 리비전 비교 / 원자적 상태 저장 / 직원의 기존 확정 데이터 보호는 Tauri 저장 계층의 별도 책임이다.

## 통합 CI

- `.github/workflows/rust-migration-ci.yml`: recognition, rules, output **세 독립 Cargo 테스트** 및 Windows Tauri 라이브러리 테스트.
- `.github/workflows/migration-output.yml`: 기존 185개 TS/Rust 출력 및 규칙 차등 테스트, 프론트엔드 빌드/회귀, Windows 네이티브, **새로운 678개 TS/Rust 규칙 전수 차등 비교**.
- 통합 완료 판정은 이 브랜치 **최신 HEAD**에서 실행된 CI 결과가 있어야 한다. 세션 1/2 단독 PASS를 통합 PASS라고 취급하지 않는다.
- 기존 프론트엔드 `tests/audit-20-order-samples.test.mjs` 19/20번은 TypeScript 원본이 발주일을 상품/수취인으로 오인하는 확인된 기존 실패다. Rust가 정상인 것을 이 2개 실패로 부정하지 않되, 프론트 전체 테스트는 아직 실패라는 사실을 유지한다.

## 후속 책임

1. 최신 코드의 Linux Rust 3종 테스트, Windows 실제 Tauri cargo, TypeScript 실엔진 비교 로그를 확인한다.
2. UI/상태 변경을 Rust로 이전할 때 최신 상태 비교, 요청순서 무효화, 승인 필드/금액/운임/배송건의 데이터 무결성 정책을 지킨다.
3. 직원 저장 승인 이전에 Rust 반환 state를 신뢰하거나, 부분적으로 SQLite에 저장하거나, 기존 원문 분석 후 소급적으로 가격을 바꾸지 않는다.
4. 출력 ExcelJS는 원래 워크북 직렬화 및 UI에 필요하므로 무작정 제거하지 않는다.
5. React 수취인 분석과 주문 상태 변경, 메시지/결산의 이전 및 Windows GUI/E2E 확인 전에는 **Rust 전면 이전 완료가 아니다**.
