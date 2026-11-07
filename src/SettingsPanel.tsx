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
export function SettingsPanel({
  state,
  onSaveSettings,
  onNotice,
}: {
  state: State;
  onSaveSettings: (changes: Record<string, unknown>, expected: Record<string, unknown>) => Promise<void>;
  onNotice: NoticeSink;
}) {
  const {
    draft: s,
    setDraft: setS,
    conflicts,
    reset,
    dirty,
  } = useDraft({ ...state.settings, senderName: state.settings.senderName || "반도스탠드" });
  const { busy: saving, run } = useAsyncTask(onNotice);
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
      <h2>공장 회신 수신 폴더</h2>
      <p>{s.factoryReplyDirectory || "설정되지 않음"}</p>
      <button
        onClick={() =>
          void run(async () => {
            const folder = await window.bando!.chooseExcelDirectory();
            if (folder) setS({ ...s, factoryReplyDirectory: folder });
          })
        }
      >
        공장 회신 폴더 선택
      </button>
      <p className="muted">
        공장 회신 폴더 지정은 가능하지만 자동 감지는 아직 지원하지 않습니다.
        회신 파일은 공장 회신 가져오기에서 직접 선택해 주세요.
      </p>
      <h2>엑셀 기본 저장 폴더</h2>
      <p>{s.excelDirectory || "설정되지 않음"}</p>
      <button
        onClick={() =>
          void run(async () => {
            const folder = await window.bando!.chooseExcelDirectory();
            if (folder) setS({ ...s, excelDirectory: folder });
          })
        }
      >
        폴더 선택
      </button>
      {state.settings.excelDirectory && (
        <button
          type="button"
          disabled={saving}
          onClick={() => void run(() => window.bando!.openExcelDirectory())}
        >
          저장된 폴더 열기
        </button>
      )}
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
        합니다. 대리발송 송하인은 거래처, 대리점 납품 / 소매 주문은 반도스탠드 정보를 사용합니다.
      </p>
      <div className="settings-actions">
        <button
          className="primary"
          disabled={saving || conflicts.length > 0}
          onClick={() =>
            void run(async () => {
              if (conflicts.length) throw Error("변경된 설정을 다시 불러온 뒤 저장하세요.");
              const { changes, expected } = settingsChanges(
                state.settings as unknown as Record<string, unknown>,
                s as unknown as Record<string, unknown>,
              );
              if (!Object.keys(changes).length) return;
              await onSaveSettings(changes, expected);
              reset();
              onNotice("설정을 저장했습니다.", "success");
            })
          }
        >
          {saving ? "저장 중…" : "설정 저장"}
        </button>
      </div>
    </section>
  );
}
