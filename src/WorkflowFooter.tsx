import { recommendShipping } from "./shipping";
import type { Origin, Price, State } from "./types";
import { shipmentContext, shipmentFreightCode, shipmentVat } from "./workflow";
import type { WorkflowShipment } from "./workflow-types";
type FreightProps = {
  state: State;
  shipment: WorkflowShipment;
  activeKey?: string;
  onFreight: (origin: Origin, value: Price) => void;
  onCode: (v: "010" | "020") => void;
};
export function WorkflowFreightRows({
  state,
  shipment,
  onFreight,
  onCode,
  activeKey,
}: FreightProps) {
  const { order, recipient, client } = shipmentContext(state, shipment),
    rec = recommendShipping({ ...order, recipients: [recipient] }, state),
    disabled = shipment.transferred,
    collect = shipmentFreightCode(order, recipient) === "020";
  return (
    <>
      {rec.bundles.map((b, index) => {
        const value = collect || client.shippingFeeExcluded ? 0 : shipment.charges[b.origin];
        return (
          <tr
            key={b.origin}
            data-freight-origin={b.origin}
            data-link-key={recipient.id + ":freight"}
            className={
              "freight-item-row freight-input-area" +
              (activeKey === recipient.id + ":freight" ? " freight-needs-focus" : "")
            }
          >
            <td colSpan={3}>
              <div className="freight-line">
                <b className="freight-name">
                  {rec.bundles.length === 1
                    ? "운임"
                    : b.origin === "FACTORY"
                      ? "공장 운임"
                      : "매장 운임"}
                </b>
                <div className="freight-amount-code">
                  <div className="freight-money">
                  <input
                    aria-label={`${recipient.name} ${b.origin === "FACTORY" ? "공장" : "매장"} 적용 운임`}
                    inputMode="numeric"
                    disabled={disabled || collect || client.shippingFeeExcluded}
                    value={
                      value === null || value === undefined ? "" : value.toLocaleString("ko-KR")
                    }
                    placeholder="—"
                    onChange={(e) => {
                      const input = e.currentTarget,
                        raw = input.value.replaceAll(",", "");
                      if (!/^\d*$/.test(raw) || (raw !== "" && !Number.isSafeInteger(Number(raw))))
                        return;
                      const digitsBefore = input.value
                        .slice(0, input.selectionStart ?? input.value.length)
                        .replace(/\D/g, "").length;
                      onFreight(b.origin, raw === "" ? null : Number(raw));
                      requestAnimationFrame(() => {
                        if (!input.isConnected || document.activeElement !== input) return;
                        let at = 0,
                          count = 0;
                        while (at < input.value.length && count < digitsBefore) {
                          if (/\d/.test(input.value[at])) count++;
                          at++;
                        }
                        input.setSelectionRange(at, at);
                      });
                    }}
                  />
                    <span>원</span>
                  </div>
                  <span className="freight-payment-code">
                    <span aria-hidden="true">(</span>
                    <select
                      aria-label={index ? "운임구분 " + b.origin : "운임구분"}
                      value={shipmentFreightCode(order, recipient)}
                      disabled={disabled}
                      onChange={(e) => onCode(e.target.value as "010" | "020")}
                    >
                      <option value="010">선불</option>
                      <option value="020">착불</option>
                    </select>
                    <span aria-hidden="true">)</span>
                  </span>
                </div>
                <button
                  className="freight-inquiry"
                  aria-hidden={b.origin !== "FACTORY"}
                  style={{ visibility: b.origin === "FACTORY" ? "visible" : "hidden" }}
                  disabled
                  title="공장 문의 연동 준비 중"
                >
                  공장에 운임 문의
                </button>
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}
export function WorkflowFooter({
  state,
  shipment,
  onVat,
}: {
  state: State;
  shipment: WorkflowShipment;
  groupId: string;
  onVat: (v: boolean | undefined) => void;
}) {
  const { order, recipient } = shipmentContext(state, shipment),
    disabled = shipment.transferred;
  return (
    <section className="workflow-footer order-settings" aria-label="발주 설정">
      <div className="shipment-vat">
        <label className="check">
          <input
            type="checkbox"
            aria-label="배송 건 부가세"
            disabled={disabled}
            checked={shipmentVat(order, recipient)}
            onChange={(e) => onVat(e.target.checked)}
          />{" "}
          부가세 10% 추가
        </label>
      </div>
    </section>
  );
}
