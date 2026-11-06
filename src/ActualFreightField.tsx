import { useEffect, useState } from "react";
import { actualFreightOf, recordActualFreight } from "./actual-freight";
import { Field, MoneyInput } from "./ui";
import type { Origin, State } from "./types";
export function ActualFreightField({
  state,
  shipmentId,
  origin,
  onSave,
}: {
  state: State;
  shipmentId: string;
  origin: Origin;
  onSave: (s: State) => Promise<void>;
}) {
  const ship = state.workflow!.shipments.find((s) => s.id === shipmentId)!,
    row = state.orders
      .find((o) => o.id === ship.orderId)!
      .recipients.find((r) => r.id === ship.recipientId)!,
    saved = actualFreightOf(ship, row, origin);
  const [value, setValue] = useState(saved),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => setValue(saved), [saved, shipmentId, origin]);
  return (
    <div className="actual-freight-field">
      <Field label={(origin === "FACTORY" ? "공장" : "매장") + " 실제 출고 운임"}>
        <MoneyInput value={value} onChange={setValue} />
      </Field>
      <button
        disabled={busy || value === saved}
        onClick={async () => {
          setBusy(true);
          try {
            await onSave(recordActualFreight(state, shipmentId, origin, value));
            setError("");
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        실제 운임 저장
      </button>
      <small role="status" className="form-error">
        {error}
      </small>
    </div>
  );
}
