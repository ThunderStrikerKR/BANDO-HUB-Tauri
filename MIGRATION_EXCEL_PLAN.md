# BANDO HUB — Tauri 이식 및 Excel 전체 갱신 작업 목록

## 확정된 Excel 운영 원칙

- 상품과 거래처는 **현재 DB 전체 목록 다운로드 → Excel에서 수정 및 신규 추가 → 전체 비교 → 승인 → DB 백업 후 변경분 적용**을 기본으로 한다.
- Excel에서 기존 행을 삭제해도 DB에서는 삭제하거나 거래 중지하지 않는다. 누락 건수를 보여 준다.
- 기존 ID가 일치하면 수정, ID가 없으면 중복 검사를 거친 신규 추가, 알 수 없는 ID는 차단.
- 상품 이름, 거래처 상호, Cafe24 P코드가 내부 고유 ID를 대체하지 않는다.
- 기존 가격, 주문, 별칭, 배송, 결제, 특수 단가는 해당 Excel에서 명시적으로 편집하도록 설계한 필드 외에는 보존.
- 같은 ID 두 번, 미확인 참조, 중복 의심, 검증 오류는 저장 차단. 누락은 경고만.
- 값 공란은 기존 값 유지. 선택값 삭제는 명시적인 `[비우기]` 입력.
- 데이터 내보내기 시 내부 ID와 기준 DB revision을 포함하고, 업로드의 revision이 현재 DB와 다르면 최신 파일 재다운로드 요청.
- Excel 수식과 병합 셀 차단. 변경 전 화면에서 신규/수정/변경 없음/보류/오류 건수를 확인.
- 기존 정식 DB를 초기화하거나 임의의 홈페이지 자료로 덮어쓰지 않는다.

## 이번 차수: 거래처 Excel 전체 갱신 (구현, Windows 검증 전)

- `src/client-workbook.ts`: 등록된 거래처 전부(보관 거래처 포함), 참고용 입금 계좌와 특수 단가 포함 XLSX 내보내기.
- `src/ClientWorkbookTools.tsx`: Excel 업로드 선택, 미리보기, 누락 및 중복 경고, 승인과 백업.
- `src-tauri/src/lib.rs`: Windows 네이티브 파일 저장 창과 내장 `save_client_workbook` 명령 연결.
- 거래처의 ID, 주문 연결, 특수 가격 예외, 히스토리는 그대로 보존.
- 승인 직전 현행 DB revision 재검사 및 기존 `state_save`를 통한 원자적 저장.
- `tests/tauri-client-full-workbook.test.mjs`: 코드 기반 데이터 변환 검증 시나리오.
- TypeScript/Node 자동실험은 GitHub Actions에서 검증했다. 실제 Windows XLSX 저장 창과 업무 DB 통합시험은 별도 검증 전이다.

## 이번 차수: 상품 Excel 전체 갱신 (구현, Windows 검증 전)

- `src/product-sync-workbook.ts`: 현재 상품 전부 및 옵션 전부를 2개 시트로 내보내고, 카테고리/브랜드 참고, 작성 안내, DB 버전 메타데이터를 포함한다.
- `src/ProductSyncWorkbookTools.tsx`: 전체 파일 다운로드, 업로드, 신규/수정/변경 없음/중복 의심/오류별 검토, 명시적 확인, 백업 후 변경분 저장.
- Rust `save_product_sync_workbook`으로 Windows 네이티브 다른 이름으로 저장 창 호출.
- 상품 ID와 옵션 ID가 일치하면 기존 항목의 허용된 필드만 수정. 신규등록키로 새 상품과 그 판매 옵션을 함께 등록. 홈페이지 연결은 선택이다.
- 기존 모델코드, 내부 ID, 카페24 `siteCode`, 홈페이지 상품번호, 공식 옵션 ID, 상품 이미지, 주문, 별칭, 이력, 공장 출고 규칙을 덮어쓰지 않는다.
- 임의의 Excel 행 삭제는 데이터 삭제로 해석하지 않는다. 누락한 기존 상품/옵션은 경고만 표시하고 DB에 유지한다.
- 새 상품의 모델코드와 기존 모델코드 중복은 보류/차단. 다른 상품에 속한 옵션 ID, 미확인 신규등록키는 오류.
- 기존 소매가를 Excel로 수정하면 `MANUAL_EXCEL` 가격 이력을 남기고 수동 수정으로 표시한다. 기존 공식 수집 이력은 유지.
- 기존 등록 양식과 별도 가격표는 보조 메뉴로 유지하고, **현재 데이터 전체 다운로드**를 기본 진입점으로 제공한다.
- `tests/tauri-product-full-workbook.test.mjs`: 실제 ExcelJS XLSX 생성 및 재업로드, 303개 상품/360개 옵션 무변경 유지, 가격 변경, 신규 복합 옵션, 중복/오류 차단, 보관 상태, 기술 코드 보존 등 검사.
- GitHub Actions 전체 TypeScript/Node 자동실험 통과 여부는 PR 체크를 기준으로 판단한다. Windows 실제 실행/DB 통합시험은 별도 검증 전이다.

## 이번 차수: 공장 발송 로젠 Excel 출력 (구현, Windows 검증 전)

- `src/factory-export.ts`: 작업 단계 4까지 확정되어 이관된 `workflow.queue`의 공장 출고 스냅샷만 읽는다.
- 로젠 기존 15열을 정확히 유지한다. 수하인/송하인 이름, 주소, 연락처, 품목명, 메시지, 운임구분 010/020을 사용한다.
- 공장에서 채울 택배수량과 택배운임, 미확인 수하인 우편번호는 빈칸으로 둔다.
- 송하인은 주문의 확정 대리발송 스냅샷을 사용하고 반도스탠드 명칭으로 임의 변경하지 않는다.
- 현행 Tauri 저장 창에 `save_factory_workbook` 명령 추가. 저장 취소 시 상태를 변경하지 않는다.
- 저장 성공 후 기준 DB revision과 스냅샷 내용을 재검사하고, `EXPORTED` 및 append-only 출력 이력을 반영한다. 이미 출력한 건의 중복 선택은 거절.
- `fileOnly=true`로 실제 공장 전달과 파일 생성 상태를 구분한다. 공장 전달 완료 및 전달 전 재출력에는 직원 확인을 요구한다.
- 기존 업무 폴더 경로 대신 Windows 저장 창을 사용한다. 출력 이력에서 새 파일의 저장 경로를 복사할 수 있다.
- 기존 주문이 `workflow.queue`로 이관되지 않은 경우 불완전한 Excel을 만드는 대신 출력 선택을 차단한다.
- `tests/tauri-factory-ologen-export.test.mjs`에서 실제 XLSX 15열, 선불/착불, 입력 공란, 중복 방지, 저장 후 출력 이력 등 6가지 시험.
- **실제 회사 Tauri Windows EXE, 로젠 앱 업로드, SQLite 저장 후 앱 재실행 검증은 별도 필요.**

## 이번 차수: 공장 회신 운송장 및 실제 운임 이식 (구현, Windows 검증 전)

- `src/factory-reply-workbook.ts`: 실제 로젠 회신 XLSX의 Q열 운송장번호와 G열 실제 운임을 파싱하고 수하인 이름, 주소, 전화, 휴대폰을 확정 공장 출고 스냅샷과 비교.
- Excel 열 머리글을 검증한다. 15열 출력 양식에는 운송장번호가 없어 자동 회신 처리하지 않으며, 실제 반환 파일의 Q열까지 요구한다.
- 운송장번호 숫자 셀은 선행 0 손실 위험으로 차단. 수식 및 병합 셀도 차단.
- `src/FactoryReplyImport.tsx`: 업로드, 행별 자동 연결/직원 확인 미리보기, 명시적 승인, DB 백업 후 저장.
- 공장 회신 데이터는 **정상 일치한 행만 자동 반영**. 주소/연락처 불일치, 중복 운송장, 충돌, 누락 금액은 보류. 같은 운송장과 실제 운임 재회신은 반복 기록 생성 없이 처리.
- `src/factory-replies.ts`: 기존 배송 건과의 연결 규칙 유지, 다른 배송 건에 사용된 운송장번호 재사용 차단.
- 원본 회신 파일은 Rust `archive_factory_reply`에서 SHA-256 해시 검증 후 Windows 앱 데이터 폴더에 별도 저장. `open_factory_reply_file`에서 DB에 연결된 파일만 다시 열 수 있음.
- `src/FactoryReplyHistory.tsx` / `src/FactoryNotifications.tsx`: 보관 파일 열기, 충돌 행 하나씩 직원 재확인, 정정 전후 값과 원본 회신 이력 보존.
- `tests/tauri-factory-reply-import.test.mjs`: 실제 XLSX 파일 생성/읽기/연결/충돌/중복/재회신/DB revision 검증.
- Windows Tauri Rust 실제 빌드, 회사의 로젠 회신 원본 양식, 파일 열기, SQLite 재시작 통합시험은 별도 검증 전.

## 이번 차수: 주문내역 및 일일 결산 (구현, Windows 검증 전)

- `src/app/order-history.ts`: 주문내역을 확정 배송 스냅샷 기준으로 상품대금/고객 청구 배송비/부가세/청구 합계로 분해. 이관된 주문의 배송 건별 금액을 중복하지 않는다.
- `src/app/OrderHistory.tsx`: 소매 주문이 결제된 것처럼 보이는 기존 상태 문구를 수정하고 청구 금액 및 상세 구성 표시, 현재 검색/날짜 조건 그대로 XLSX 다운로드.
- `src/app/settlement-report.ts`: 한국시간 접수일 기준의 주문 청구액과 실제 `paidAt` 기준의 계좌 입금액을 별도 집계.
- 입금 승인과 과거 `order.paid` 플래그는 은행 입금 증빙과 분리. 후불 청구액은 후불 수입으로 추측하지 않으며, 미배분 입금액은 별도 표시.
- 현재 미수/공장 실제 운임은 **조회 시점 현재 저장된 값**이며 해당 결산일의 현금 거래를 의미하지 않는다.
- 금액 미확정 항목은 0원으로 바꾸지 않고 미확정 개수를 표시. 이전 주문일에 접수된 건의 당일 입금도 입금일 기준 내역에 포함.
- `src/app/DailySettlement.tsx`: 기존 미구현 안내 화면을 실제 데이터에 연결. 청구액, 상품대금, 고객 청구 배송비, 부가세, 실제 계좌 입금, 미배분액, 현재 미수/공장 운임과 경고 확인.
- `src/app/report-workbook.ts`: 읽기 전용 주문내역 및 일일 결산 XLSX 출력. 결산 파일은 `일일 결산`, `접수 주문`, `실제 입금` 3개 시트.
- Rust `save_settlement_workbook`, `save_order_history_workbook`를 별도의 Windows 네이티브 저장 창으로 제공. 보고서 다운로드는 원본 DB를 변경하지 않는다.
- `src/app/useAppModel.ts` 및 `DateNavigator.tsx`에서 한국시간 날짜를 운영체제 locale에 의존하지 않는 YYYY-MM-DD로 통일.
- `tests/tauri-settlement-order-history.test.mjs`의 데이터 검증과 실제 XLSX 왕복, `tests/tauri-settlement-production-flow.test.mjs`의 실제 업무 함수 통합시험.
- 금전 기준: 현재 데이터에 취소/환불의 별도 원장 모델이 없으므로 **완전한 회계 결산이나 과거 일자별 확정 장부**로 오인하지 않도록 주의 문구 제공.
- 실제 Windows Rust 빌드, 회사의 과거 주문/입금 데이터 및 SQLite 재실행 회귀 시험은 별도 검증 전.

## 다음 남은 주요 이식 묶음

1. **접수 원문 감사 및 정정**: Tauri 미연결 명령 복구, 원본 및 이력 불변성 확인.
2. **Windows 카카오톡 도킹 등 PC 연동**: 플랫폼 기능 및 배포/복구 테스트.
3. **스마트폰 연결 및 사진 업로드**: 외부 접속 보안, 로컬 서버/백업/장애 전환 통합 시험.

남은 기능 수는 제품 범위의 세분화 정도에 따라 달라지며, **핵심 PC 업무 완료 여부는 공장 회신과 결산 검증 이후 판단**한다.
모든 신규 코드는 Draft PR에 보관하며, 검증 전 `main`에 병합하지 않는다.
