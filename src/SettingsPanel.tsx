import { forwardRef, useImperativeHandle } from "react";
import { confirmAction } from "./dialogs";
import { uid } from "./domain";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import { useDraft } from "./shared/useDraft";
import { sameSettingsEditor, visibleSettings } from "./shared/meaningful-changes";
import { sameValue } from "./shared/draft";
import type { State } from "./types";
import { Field } from "./ui";
import { AccountPicker } from "./ui/AccountPicker";
import { HelpTooltip } from "./ui/HelpTooltip";

const same = sameValue;
function settingsChanges(saved: Record<string, unknown>, edited: Record<string, unknown>) {
  const changes: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  const comparableSaved = visibleSettings(saved as unknown as State["settings"]) as unknown as Record<string, unknown>;
  const comparableEdited = visibleSettings(edited as unknown as State["settings"]) as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(saved), ...Object.keys(edited)])) {
    if (same(comparableSaved[key], comparableEdited[key])) continue;
    changes[key] = edited[key] ?? null;
    expected[key] = saved[key] ?? null;
  }
  return { changes, expected };
}
export type SettingsPanelHandle = {
  hasUnsavedChanges: () => boolean;
  isBusy: () => boolean;
  save: () => Promise<boolean>;
  discard: () => void;
};

export const SettingsPanel = forwardRef<SettingsPanelHandle, {
  state: State;
  onSaveSettings: (changes: Record<string, unknown>, expected: Record<string, unknown>) => Promise<void>;
  onNotice: NoticeSink;
  section: "basic" | "files";
}>(function SettingsPanel({
  state,
  onSaveSettings,
  onNotice,
  section,
}, ref) {
  const {
    draft: s,
    setDraft: setS,
    conflicts,
    reset,
    dirty,
  } = useDraft(
    { ...state.settings, senderName: state.settings.senderName || "반도스탠드" },
    sameSettingsEditor,
  );
  const { busy: saving, run } = useAsyncTask(onNotice);
  const saveSettings = async (): Promise<boolean> => {
    if (saving) return false;
    if (conflicts.length) {
      onNotice("다른 작업에서 변경된 설정을 다시 불러온 뒤 저장하세요.", "error");
      return false;
    }
    const { changes, expected } = settingsChanges(
      state.settings as unknown as Record<string, unknown>,
      s as unknown as Record<string, unknown>,
    );
    if (!Object.keys(changes).length) return true;
    const result = await run(() => onSaveSettings(changes, expected));
    if (!result.ok) return false;
    onNotice("설정을 저장했습니다.", "success");
    return true;
  };
  useImperativeHandle(ref, () => ({
    hasUnsavedChanges: () => dirty,
    isBusy: () => saving,
    save: saveSettings,
    discard: reset,
  }));
  const remove = (id: string) => {
    const users = state.clients.filter((c) => !c.deletedAt && c.preferredAccountId === id);
    if (users.length) {
      onNotice(`이 계좌를 주 사용 계좌로 지정한 거래처가 ${users.length}곳 있습니다. 거래처 설정을 변경한 후 삭제하세요.`, "error");
      return;
    }
    setS((prev) => ({
      ...prev,
      accounts: prev.accounts.filter((a) => a.id !== id),
      defaultAccountId: prev.defaultAccountId === id ? "" : prev.defaultAccountId,
      brandAccounts: {
        BANDOSTAND:
          prev.brandAccounts?.BANDOSTAND === id ? "" : (prev.brandAccounts?.BANDOSTAND ?? ""),
        BANDOMALL:
          prev.brandAccounts?.BANDOMALL === id ? "" : (prev.brandAccounts?.BANDOMALL ?? ""),
      },
    }));
  };
  return (
    <section className="card settings">
      {conflicts.length > 0 && (
        <div role="alert" className="form-error">
          <p>
            다른 작업에서 같은 설정이 변경되었습니다. 입력한 내용을 확인한 뒤 다시 불러와 주세요.
          </p>
          <button
            onClick={async () => {
              if (await confirmAction("입력 중인 설정을 닫고 저장된 설정을 다시 불러올까요?"))
                reset();
            }}
          >
            저장된 설정 불러오기
          </button>
        </div>
      )}
      <div hidden={section !== "basic"}>
      <div className="settings-basic-top-grid">
        <section className="settings-basic-cell">
      <h2 className="settings-help-heading">화면 글자 크기 <HelpTooltip title="화면 글자 크기" purpose="반도허브에 표시되는 글자와 버튼 크기를 보기 편하게 조절합니다." when="글씨가 너무 작거나 화면에 정보가 잘 들어오지 않을 때 사용합니다." steps={["전체 UI 크기 목록에서 원하는 크기를 선택합니다.", "화면에 적용된 크기를 확인합니다."]} result="프로그램의 글씨와 입력창 크기가 선택한 비율로 조절됩니다." /></h2>
      <Field label="전체 UI 크기">
        <select
          value={s.uiScale ?? 100}
          onChange={(e) => {
            const value = Number(e.target.value) as 90 | 100 | 110 | 125;
            setS({ ...s, uiScale: value });
            void run(() => onSaveSettings(
              { uiScale: value },
              { uiScale: state.settings.uiScale ?? null },
            ));
          }}
        >
          {[90, 100, 110, 125].map((n) => (
            <option value={n} key={n}>
              {n}%
            </option>
          ))}
        </select>
      </Field>
      {dirty && (
        <small className="draft-status" role="status">
          저장하지 않은 설정이 있습니다.
        </small>
      )}
        </section>
        <section className="settings-basic-cell">
      <h2 className="settings-help-heading">작업 이력 <HelpTooltip title="작업 이력" purpose="누가 주문이나 입금 정보를 처리했는지 기록할 직원 이름을 설정합니다." steps={["작업자 이름을 입력합니다.", "설정 저장을 누릅니다."]} result="이후 작업 기록에 입력한 이름을 남길 수 있습니다." /></h2>
      <Field label="작업자 이름">
        <input
          value={s.operatorName ?? ""}
          placeholder="진행 / 입금 / 발송 이력에 기록할 이름"
          onChange={(e) => setS({ ...s, operatorName: e.target.value })}
        />
      </Field>
        </section>
      </div>
      <section className="settings-sender-section">
      <h2 className="settings-help-heading">반도스탠드 정보 <HelpTooltip title="반도스탠드 정보" purpose="반도스탠드에서 직접 보내는 택배의 보내는 사람 정보를 등록합니다." when="매장 발송이나 대리점 납품에 사용할 회사 정보가 바뀌었을 때 사용합니다." steps={["상호명, 주소, 우편번호와 연락처를 입력합니다.", "설정 저장을 누릅니다."]} result="매장 발송이나 직접 입력 주문에 필요한 발송인 정보로 사용됩니다." caution="거래처가 보내는 사람으로 표시되는 대리발송에서는 해당 거래처 정보를 사용합니다." /></h2>
      <div className="settings-sender-grid">
      {(
        ["senderName", "senderAddress", "senderPostcode", "senderPhone", "senderMobile"] as const
      ).map((field, index) => (
        <div className={field === "senderAddress" ? "settings-sender-address" : "settings-sender-item"} key={field}>
        <Field label={["상호명", "주소", "우편번호", "전화번호", "휴대폰 번호"][index]}>
          <input
            aria-label={
              "반도스탠드 " + ["상호명", "주소", "우편번호", "전화번호", "휴대폰 번호"][index]
            }
            value={s[field] ?? (field === "senderName" ? "반도스탠드" : "")}
            onChange={(e) => setS({ ...s, [field]: e.target.value })}
          />
        </Field>
        </div>
      ))}
      </div>
      </section>
      </div>
      <div hidden={section !== "files"}>
      <h2 className="settings-help-heading">Excel 보관함 위치 <HelpTooltip title="Excel 보관함 위치" purpose="반도허브에서 만든 Excel 파일을 컴퓨터의 어느 폴더에 저장할지 정합니다." steps={["보관함 폴더 선택 버튼을 누릅니다.", "사용할 폴더를 선택합니다.", "설정 저장을 누릅니다."]} result="공장 발송, 매장 발송, 공장 회신, 상품 관리, 거래처 관리 파일을 구분하고 날짜별 폴더에 보관합니다." caution="기존 파일을 덮어쓰지 않도록 새 파일을 저장합니다." /></h2>
      <p>{s.excelDirectory || "설정되지 않음"}</p>
      <button type="button" disabled={saving}
        onClick={() => void run(async () => {
          const folder = await window.bando!.chooseExcelDirectory();
          if (folder) setS((current) => ({ ...current, excelDirectory: folder }));
        })}>
        보관함 폴더 선택
      </button>
      {state.settings.excelDirectory && (
        <button type="button" disabled={saving}
          onClick={() => void run(() => window.bando!.openExcelDirectory())}>
          보관함 열기
        </button>
      )}

      <h2 className="settings-help-heading">공장 회신 자동 수신 폴더 <HelpTooltip title="공장 회신 자동 수신 폴더" purpose="공장에서 보내온 운송장번호와 실제 배송비가 적힌 Excel 파일을 자동으로 찾아 반영합니다." when="공장 회신 파일을 정해진 폴더에 모아둘 때 사용합니다." steps={["수신 폴더 선택을 눌러 공장 회신용 폴더를 지정합니다.", "설정 저장을 누릅니다.", "공장이 작성한 회신 Excel 파일을 지정한 폴더에 넣습니다.", "일치하지 않는 내용은 공장 회신 이력에서 확인합니다."]} result="반도허브 실행 중 새 파일을 확인하고 수취인 정보가 일치하는 배송 건의 운송장번호와 실제 운임을 반영합니다." caution="업무 Excel 보관함과 별도의 폴더를 지정합니다. 개발자 시험 환경에서는 실사용 폴더를 감시하지 않습니다." /></h2>
      <p>{window.bando?.isTestWorkspace ? "격리 TEST / Excel / 공장 회신 수신" :
        (s.factoryReplyDirectory || "미설정: 수동 Excel 업로드만 사용")}</p>
      {!window.bando?.isTestWorkspace && (
        <div className="settings-actions">
          <button type="button" disabled={saving}
            onClick={() => void run(async () => {
              if (!window.bando?.chooseFactoryReplyDirectory) {
                throw Error("공장 회신 수신 폴더 선택 기능을 사용할 수 없습니다.");
              }
              const folder = await window.bando.chooseFactoryReplyDirectory();
              if (folder) setS((current) => ({ ...current, factoryReplyDirectory: folder }));
            })}>
            수신 폴더 선택
          </button>
          <button type="button" disabled={saving || !s.factoryReplyDirectory}
            onClick={() => setS((current) => ({ ...current, factoryReplyDirectory: "" }))}>
            자동 수신 중지
          </button>
        </div>
      )}


      </div>
      <div hidden={section !== "basic"}>
      <h2 className="settings-help-heading">입금 계좌 <HelpTooltip title="입금 계좌" purpose="거래처에 입금 안내를 보낼 때 사용할 은행 계좌를 등록합니다." steps={["은행명, 계좌번호, 예금주를 입력해 계좌를 추가합니다.", "필요하면 반도스탠드와 반도몰에 사용할 기본 계좌를 각각 선택합니다.", "설정 저장을 누릅니다."]} result="주문 상품 종류에 맞는 계좌를 입금 안내에 사용할 수 있습니다." caution="거래처에 지정된 계좌나 주문에서 직접 선택한 계좌가 있다면 그 설정이 우선합니다. 부가세는 주문별 조건에 따라 계산합니다." /></h2>

      <div className="account-rows">
        {s.accounts.map((a, index) => (
          <div className="account-row" key={a.id}>
            {(["bank", "number", "holder"] as const).map((k, i) => (
              <Field key={k} label={["은행명", "계좌번호", "예금주"][i]}>
                <input
                  aria-label={`${["은행명", "계좌번호", "예금주"][i]} ${index + 1}`}
                  value={a[k]}
                  onChange={(e) =>
                    setS((prev) => ({
                      ...prev,
                      accounts: prev.accounts.map((x) =>
                        x.id === a.id ? { ...x, [k]: e.target.value } : x,
                      ),
                    }))
                  }
                />
              </Field>
            ))}
            <button
              type="button"
              className="account-delete danger"
              aria-label={`계좌 삭제 ${index + 1}`}
              onClick={() => remove(a.id)}
            >
              계좌 삭제
            </button>
          </div>
        ))}
      </div>
      <div className="settings-actions">
        <button
          type="button"
          onClick={() =>
            setS({
              ...s,
              accounts: [...s.accounts, { id: uid(), bank: "", number: "", holder: "" }],
            })
          }
        >
          ＋ 계좌 추가
        </button>
      </div>
      <div className="account-recommendations">
        {(["BANDOSTAND", "BANDOMALL"] as const).map((b) => (
          <AccountPicker
            key={b}
            label={b === "BANDOSTAND" ? "반도스탠드 추천 계좌" : "반도몰 추천 계좌"}
            accounts={s.accounts}
            value={s.brandAccounts?.[b] ?? ""}
            onChange={(value) =>
              setS((prev) => ({
                ...prev,
                brandAccounts: {
                  BANDOSTAND: prev.brandAccounts?.BANDOSTAND ?? "",
                  BANDOMALL: prev.brandAccounts?.BANDOMALL ?? "",
                  [b]: value,
                },
              }))
            }
          />
        ))}
      </div>

      </div>
      <div className="settings-actions">
        <button
          className="primary"
          disabled={saving || conflicts.length > 0}
          onClick={() => void saveSettings()}
        >
          {saving ? "저장 중…" : "설정 저장"}
        </button>
      </div>
    </section>
  );
});
