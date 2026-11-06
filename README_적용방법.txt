BANDO HUB Tauri v0.0.3 - Rust E0106 수정 안내

기존 프로젝트 폴더 이름이 v0.0.1이어도 괜찮습니다.

1) 이 ZIP 파일을 아무 폴더에 압축 해제합니다.
2) APPLY_E0106.cmd를 더블클릭합니다.
3) 폴더 선택 창에서 현재 사용 중인 반도허브 소스 폴더를 선택합니다.
   - src, src-tauri, BUILD_WINDOWS_TAURI.cmd가 보이는 폴더입니다.
   - release 폴더나 src-tauri 폴더 자체는 선택하지 마세요.
4) SUCCESS 메시지가 나오면 창을 닫고 원래 소스 폴더의 BUILD_WINDOWS_TAURI.cmd를 실행합니다.

변경 내용: src-tauri/src/lib.rs의 lock_db 함수 lifetime 선언 한 줄만 수정합니다.
기존 주문/상품/가격 DB 파일은 건드리지 않습니다.
원본 lib.rs는 LocalAppData\BANDO-HUB\patch-backups에 자동 백업됩니다.

이 패치는 오류 E0106 해결용이며 Windows Rust 전체 빌드 성공은 아직 검증되지 않았습니다.
