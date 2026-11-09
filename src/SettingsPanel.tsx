import { forwardRef, useImperativeHandle } from "react";
import { confirmAction } from "./dialogs";
import { uid } from "./domain";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import { useDraft } from "./shared/useDraft";
import type { State } from "./types";
import { Field } from "./ui";
import { AccountPicker } from "./ui/AccountPicker";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function settingsChanges(saved: Record<string, unknown>, edited: Record<string, unknown>) {
  const changes: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(saved), ...Object.keys(edited)])) {
    if (same(saved[key], edited[key])) continue;
    changes[key] = edited[key] ?? null;
    expected[key] = saved[key] ?? null;
  }
  return { changes, expected };
}
export type SettingsPanelHandle = {
  hasUnsavedChanges: () => boolean;
  isBusy: () => boolean;
  save: () => Promise<boolean>;
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
  } = useDraft({ ...state.settings, senderName: state.settings.senderName || "반도스탠드" });
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
      <h2>화면 글자 크기</h2>
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
      <h2>작업 이력</h2>
      <Field label="작업자 이름">
        <input
          value={s.operatorName ?? ""}
          placeholder="진행 / 입금 / 발송 이력에 기록할 이름"
          onChange={(e) => setS({ ...s, operatorName: e.target.value })}
        />
      </Field>
      <h2>반도스탠드 정보</h2>
      {(
        ["senderName", "senderAddress", "senderPostcode", "senderPhone", "senderMobile"] as const
      ).map((field, index) => (
        <Field key={field} label={["상호명", "주소", "우편번호", "전화번호", "휴대폰 번호"][index]}>
          <input
            aria-label={
              "반도스탠드 " + ["상호명", "주소", "우편번호", "전화번호", "휴대폰 번호"][index]
            }
            value={s[field] ?? (field === "senderName" ? "반도스탠드" : "")}
            onChange={(e) => setS({ ...s, [field]: e.target.value })}
          />
        </Field>
      ))}
      </div>
      <div hidden={section !== "files"}>
      <h2>Excel 보관함 위치</h2>
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
      <p className="muted">
        보관함 하나를 선택하고 아래 설정 저장을 눌러 주세요.
        공장 발송, 매장 발송, 공장 회신, 상품 관리, 거래처 관리 폴더를 자동으로 구분합니다.
        각 폴더 아래는 연도, 월, 일 순서로 분류하며 기존 파일을 덮어쓰지 않습니다.
      </p>
      <h2>공장 회신 자동 수신 폴더</h2>
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
      <p className="muted">
        폴더 선택 후 아래 설정 저장을 누르면 자동 감시가 시작됩니다.
        반도허브 실행 중 5초마다 새 XLSX 파일을 확인하고,
        파일 쓰기가 끝난 뒤 수취인 정보가 일치하는 건만 운송장번호와 실제 운임을 반영합니다.
        잘못된 양식 및 일치하지 않는 행은 공장 회신 이력에 보류합니다.
        업무 Excel 보관함과 별개의 수신 폴더를 선택하세요.
      </p>
      <p className="muted">
        격리 TEST에서는 별도 수신 폴더만 사용하며 실사용 수신 폴더를 감시하지 않습니다.
        원본은 앱 데이터에 보관하고 별도 사본은 Excel 보관함에 저장합니다.
      </p>
      </div>
      <div hidden={section !== "basic"}>
      <h2>입금 계좌</h2>
      <p className="muted">
        반도스탠드 상품 및 혼합 주문은 반도스탠드 계좌, 반도몰 상품만 있는 주문은 반도몰 계좌를
        추천합니다.
      </p>
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
      <p className="muted">
        부가세는 주문별 기본 해제입니다. 원 미만 세액은 현재 반올림하며 회사 회계 기준을 확인해야
        합니다. 대리발송 송하인은 거래처, 대리점 납품 / 직접 입력은 반도스탠드 정보를 사용합니다.
      </p>
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
