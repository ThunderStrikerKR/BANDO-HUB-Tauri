import { useRef, useState } from "react";
import { TestDatabasePanel } from "../TestDatabasePanel";
import { BackupPanel } from "../ManagementUI";
import { ReceiptArchive } from "../ReceiptArchive";
import { SettingsPanel, type SettingsPanelHandle } from "../SettingsPanel";
import type { NoticeSink } from "../shared/notices";
import type { State } from "../types";
import { Modal } from "../ui";
import { PageHeading } from "../ui/PageHeading";
import { DeveloperLab } from "../developer/DeveloperLab";

declare const __BANDO_VERSION__: string;
declare const __BANDO_BUILD_ID__: string;

type SettingsTab = "basic" | "files" | "data" | "system" | "developer";
const settingsTabs: { id: SettingsTab; title: string }[] = [
  { id: "basic", title: "기본 설정" },
  { id: "files", title: "파일 관리" },
  { id: "data", title: "데이터 관리" },
  { id: "system", title: "시스템" },
  { id: "developer", title: "개발자 모드" },
];

export function SettingsView({
  state,
  onSaveSettings,
  onNotice,
  onRestored,
}: {
  state: State;
  onSaveSettings: (changes: Record<string, unknown>, expected: Record<string, unknown>) => Promise<void>;
  onNotice: NoticeSink;
  onRestored: () => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("basic");
  const [requestedTab, setRequestedTab] = useState<SettingsTab | null>(null);
  const [savingBeforeLeave, setSavingBeforeLeave] = useState(false);
  const editor = useRef<SettingsPanelHandle>(null);

  const chooseTab = (next: SettingsTab) => {
    if (next === activeTab || requestedTab || savingBeforeLeave) return;
    if (editor.current?.isBusy()) {
      onNotice("설정 저장 작업이 끝난 뒤 탭을 이동하세요.", "error");
      return;
    }
    if (editor.current?.hasUnsavedChanges()) {
      setRequestedTab(next);
      return;
    }
    setActiveTab(next);
  };

  const saveAndLeave = async () => {
    if (!requestedTab || savingBeforeLeave) return;
    setSavingBeforeLeave(true);
    try {
      if (await editor.current?.save()) {
        setActiveTab(requestedTab);
        setRequestedTab(null);
      }
    } finally {
      setSavingBeforeLeave(false);
    }
  };

  return (
    <>
      <PageHeading title="설정" />
      <div className="settings-tab-list" role="tablist" aria-label="설정 분류"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const i = settingsTabs.findIndex((tab) => tab.id === activeTab);
          const nextIndex = event.key === "Home" ? 0 :
            event.key === "End" ? settingsTabs.length - 1 :
            (i + (event.key === "ArrowRight" ? 1 : -1) + settingsTabs.length) % settingsTabs.length;
          const next = settingsTabs[nextIndex];
          const hasUnsavedChanges = editor.current?.hasUnsavedChanges() ?? false;
          chooseTab(next.id);
          if (!hasUnsavedChanges) {
            document.getElementById("settings-tab-" + next.id)?.focus();
          }
        }}
      >
        {settingsTabs.map((tab) => (
          <button
            key={tab.id}
            id={"settings-tab-" + tab.id}
            type="button"
            role="tab"
            className="settings-tab"
            aria-controls={"settings-panel-" + tab.id}
            aria-selected={activeTab === tab.id}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => chooseTab(tab.id)}
          >
            {tab.title}
          </button>
        ))}
      </div>
      <div className="settings-tab-panels">
        {(activeTab === "basic" || activeTab === "files") && (
          <div className="settings-layout settings-layout-single"
            id={"settings-panel-" + activeTab} role="tabpanel"
            aria-labelledby={"settings-tab-" + activeTab}>
            <SettingsPanel key={activeTab} ref={editor} section={activeTab}
              state={state} onSaveSettings={onSaveSettings} onNotice={onNotice} />
          </div>
        )}
        {activeTab === "data" && (
          <div className="settings-support" id="settings-panel-data"
            role="tabpanel" aria-labelledby="settings-tab-data">
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
          </div>
        )}
        {activeTab === "system" && (
          <section className="card" id="settings-panel-system"
            role="tabpanel" aria-labelledby="settings-tab-system" aria-label="프로그램 정보">
            <h2>프로그램 정보</h2>
            <p>현재 버전: v{__BANDO_VERSION__}</p>
            <p>빌드 ID: {__BANDO_BUILD_ID__}</p>
          </section>
        )}
        {activeTab === "developer" && (
          <div className="settings-support" id="settings-panel-developer"
            role="tabpanel" aria-labelledby="settings-tab-developer">
            <TestDatabasePanel state={state} onReset={onRestored} />
            {window.bando?.isTestWorkspace && (
              <DeveloperLab state={state} onNotice={onNotice} revision={state.revision ?? 0} />
            )}
          </div>
        )}
      </div>
      {requestedTab && (
        <Modal title="저장하지 않은 변경사항" busy={savingBeforeLeave}
          onClose={() => setRequestedTab(null)} className="settings-unsaved-modal">
          <p>현재 탭에서 수정한 설정이 있습니다. 변경사항을 저장할까요?</p>
          <div className="actions">
            <button type="button" onClick={() => setRequestedTab(null)}>취소</button>
            <button type="button" onClick={() => {
              setActiveTab(requestedTab);
              setRequestedTab(null);
            }}>저장 안 함</button>
            <button type="button" className="primary" onClick={() => void saveAndLeave()}>
              {savingBeforeLeave ? "저장 중…" : "저장하고 이동"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
