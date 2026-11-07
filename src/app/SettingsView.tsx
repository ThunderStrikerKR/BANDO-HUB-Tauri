import { TestDatabasePanel } from "../TestDatabasePanel";
import { BackupPanel } from "../ManagementUI";
import { ReceiptArchive } from "../ReceiptArchive";
import { SettingsPanel } from "../SettingsPanel";
import type { NoticeSink } from "../shared/notices";
import type { InboxEntry, State } from "../types";
import { PageHeading } from "../ui/PageHeading";
import { MobilePanel } from "./MobilePanel";

declare const __BANDO_VERSION__: string;
declare const __BANDO_BUILD_ID__: string;
export function SettingsView({
  state,
  onSaveSettings,
  onNotice,
  onRestored,
  onReceive,
}: {
  state: State;
  onSaveSettings: (changes: Record<string, unknown>, expected: Record<string, unknown>) => Promise<void>;
  onNotice: NoticeSink;
  onRestored: () => Promise<void>;
  onReceive: (entry: InboxEntry) => Promise<void>;
}) {
  return (
    <>
      <PageHeading title="설정" />
      <div className="settings-layout">
        <SettingsPanel state={state} onSaveSettings={onSaveSettings} onNotice={onNotice} />
        <div className="settings-support">
          <section className="card" aria-label="프로그램 정보">
            <h2>프로그램 정보</h2>
            <p>현재 버전: v{__BANDO_VERSION__}</p>
            <p>빌드 ID: {__BANDO_BUILD_ID__}</p>
          </section>
          <TestDatabasePanel onReset={onRestored} />
          <ReceiptArchive />
          <BackupPanel onError={onNotice} onRefresh={onRestored} />
          <section className="card">
            <h2>업무 데이터 저장</h2>
            <p>
              프로그램과 분리된 PC 데이터베이스에 저장합니다. 업데이트 후에도
              상품 / 거래처 / 주문 / 가격 / 운임을 유지합니다.
            </p>
            <p className="muted">
              Windows AppData → com.bandostand.bandohub.tauri → bando-hub-v001.sqlite
            </p>
          </section>
          <MobilePanel onNotice={onNotice} onReceive={onReceive} />
        </div>
      </div>
    </>
  );
}
