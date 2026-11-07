import { useState } from "react";
import { ProductSearchDialog } from "./ProductSearchDialog";
import { itemFromProduct, validProductUrl } from "./domain";
import { internalModel } from "./matching";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { Client, Item, Product, State } from "./types";
import { Field, Modal, MoneyInput } from "./ui";
export function OrderItemEditor({
  state,
  item,
  client,
  locked,
  onApply,
  onConfirm,
  onClose,
  onRemove,
}: {
  state: State;
  item: Item;
  client: Client;
  locked: boolean;
  onApply: (i: Item) => void;
  onConfirm: () => void;
  onClose: () => void;
  onRemove: () => void;
}) {
  const { run: openLink } = useAsyncTask();
  const [draft, setDraft] = useState(() => structuredClone(item)),
    [search, setSearch] = useState(false);
  const p = state.products.find((p) => p.id === draft.productId),
    change = (p: Product) => {
      setDraft({
        ...itemFromProduct(p, client,
          p.variants.length === 1 && !p.requiresOption ? p.variants[0]?.color : undefined,
          draft.quantity,
          p.variants.length === 1 && !p.requiresOption ? p.variants[0]?.id : undefined),
        id: item.id,
        raw: item.raw,
        sources: item.sources,
        quantityConfirmed: draft.quantityConfirmed,
        manuallyConfirmed: true,
      });
      setSearch(false);
    };
  return (
    <>
      <Modal draft={draft} title="상품 상세 수정" onClose={onClose}>
        <div className="item-editor-heading">
          <h3>
            {internalModel(p?.code ?? draft.name)}
            <small>{p?.subtitle || p?.category}</small>
          </h3>
          {validProductUrl(draft.url) && (
            <button onClick={() => void openLink(() => window.bando!.openProduct(draft.url))}>
              상세보기 ↗
            </button>
          )}
        </div>
        <button disabled={locked} onClick={() => setSearch(true)}>
          상품 변경
        </button>
        <Field label="옵션">
          <select
            disabled={locked || !p}
            value={draft.variantId ?? ""}
            onChange={(e) => {
              const v = p?.variants.find((v) => v.id === e.target.value);
              if (p && v)
                setDraft({
                  ...draft,
                  ...itemFromProduct(p, client, v.color, draft.quantity, v.id),
                  id: item.id,
                  raw: item.raw,
                  sources: item.sources,
                  quantityConfirmed: draft.quantityConfirmed,
                  manuallyConfirmed: true,
                });
            }}
          >
            {p?.variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.color} {v.option}
              </option>
            ))}
          </select>
        </Field>
        <Field label="수량">
          <input
            disabled={locked}
            type="number"
            min="1"
            value={draft.quantity ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                quantity: e.target.value === "" ? null : Number(e.target.value),
                quantityConfirmed: true,
              })
            }
          />
        </Field>
        <Field label="적용 가격">
          <MoneyInput
            value={draft.unitPrice}
            onChange={(unitPrice) => {
              if (!locked) setDraft({ ...draft, unitPrice });
            }}
          />
        </Field>
        {item.modelProposal?.required && (
          <button disabled={locked} onClick={onConfirm}>
            고객 확인 완료
          </button>
        )}
        <div className="row-end modal-footer">
          <button className="danger" disabled={locked} onClick={onRemove}>
            삭제
          </button>
          <button onClick={onClose}>취소</button>
          <button
            className="primary"
            disabled={
              locked ||
              !draft.productId ||
              !draft.variantId ||
              !Number.isSafeInteger(draft.quantity) ||
              (draft.quantity ?? 0) < 1
            }
            onClick={() => {
              const next = { ...draft, manuallyConfirmed: true };
              if (
                JSON.stringify([item.productId, item.variantId, item.quantity]) !==
                JSON.stringify([draft.productId, draft.variantId, draft.quantity])
              )
                delete next.quantityApproval;
              onApply(next);
              onClose();
            }}
          >
            적용
          </button>
        </div>
      </Modal>
      {search && (
        <ProductSearchDialog
          state={state}
          clientId={client.id}
          onChoose={change}
          onClose={() => setSearch(false)}
        />
      )}
    </>
  );
}
