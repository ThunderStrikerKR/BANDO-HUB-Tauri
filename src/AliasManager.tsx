import { useState } from "react";
import { sameValue } from "./shared/draft";
import { usePageLeaveGuard } from "./shared/page-leave";
import { uid } from "./domain";
import { aliasProblems, internalModel, saveAlias } from "./matching";
import { ProductSearchDialog } from "./ProductSearchDialog";
import type { NoticeSink } from "./shared/notices";
import type { State } from "./types";
export function AliasManager({
  state,
  onSave,
  onNotice,
}: {
  state: State;
  onSave: (s: State) => Promise<void>;
  onNotice: NoticeSink;
}) {
  const [text, setText] = useState(""),
    [target, setTarget] = useState(""),
    [scope, setScope] = useState("common"),
    [search, setSearch] = useState(false),
    [editing, setEditing] = useState<string>();
  const [originalForm, setOriginalForm] = useState({ text: "", target: "", scope: "common", editing: undefined as string | undefined });
  const dirty = !sameValue({ text, target, scope, editing }, originalForm);
  const discard = () => {
    setText(originalForm.text);setTarget(originalForm.target);setScope(originalForm.scope);setEditing(originalForm.editing);
  };
  const saveEntry = async (): Promise<boolean> => {
    try {
      await onSave(saveAlias(state, {
        id: editing ?? uid(), text, productId: target,
        variantId: state.products.find((p) => p.id === target)?.variants[0]?.id,
        clientId: scope === "common" ? null : scope,
        actor: state.settings.operatorName || "직원", createdAt: new Date().toISOString(),
      }));
      setEditing(undefined);setText("");setTarget("");
      setOriginalForm({text:"",target:"",scope,editing:undefined});
      return true;
    } catch (error) {onNotice(String(error), "error");return false;}
  };
  usePageLeaveGuard({ label: "상품 별칭", hasChanges: () => dirty, save: saveEntry, discard });
  return (
    <section className="card alias-manager">
      <h2>공통 / 거래처 별칭 관리</h2>
      <p>
        넓은 상품 종류명과 실제 개별 상품에 충돌하는 별칭은 등록하지 않습니다. 기존 충돌은 삭제하지 않고
        아래에 표시합니다.
      </p>
      <input aria-label="관리 별칭" value={text} onChange={(e) => setText(e.target.value)} />
      <select aria-label="관리 별칭 범위" value={scope} onChange={(e) => setScope(e.target.value)}>
        <option value="common">회사 공통 별칭</option>
        {state.clients
          .filter((c) => !c.deletedAt)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
      <button onClick={() => setSearch(true)}>
        {target
          ? internalModel(state.products.find((p) => p.id === target)?.name ?? "상품")
          : "등록 상품 선택"}
      </button>
      <button
        onClick={() => void saveEntry()}
      >
        별칭 저장
      </button>
      <div className="alias-list">
        {state.aliases.map((a) => {
          const problems = aliasProblems(a, state.aliases, state.products);
          return (
            <article key={a.id}>
              <b>{a.text}</b> →{" "}
              {internalModel(state.products.find((p) => p.id === a.productId)?.name ?? "과거 상품")}{" "}
 / {a.clientId ? state.clients.find((c) => c.id === a.clientId)?.name : "회사 공통"}
              {problems.length > 0 && (
                <p className="warnings">
                  {problems.join(" / ")} / 영향 범위:{" "}
                  {a.clientId ? "해당 거래처의 이후 주문" : "모든 거래처의 이후 주문"}
                </p>
              )}
              <button
                onClick={() => {
                  setEditing(a.id);
                  setText(a.text);
                  setTarget(a.productId);
                  setScope(a.clientId ?? "common");
                  setOriginalForm({text:a.text,target:a.productId,scope:a.clientId ?? "common",editing:a.id});
                }}
              >
                연결 정정
              </button>
            </article>
          );
        })}
      </div>
      {search && (
        <ProductSearchDialog
          state={state}
          onClose={() => setSearch(false)}
          onChoose={(p) => {
            setTarget(p.id);
            setSearch(false);
          }}
        />
      )}
    </section>
  );
}
