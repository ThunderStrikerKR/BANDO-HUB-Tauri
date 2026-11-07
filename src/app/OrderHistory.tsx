import { dispatchState, trackingMessage } from "../factory-replies";
import { DateNavigator } from "./DateNavigator";
import { useMemo, useState } from "react";
import { won } from "../domain";
import { internalModel } from "../matching";
import type { Order, State } from "../types";
import { Field } from "../ui";
import { EmptyState, PageHeading } from "../ui/PageHeading";
import { orderHistory } from "./order-history";
import type { NoticeSink } from "../shared/notices";
export function OrderHistory({
  state,
  query,
  onQuery,
  date,
  onDate,
  onOpen,
}: {
  state: State;
  query: string;
  onQuery: (query: string) => void;
  date: string;
  onDate: (date: string) => void;
  onOpen: (order: Order) => unknown;
  onNotice: NoticeSink;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const rows = useMemo(() => orderHistory(state, query, date), [state, query, date]);
  return (
    <>
      <PageHeading
        title="주문 내역"
        actions={
          <Field label="접수 날짜">
            <DateNavigator
              label="접수 날짜"
              value={date}
              onChange={onDate}
              onClear={() => onDate("")}
            />
          </Field>
        }
      />
      <section className="card">
        <div className="manager-filters">
          <input
            aria-label="주문 검색"
            placeholder="거래처 / 주문 내용 검색"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
          <small className="result-count">{rows.length}건</small>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>접수일</th>
                <th>거래처</th>
                <th>배송 건 / 상품</th>
                <th>관리 상태</th>
                <th>청구 합계</th>
                <th>처리</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.order.id}>
                  <td>
                    {new Date(row.order.confirmedAt ?? row.order.createdAt).toLocaleDateString(
                      "ko-KR",
                      { timeZone: "Asia/Seoul" },
                    )}
                  </td>
                  <td>{row.client?.name ?? "과거 거래처"}</td>
                  <td>
                    <button
                      aria-expanded={expanded.includes(row.order.id)}
                      onClick={() =>
                        setExpanded(
                          expanded.includes(row.order.id)
                            ? expanded.filter((id) => id !== row.order.id)
                            : [...expanded, row.order.id],
                        )
                      }
                    >
                      {row.recipients.map((recipient) => recipient.name).join(", ")}
                    </button>
                    {expanded.includes(row.order.id) &&
                      row.recipients.map((r) => (
                        <div key={r.id}>
                          {r.name} / {r.address}
                          {state.workflow?.shipments
                            .filter((s) => s.orderId === row.order.id && s.recipientId === r.id)
                            .map((ship) => (
                              <p key={ship.id}>
                                송장 {Object.values(ship.tracking ?? {}).join(" / ") || "확인 필요"}{" "}
 / 실제 운임{" "}
                                {Object.values(ship.actualFreight ?? {})
                                  .filter((v) => v !== null)
                                  .map((v) => won(v!))
                                  .join(" / ") || "확인 필요"}
                              </p>
                            ))}
                        </div>
                      ))}
                    {expanded.includes(row.order.id) && (
                      <small>
                        상품대금 {won(row.billing.subtotal)} / 고객 청구 배송비 {won(row.billing.shipping)}
                        / 부가세 {won(row.billing.vat)}
                      </small>
                    )}
                    <small>
                      {row.recipients
                        .flatMap((recipient) =>
                          recipient.items.map(
                            (item) => internalModel(item.name) + " × " + item.quantity,
                          ),
                        )
                        .join(" / ")}
                    </small>
                  </td>
                  <td>
                    {row.status}
                    <small>{dispatchState(state, row.order.id)}</small>
                  </td>
                  <td className="money-value">
                    {won(row.total)}
                    {row.order.orderType === "RETAIL" && (
                      <small>소매 주문 / 결제 증빙 별도 확인</small>
                    )}
                    {row.order.paid && !state.workflow?.payments.some((p) =>
                      p.allocations.some((a) => row.shipmentIds.includes(a.shipmentId))) && (
                      <small>기존 입금 표시 / 실제 입금 기록 미확인</small>
                    )}
                  </td>
                  <td>
                    <button
                      disabled={!trackingMessage(state, row.order.id)}
                      onClick={() => void window.bando!.copy(trackingMessage(state, row.order.id))}
                    >
                      운송장 복사
                    </button>
                    <button disabled={row.deleted} onClick={() => void onOpen(row.order)}>
                      주문 열기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <EmptyState
            title={query || date ? "조건에 맞는 주문이 없습니다." : "저장된 주문이 없습니다."}
            description={query || date ? "날짜나 검색어를 바꾸어 확인하세요." : undefined}
          />
        )}
      </section>
    </>
  );
}
