import { useEffect, useRef, useState } from "react";
import { actualFreightOf, recordActualFreight } from "./actual-freight";
import { usePageLeaveGuard } from "./shared/page-leave";
import { Field, MoneyInput } from "./ui";
import type { Origin, Price, State } from "./types";
export function ActualFreightField({
  state,
  shipmentId,
  origin,
  onSave,
  draftValue,
  onDraftChange,
  onDraftSaved,
}: {
  state: State;
  shipmentId: string;
  origin: Origin;
  onSave: (s: State) => Promise<void>;
  draftValue?: Price;
  onDraftChange?: (value: Price) => void;
  onDraftSaved?: () => void;
}) {
  const ship = state.workflow!.shipments.find((s) => s.id === shipmentId)!,
    row = state.orders
      .find((o) => o.id === ship.orderId)!
      .recipients.find((r) => r.id === ship.recipientId)!,
    saved = actualFreightOf(ship, row, origin);
  const [localValue, setLocalValue] = useState(saved),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const previousSaved = useRef(saved);
  const controlled = !!onDraftChange;
  const value = controlled ? (draftValue === undefined ? saved : draftValue) : localValue;
  const change = (next: Price) => controlled ? onDraftChange?.(next) : setLocalValue(next);
  // Refresh untouched fields but never overwrite a user's pending amount.
  useEffect(() => {
    if (!controlled) setLocalValue((current) => current === previousSaved.current ? saved : current);
    previousSaved.current = saved;
  }, [saved, shipmentId, origin, controlled]);
  const save = async (): Promise<boolean> => {
    if (busy) return false;
    if (value === saved) return true;
    setBusy(true);
    try {
      await onSave(recordActualFreight(state, shipmentId, origin, value));
      onDraftSaved?.();
      setError("");
      return true;
    } catch (cause) {
      setError(String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  usePageLeaveGuard({
    label: "실제 출고 운임",
    hasChanges: () => !controlled && value !== saved,
    busy: () => busy,
    save,
    discard: () => setLocalValue(saved),
  });
  return (
    <div className="actual-freight-field">
      <Field label={(origin === "FACTORY" ? "공장" : "매장") + " 실제 출고 운임"}>
        <MoneyInput value={value} onChange={change} />
      </Field>
      <button disabled={busy || value === saved} onClick={() => void save()}>
        실제 운임 저장
      </button>
      <small role="status" className="form-error">{error}</small>
    </div>
  );
}
