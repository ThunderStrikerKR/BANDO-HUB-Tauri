import { useState } from "react";
import { MoneyInput } from "./ui/MoneyInput";
import type { ShippingRule } from "./types";

export function ShippingFeeRanges({
  rule, onChange,
}: {
  rule: ShippingRule;
  onChange: (value: ShippingRule) => void;
}) {
  const [visibleCounts, setVisibleCounts] = useState<number[]>(() =>
    Object.entries(rule.fees)
      .filter(([quantity, amount]) => /^[1-6]$/.test(quantity) && typeof amount === "number")
      .map(([quantity]) => Number(quantity))
      .sort((a, b) => a - b),
  );
  const [nextCount, setNextCount] = useState("");
  const available = Array.from({ length: 6 }, (_, i) => i + 1)
    .filter((quantity) =>
      !visibleCounts.includes(quantity) &&
      rule.maxBundle !== null && quantity <= rule.maxBundle,
    );
  const updateFee = (count: number, amount: number | null) => {
    onChange({ ...rule, fees: { ...rule.fees, [String(count)]: amount } });
  };
  const addInterval = () => {
    const quantity = Number(nextCount);
    if (!available.includes(quantity)) return;
    setVisibleCounts((previous) => [...previous, quantity].sort((a, b) => a - b));
    setNextCount("");
    updateFee(quantity, null);
  };
  const removeInterval = (quantity: number) => {
    setVisibleCounts((previous) => previous.filter((item) => item !== quantity));
    const fees = { ...rule.fees };
    delete fees[String(quantity)];
    onChange({ ...rule, fees });
  };
  return (
    <section className="shipping-fee-ranges" aria-label="수량별 운임 구간">
      <div className="shipping-fee-heading">
        <strong>수량별 운임</strong>
        <span>확인한 묶음 수량의 운임만 추가하세요.</span>
      </div>
      <div className="shipping-fee-entry-list">
        {visibleCounts.map((count) => (
          <div className="shipping-fee-entry" key={count}>
            <label htmlFor={"shipping-fee-" + count}>{count}개 묶음</label>
            <MoneyInput id={"shipping-fee-" + count}
              label={count + "개 묶음 운임"}
              value={rule.fees[String(count)] ?? null}
              onChange={(value) => updateFee(count, value)}
            />
            <button type="button" onClick={() => removeInterval(count)}
              aria-label={count + "개 운임 구간 삭제"}>삭제</button>
            {rule.maxBundle !== null && count > rule.maxBundle && (
              <small className="warnings">최대 묶음 수량 초과</small>
            )}
          </div>
        ))}
      </div>
      {available.length > 0 && (
        <div className="shipping-fee-add">
          <select aria-label="추가할 묶음 수량" value={nextCount}
            onChange={(event) => setNextCount(event.target.value)}>
            <option value="">묶음 수량 선택</option>
            {available.map((count) => <option key={count} value={count}>{count}개</option>)}
          </select>
          <button type="button" disabled={!nextCount} onClick={addInterval}>운임 구간 추가</button>
        </div>
      )}
      {!visibleCounts.length && <p className="muted">등록된 수량별 운임이 없습니다.</p>}
    </section>
  );
}
