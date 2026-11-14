import { useRef, useState, type KeyboardEvent } from "react";
import { ProductSearchDialog } from "../ProductSearchDialog";
import { businessCoreCall } from "../tauri-bridge";
import { deliveryRequirements } from "../delivery-requirements";
import { usePendingChanges } from "../shared/pending-changes";
import { confirmDiscardDraft } from "../shared/editor-flow";
import type { NoticeSink } from "../shared/notices";
import type { Order, Product, State } from "../types";
import { orderIssues } from "../validation";
import { ManualPrompt } from "./ManualPrompt";
import {
  assignManualBlock,
  cellKey,
  emptyManualItem,
  initialManual,
  manualValue,
  newManualRecipient,
  pendingManualQuantity,
  releaseManualBlock,
  setManualValue,
  validManualQuantity,
  type Cell,
  type ManualModel,
} from "./manual-classification";

type Frame = {
  model: ManualModel;
  entry: Record<string, string>;
  quantityText: Record<string, string>;
  pending?: Cell;
  rollback?: Frame;
};
export function ManualClassification({
  state,
  order,
  onApply,
  onClose,
}: {
  state: State;
  order: Order;
  onApply: (order: Order) => void;
  onClose: () => void;
  onNotice: NoticeSink;
}) {
  const [model, setModel] = useState(() => initialManual(order));
  const manualQuantityRequest = useRef<Record<string, number>>({});
  const manualTextRequest = useRef<Record<string, number>>({});
  const manualQuantityPending = useRef<Set<string>>(new Set());
  const latestInputs = useRef({ order, model });
  latestInputs.current = { order, model };
  const initial = useRef(JSON.stringify(model));
  const [count, setCount] = useState(String(model.rows.length));
  const [active, setActive] = useState<Cell>(),
    [search, setSearch] = useState<Cell>();
  const [pending, setPendingState] = useState<Cell>();
  const [entry, setEntry] = useState<Record<string, string>>({});
  const [quantityText, setQuantityText] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ key?: string; message: string }>();
  const [completion, setCompletion] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; message: string; execute: () => void }>();
  const root = useRef<HTMLElement>(null),
    pendingRef = useRef<Cell | undefined>(undefined);
  const history = useRef<Frame[]>([]),
    beforeProduct = useRef<Frame | undefined>(undefined);
  const editStart = useRef<{ cell: Cell; frame: Frame } | undefined>(undefined),
    applying = useRef(false);
  const dirty = JSON.stringify(model) !== initial.current || Object.keys(entry).length > 0 ||
    count !== String(model.rows.length);
  usePendingChanges(dirty);
  const closeDraft = () => void confirmDiscardDraft("수동 분류", dirty, onClose);
  const frame = (): Frame =>
    structuredClone({ model, entry, quantityText, pending, rollback: beforeProduct.current });
  const checkpoint = () => {
    history.current.push(frame());
    if (history.current.length > 100) history.current.shift();
  };
  const setPending = (cell?: Cell) => {
    pendingRef.current = cell;
    setPendingState(cell);
  };
  const restore = (value: Frame) => {
    setModel(value.model);
    setEntry(value.entry);
    setQuantityText(value.quantityText);
    setPending(value.pending);
    beforeProduct.current = value.rollback;
    setCount(String(value.model.rows.length));
    setError(undefined);
  };
  const focus = (cell: Cell) => {
    setActive(cell);
    requestAnimationFrame(() => {
      const input = root.current?.querySelector<HTMLInputElement>(
        `input[data-cell="${CSS.escape(cellKey(cell))}"]`,
      );
      input?.focus({ preventScroll: true });
      input?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  };
  const fail = (message: string, cell?: Cell) =>
    setError({ key: cell ? cellKey(cell) : undefined, message });
  const attempt = (action: () => void, cell?: Cell) => {
    try {
      action();
      setError(undefined);
    } catch (e) {
      fail(String(e).replace(/^Error: /, ""), cell);
    }
  };
  const allowed = (cell: Cell) =>
    !pendingRef.current || cellKey(pendingRef.current) === cellKey(cell);
  const nextMissing = (next: ManualModel, cell: Cell) => {
    const slots = next.rows.flatMap((row) => {
      const required = deliveryRequirements(row, order.receptionVersion !== 1);
      return [
        !required.name && { recipientId: row.id, field: "name" },
        !required.address && { recipientId: row.id, field: "address" },
        !required.contact && { recipientId: row.id, field: "mobile" },
      ].filter(Boolean) as Cell[];
    });
    const rowIndex = next.rows.findIndex((row) => row.id === cell.recipientId);
    const fields = ["name", "address", "mobile", "phone"];
    const position = rowIndex * 4 + fields.indexOf(cell.field);
    const following = slots.find(
      (slot) =>
        next.rows.findIndex((row) => row.id === slot.recipientId) * 4 + fields.indexOf(slot.field) >
        position,
    );
    if (following) focus(following);
  };
  const cancelProduct = () => {
    const cell = pendingRef.current;
    if (!cell) return;
    checkpoint();
    if (beforeProduct.current) restore(beforeProduct.current);
    else {
      setPending(undefined);
      setQuantityText({});
    }
    beforeProduct.current = undefined;
    setEntry((old) => {
      const next = { ...old };
      delete next[cellKey({ ...cell, field: "product" })];
      return next;
    });
    setQuantityText((old) => {
      const next = { ...old };
      delete next[cellKey(cell)];
      return next;
    });
    focus({ ...cell, field: "product" });
  };
  const selectProduct = (cell: Cell, value: string, product?: Product) => {
    if (!allowed(cell)) return;
    attempt(() => {
      const next = setManualValue(model, cell, value, state, order, product);
      checkpoint();
      beforeProduct.current = frame();
      setModel(next);
      setEntry((old) => {
        const copy = { ...old };
        delete copy[cellKey(cell)];
        return copy;
      });
      setQuantityText((old) => ({ ...old, [cellKey({ ...cell, field: "quantity" })]: "" }));
      setSearch(undefined);
      setPending({ ...cell, field: "quantity" });
      focus({ ...cell, field: "quantity" });
    }, cell);
  };
  const finishQuantity = (): boolean => {
    const cell = pendingRef.current;
    if (!cell) return true;
    if (manualQuantityPending.current.has(cellKey(cell))) {
      fail("입력 중인 수량을 확인하고 있습니다. 다시 완료해 주세요.", cell);
      return false;
    }
    const item = model.rows
      .find((row) => row.id === cell.recipientId)
      ?.items.find((item) => item.id === cell.itemId);
    if (!item || !validManualQuantity(item.quantity)) {
      fail("수량을 1 이상의 정수로 입력하세요.", cell);
      focus(cell);
      return false;
    }
    const next = structuredClone(model);
    next.rows
      .find((row) => row.id === cell.recipientId)!
      .items.find((item) => item.id === cell.itemId)!.quantityConfirmed = true;
    checkpoint();
    setModel(next);
    setPending(undefined);
    beforeProduct.current = undefined;
    setError(undefined);
    return true;
  };
  const useBlock = (id: string) => {
    const assigned = model.assignments[id];
    if (assigned) {
      if (pendingRef.current && assigned.itemId !== pendingRef.current.itemId) {
        fail("선택한 상품의 수량을 먼저 확정하세요.", pendingRef.current);
        return;
      }
      attempt(() => {
        const next = releaseManualBlock(model, id, true, state, order);
        checkpoint();
        setModel(next);
        setEntry((old) => {
          const copy = { ...old };
          delete copy[cellKey(assigned)];
          return copy;
        });
        if (assigned.itemId)
          setQuantityText((old) => {
            const copy = { ...old };
            delete copy[cellKey({ ...assigned, field: "quantity" })];
            return copy;
          });
        if (assigned.field === "product") {
          setPending(undefined);
          beforeProduct.current = undefined;
        }
        if (assigned.field === "quantity") setPending({ ...assigned, field: "quantity" });
      }, assigned);
      return;
    }
    const cell = pendingRef.current ?? active;
    if (!cell) {
      fail("입력할 셀을 선택하세요.");
      return;
    }
    if (pendingRef.current && model.blocks.find((block) => block.id === id)?.field !== "quantity") {
      fail("선택한 상품의 수량을 먼저 확정하세요.", pendingRef.current);
      return;
    }
    attempt(() => {
      const next = assignManualBlock(model, id, cell, state, order);
      checkpoint();
      setModel(next);
      setEntry((old) => {
        const copy = { ...old };
        delete copy[cellKey(cell)];
        return copy;
      });
      if (cell.field === "product") {
        beforeProduct.current = frame();
        setPending({ ...cell, field: "quantity" });
        setQuantityText((old) => ({ ...old, [cellKey({ ...cell, field: "quantity" })]: "" }));
        focus({ ...cell, field: "quantity" });
      } else if (cell.field === "quantity") {
        setQuantityText((old) => ({ ...old, [cellKey(cell)]: manualValue(next, cell) }));
        setPending(undefined);
        beforeProduct.current = undefined;
      } else nextMissing(next, cell);
    }, cell);
  };
  const resize = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 1 || n > 100) {
      fail("배송 건수는 1~100건입니다.");
      return;
    }
    if (pendingRef.current) {
      setCount(String(model.rows.length));
      fail("수량을 확정하거나 상품 선택을 취소하세요.", pendingRef.current);
      return;
    }
    if (n === model.rows.length) {
      setCount(String(n));
      return;
    }
    const execute = () => {
      const next = structuredClone(model);
      next.rows = next.rows.slice(0, n);
      while (next.rows.length < n) next.rows.push(newManualRecipient());
      const ids = new Set(next.rows.map((row) => row.id));
      next.assignments = Object.fromEntries(
        Object.entries(next.assignments).filter(([, a]) => ids.has(a.recipientId)),
      );
      setModel(next);
      setCount(String(n));
      setEntry({});
      setQuantityText({});
      history.current = [];
      setError(undefined);
      if (active && !ids.has(active.recipientId)) setActive(undefined);
    };
    const removed = model.rows.slice(n);
    const populated = removed.some(
      (row) =>
        row.name ||
        row.address ||
        row.mobile ||
        row.phone ||
        row.note ||
        row.items.some((item) => item.name || item.productId || item.quantity !== null) ||
        Object.values(model.assignments).some((a) => a.recipientId === row.id),
    );
    setCount(String(model.rows.length));
    if (populated)
      setConfirm({
        title: "배송 건수 줄이기",
        message: "마지막 배송 건의 입력값과 원문 배정을 제거할까요?",
        execute,
      });
    else execute();
  };
  const addProduct = (recipientId: string) => {
    const item = emptyManualItem();
    checkpoint();
    setModel((old) => ({
      ...old,
      rows: old.rows.map((row) =>
        row.id === recipientId ? { ...row, items: [...row.items, item] } : row,
      ),
    }));
    setError(undefined);
    focus({ recipientId, itemId: item.id, field: "product" });
  };
  const removeProduct = (cell: Cell) => {
    checkpoint();
    setModel((old) => ({
      ...old,
      rows: old.rows.map((row) =>
        row.id === cell.recipientId
          ? { ...row, items: row.items.filter((item) => item.id !== cell.itemId) }
          : row,
      ),
      assignments: Object.fromEntries(
        Object.entries(old.assignments).filter(([, a]) => a.itemId !== cell.itemId),
      ),
    }));
    setError(undefined);
  };
  const move = (cell: Cell, key: string, shift = false) => {
    const inputs = Array.from(
      root.current?.querySelectorAll<HTMLInputElement>("input[data-cell]") ?? [],
    );
    const index = inputs.findIndex((input) => input.dataset.cell === cellKey(cell));
    let target: HTMLInputElement | undefined;
    if (key === "ArrowUp" || key === "ArrowDown") {
      const rows = model.rows,
        rowIndex = rows.findIndex((row) => row.id === cell.recipientId),
        nextRow = rows[rowIndex + (key === "ArrowUp" ? -1 : 1)];
      if (nextRow) {
        const current = rows[rowIndex].items.findIndex((item) => item.id === cell.itemId);
        const nextCell = {
          ...cell,
          recipientId: nextRow.id,
          itemId: cell.itemId
            ? nextRow.items[Math.min(Math.max(current, 0), nextRow.items.length - 1)]?.id
            : undefined,
        };
        target = inputs.find((input) => input.dataset.cell === cellKey(nextCell));
      }
    } else target = inputs[index + (key === "ArrowLeft" || (key === "Tab" && shift) ? -1 : 1)];
    if (target && !target.disabled) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>, cell: Cell) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") return;
    const key = cellKey(cell);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (pendingRef.current) {
        cancelProduct();
        return;
      }
      if (cell.field === "product")
        setEntry((old) => {
          const copy = { ...old };
          delete copy[key];
          return copy;
        });
      else if (editStart.current && cellKey(editStart.current.cell) === key) {
        const previous = editStart.current.frame.model.rows.find(
          (row) => row.id === cell.recipientId,
        );
        if (previous) {
          checkpoint();
          if (cell.itemId) {
            setModel((old) => ({
              ...old,
              rows: old.rows.map((row) =>
                row.id === cell.recipientId
                  ? {
                      ...row,
                      items: row.items.map((item) =>
                        item.id === cell.itemId
                          ? structuredClone(previous.items.find((item) => item.id === cell.itemId)!)
                          : item,
                      ),
                    }
                  : row,
              ),
            }));
            setQuantityText((old) => {
              const copy = { ...old };
              delete copy[key];
              return copy;
            });
          } else
            setModel((old) => ({
              ...old,
              rows: old.rows.map((row) =>
                row.id === cell.recipientId
                  ? { ...row, [cell.field]: previous[cell.field as "name"] }
                  : row,
              ),
            }));
        }
      }
      setError(undefined);
      return;
    }
    if (!["Tab", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key))
      return;
    event.preventDefault();
    if (
      cell.field === "product" &&
      entry[key] !== undefined &&
      entry[key] !== manualValue(model, cell)
    ) {
      selectProduct(cell, entry[key]);
      return;
    }
    if (pendingRef.current) {
      if (cell.field === "quantity" && (event.key === "Enter" || event.key === "Tab")) {
        if (!finishQuantity()) return;
        requestAnimationFrame(() => move(cell, event.key, event.shiftKey));
        return;
      } else {
        fail("수량을 확정하거나 상품 선택을 취소하세요.", pendingRef.current);
        return;
      }
    }
    move(cell, event.key, event.shiftKey);
  };
  const textCell = (cell: Cell, label: string) => {
    const key = cellKey(cell),
      row = model.rows.find((row) => row.id === cell.recipientId)!,
      required = deliveryRequirements(row, order.receptionVersion !== 1);
    const item = row.items.find((item) => item.id === cell.itemId);
    const invalid =
      cell.field === "name"
        ? !required.name
        : cell.field === "address"
          ? !required.address
          : ["phone", "mobile"].includes(cell.field)
            ? !required.contact
            : cell.field === "product"
              ? !item?.productId || !item?.variantId
              : cell.field === "quantity"
                ? !validManualQuantity(item?.quantity) || item?.quantityConfirmed === false
                : false;
    const value =
      cell.field === "product"
        ? (entry[key] ?? manualValue(model, cell))
        : cell.field === "quantity"
          ? (quantityText[key] ?? manualValue(model, cell))
          : (entry[key] ?? manualValue(model, cell));
    const input = (
      <input
        data-cell={key}
        aria-label={label}
        aria-selected={!!active && cellKey(active) === key}
        aria-invalid={invalid}
        title={invalid ? "필수정보를 확인하세요" : undefined}
        disabled={!allowed(cell)}
        value={value}
        inputMode={cell.field === "quantity" ? "numeric" : undefined}
        onFocus={() => {
          setActive(cell);
          editStart.current = { cell, frame: frame() };
        }}
        onChange={(event) => {
          if (!allowed(cell)) return;
          const value = event.target.value;
          checkpoint();
          setError(undefined);
          if (cell.field === "product") {
            setEntry((old) => {
              const next = { ...old };
              if (value === manualValue(model, cell)) delete next[key];
              else next[key] = value;
              return next;
            });
            return;
          }
          if (cell.field === "quantity") {
            const request = (manualQuantityRequest.current[key] ?? 0) + 1;
            manualQuantityRequest.current[key] = request;
            manualQuantityPending.current.add(key);
            setQuantityText((old) => ({ ...old, [key]: value }));
            if (!pendingRef.current) beforeProduct.current = frame();
            setPending(cell);
            // Incomplete typing is a valid draft; only Rust interprets the quantity.
            void businessCoreCall<{ quantity: number | null; quantityConfirmed: boolean }>(
              "rules", "apply_manual_classification", {
                action: "parse_manual_quantity", value,
              },
            ).then(({ quantity }) => {
              if (manualQuantityRequest.current[key] !== request ||
                  latestInputs.current.order !== order) return;
              manualQuantityPending.current.delete(key);
              setModel((current) => {
                const next = structuredClone(current);
                const item = next.rows.find((row) => row.id === cell.recipientId)
                  ?.items.find((item) => item.id === cell.itemId);
                if (!item) return current;
                item.quantity = quantity;
                item.quantityConfirmed = false;
                delete item.quantityApproval;
                item.issues = item.issues.filter((issue) => !issue.includes("수량"));
                return next;
              });
            }).catch((e) => {
              if (manualQuantityRequest.current[key] === request) {
                manualQuantityPending.current.delete(key);
                fail(e instanceof Error ? e.message : String(e), cell);
              }
            });
            return;
          }
          if (["name", "address", "phone", "mobile", "note"].includes(cell.field)) {
            const request = (manualTextRequest.current[key] ?? 0) + 1;
            manualTextRequest.current[key] = request;
            setEntry((old) => ({ ...old, [key]: value }));
            void businessCoreCall<{ model: ManualModel }>(
              "rules", "apply_manual_classification", {
                action: "set_manual_recipient_field", model, cell, value,
              },
            ).then(({ model: updated }) => {
              if (manualTextRequest.current[key] !== request ||
                  latestInputs.current.order !== order) return;
              const changed = updated.rows.find((row) => row.id === cell.recipientId);
              if (!changed) throw Error("배송 행을 선택하세요.");
              setModel((current) => {
                const next = structuredClone(current);
                const row = next.rows.find((row) => row.id === cell.recipientId);
                if (!row) return current;
                const field = cell.field as "name" | "address" | "phone" | "mobile" | "note";
                row[field] = changed[field];
                if (field === "address") {
                  row.addressParts = changed.addressParts;
                  delete row.addressStatus;
                }
                row.confirmedFields = [...new Set([...(row.confirmedFields ?? []), field])];
                return next;
              });
              setEntry((old) => {
                const next = { ...old };
                delete next[key];
                return next;
              });
            }).catch((e) => {
              if (manualTextRequest.current[key] === request)
                fail(e instanceof Error ? e.message : String(e), cell);
            });
            return;
          }
          attempt(() => setModel(setManualValue(model, cell, value, state, order)), cell);
        }}
        onBlur={() => {
          if (
            cell.field === "product" &&
            entry[key] !== undefined &&
            entry[key] !== manualValue(model, cell)
          )
            selectProduct(cell, entry[key]);
        }}
        onKeyDown={(event) => keyDown(event, cell)}
      />
    );
    if (cell.field !== "quantity") return input;
    const increment = (delta: number) => {
      if (!allowed(cell) || manualQuantityPending.current.has(key)) return;
      checkpoint();
      const value = Math.max(1, Number(manualValue(model, cell) || 0) + delta);
      const request = (manualQuantityRequest.current[key] ?? 0) + 1;
      manualQuantityRequest.current[key] = request;
      manualQuantityPending.current.add(key);
      void businessCoreCall<{ quantity: number | null; quantityConfirmed: boolean }>(
        "rules", "apply_manual_classification", {
          action: "parse_manual_quantity", value: String(value),
        },
      ).then(({ quantity, quantityConfirmed }) => {
        if (manualQuantityRequest.current[key] !== request ||
            latestInputs.current.order !== order) return;
        manualQuantityPending.current.delete(key);
        if (!quantityConfirmed || quantity == null) {
          fail("수량을 1 이상의 정수로 입력하세요.", cell);
          return;
        }
        setModel((current) => {
          const next = structuredClone(current);
          const item = next.rows.find((r) => r.id === cell.recipientId)
            ?.items.find((i) => i.id === cell.itemId);
          if (!item) return current;
          item.quantity = quantity;
          item.quantityConfirmed = true;
          delete item.quantityApproval;
          item.issues = item.issues.filter((issue) => !issue.includes("수량"));
          return next;
        });
        setQuantityText((old) => ({ ...old, [key]: String(quantity) }));
        setPending(undefined);
        setError(undefined);
        requestAnimationFrame(() => focus(cell));
      }).catch((e) => {
        if (manualQuantityRequest.current[key] === request) {
          manualQuantityPending.current.delete(key);
          fail(e instanceof Error ? e.message : String(e), cell);
        }
      });
    };
    return (
      <div className="manual-quantity-cell">
        <div className="quantity-stepper">
          <button
            aria-label={label + " 감소"}
            disabled={!allowed(cell)}
            onClick={() => increment(-1)}
          >
            −
          </button>
          {input}
          <button
            aria-label={label + " 증가"}
            disabled={!allowed(cell)}
            onClick={() => increment(1)}
          >
            +
          </button>
        </div>
        {pending?.itemId === cell.itemId && (
          <button className="manual-cancel-product" onClick={cancelProduct}>
            상품 선택 취소
          </button>
        )}
      </div>
    );
  };
  const segments = [];
  let cursor = 0;
  for (const block of model.blocks) {
    segments.push((order.analysisRaw ?? order.raw).slice(cursor, block.start));
    segments.push(
      <button
        key={block.id}
        className={"manual-block" + (model.assignments[block.id] ? " assigned" : "")}
        aria-pressed={!!model.assignments[block.id]}
        aria-label={`${model.assignments[block.id] ? "배정됨" : "미배정"} ${block.text}`}
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => useBlock(block.id)}
      >
        {block.text}
      </button>,
    );
    cursor = block.end;
  }
  segments.push((order.analysisRaw ?? order.raw).slice(cursor));
  const unassignedCount = model.blocks.filter((block) => !model.assignments[block.id]).length;
  const uncommitted = model.rows.some((row) =>
    row.items.some(
      (item) =>
        entry[cellKey({ recipientId: row.id, itemId: item.id, field: "product" })] !== undefined,
    ),
  );
  const issues = orderIssues({ ...order, recipients: model.rows }).filter(
    (issue) => issue.severity === "ACTION",
  );
  const layer = completion || !!confirm || !!search;
  return (
    <section
      ref={root}
      className="manual-workspace"
      role="dialog"
      aria-modal="false"
      aria-label="수동 분류"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || layer) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          const previous = history.current.pop();
          if (previous) {
            restore(previous);
            if (active) focus(active);
          }
        }
      }}
    >
      <div className="manual-workspace-body" inert={layer}>
        <header className="manual-workspace-heading">
          <h2>수동 분류</h2>
          <button
            onClick={() =>
              setConfirm({
                title: "전체 초기화",
                message: "구성표와 배정을 초기화할까요? 최초 원문과 마스터는 보존됩니다.",
                execute: () => {
                  setModel({ ...model, rows: [newManualRecipient()], assignments: {} });
                  setCount("1");
                  setActive(undefined);
                  setPending(undefined);
                  setEntry({});
                  setQuantityText({});
                  history.current = [];
                  beforeProduct.current = undefined;
                  setError(undefined);
                },
              })
            }
          >
            초기화
          </button>
          <button onClick={closeDraft}>닫기 ×</button>
        </header>
        <div className="manual-classification">
          <div className="manual-status" role="status" data-error-cell={error?.key}>
            {pending ? (
              <>
                <span>선택한 상품의 수량을 확정하세요.</span>
              </>
            ) : (
              <div className="manual-help-or-error">
                {error?.message || <strong>미배정됨: {unassignedCount}개</strong>}
              </div>
            )}
            {pending && error && <small>{error.message}</small>}
          </div>
          <div className="manual-columns">
            <section className="manual-source">
              <header className="manual-source-heading">
                <h3>붙여넣은 내용</h3>
              </header>
              <pre>{segments}</pre>
            </section>
            <section className="manual-sheet">
              <div className="manual-sheet-heading">
                <h3>배송 정보 구성표</h3>
                <div className="manual-count">
                  <span>배송 건수</span>
                  <button
                    aria-label="배송 건수 감소"
                    disabled={!!pending || model.rows.length <= 1}
                    onClick={() => resize(model.rows.length - 1)}
                  >
                    −
                  </button>
                  <input
                    aria-label="배송 건수"
                    type="number"
                    min={1}
                    max={100}
                    value={count}
                    disabled={!!pending}
                    onChange={(event) => {
                      setCount(event.target.value);
                      if (event.target.value !== "") resize(Number(event.target.value));
                    }}
                    onBlur={() => setCount(String(model.rows.length))}
                  />
                  <button
                    aria-label="배송 건수 증가"
                    disabled={!!pending || model.rows.length >= 100}
                    onClick={() => resize(model.rows.length + 1)}
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="manual-grid-scroll">
                <table className="manual-delivery-table">
                  <colgroup>
                    <col className="manual-col-shipment" />
                    <col className="manual-col-name" />
                    <col className="manual-col-address" />
                    <col className="manual-col-mobile" />
                    <col className="manual-col-phone" />
                    <col className="manual-col-note" />
                  </colgroup>
                  {model.rows.map((row, index) => (
                    <tbody key={row.id} className="manual-shipment-group">
                      <tr className="manual-shipment-heading">
                        {["배송", "이름", "주소", "휴대폰", "전화", "배송 요청"].map((label) => (
                          <th key={label} scope="col">{label}</th>
                        ))}
                      </tr>
                      <tr className="manual-recipient-row">
                        <th scope="row">배송 {index + 1}</th>
                        {["name", "address", "mobile", "phone", "note"].map((field, n) => (
                          <td key={field}>
                            {textCell(
                              { recipientId: row.id, field },
                              `배송 ${index + 1} ${["이름", "주소", "휴대폰", "전화", "배송 요청"][n]}`,
                            )}
                          </td>
                        ))}
                      </tr>
                      <tr className="manual-product-section">
                        <td colSpan={6}>
                          <div className="manual-products-header">
                            <span>상품</span>
                            <span>수량</span>
                            <span>행 동작</span>
                          </div>
                          {row.items.map((item, itemIndex) => (
                            <div className="manual-product-row" key={item.id}>
                              <div className="manual-product-cell">
                                {textCell(
                                  { recipientId: row.id, itemId: item.id, field: "product" },
                                  `배송 ${index + 1} 상품 ${itemIndex + 1}`,
                                )}
                                <button
                                  disabled={!!pending}
                                  onClick={() => setSearch({
                                    recipientId: row.id,
                                    itemId: item.id,
                                    field: "product",
                                  })}
                                >
                                  검색
                                </button>
                              </div>
                              <div>
                                {textCell(
                                  { recipientId: row.id, itemId: item.id, field: "quantity" },
                                  `배송 ${index + 1} 수량 ${itemIndex + 1}`,
                                )}
                              </div>
                              <div className="manual-product-actions">
                                <button
                                  disabled={!!pending}
                                  onClick={() => removeProduct({
                                    recipientId: row.id,
                                    itemId: item.id,
                                    field: "product",
                                  })}
                                >
                                  상품 제거
                                </button>
                              </div>
                            </div>
                          ))}
                          <div className="manual-add-product">
                            <button disabled={!!pending} onClick={() => addProduct(row.id)}>
                              상품 추가
                            </button>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  ))}
                </table>
              </div>
            </section>
          </div>
          <footer className="manual-footer">
            <span>적용 후 확인 {issues.length}개 / 정식 접수는 주문 확인 완료</span>
            <button onClick={closeDraft}>닫기</button>
            <button
              className="primary"
              disabled={
                !!pending || !model.rows.length || uncommitted || !!pendingManualQuantity(model)
              }
              onClick={() => setCompletion(true)}
            >
              초안에 적용
            </button>
          </footer>
        </div>
      </div>
      {search && (
        <ProductSearchDialog
          surface={ManualPrompt}
          state={state}
          clientId={order.clientId}
          onClose={() => {
            setSearch(undefined);
            if (active) focus(active);
          }}
          onChoose={(product) => selectProduct(search, product.name, product)}
        />
      )}
      {confirm && (
        <ManualPrompt title={confirm.title} onClose={() => setConfirm(undefined)}>
          <p>{confirm.message}</p>
          <div className="manual-confirm-actions">
            <button
              className="primary"
              onClick={() => {
                confirm.execute();
                setConfirm(undefined);
              }}
            >
              확인
            </button>
            <button onClick={() => setConfirm(undefined)}>취소</button>
          </div>
        </ManualPrompt>
      )}
      {completion && (
        <ManualPrompt title="수동 분류 완료" onClose={() => setCompletion(false)}>
          <p>수동 분류 결과를 어떻게 처리할까요?</p>
          <div className="manual-completion-actions">
            <div className="manual-completion-ai">
              <button disabled>AI 자동분류 개선</button>
            </div>
            <button
              className="primary"
              data-autofocus
              disabled={applying.current}
              onClick={() => {
                if (applying.current) return;
                applying.current = true;
                const submittedOrder = order, submittedModel = model;
                void businessCoreCall<{ order: Order }>(
                  "rules", "apply_manual_classification", {
                    action: "apply_manual", order: submittedOrder, model: submittedModel,
                  },
                ).then(({ order: prepared }) => {
                  if (latestInputs.current.order !== submittedOrder ||
                      latestInputs.current.model !== submittedModel) {
                    throw Error("수동 분류 내용이 변경되었습니다. 최신 내용을 확인하고 다시 적용하세요.");
                  }
                  onApply(prepared);
                  onClose();
                }).catch((e) => {
                  setCompletion(false);
                  fail(e instanceof Error ? e.message : String(e));
                }).finally(() => { applying.current = false; });
              }}
            >
              피드백 없이 진행
            </button>
            <button onClick={() => setCompletion(false)}>취소</button>
          </div>
        </ManualPrompt>
      )}
    </section>
  );
}
