import { useEffect, useRef, useState } from "react";
import { won } from "../domain";
import type { NoticeSink } from "../shared/notices";
import type { State } from "../types";

import { EmptyState, PageHeading } from "../ui/PageHeading";
import { ManagementTable } from "../ui/ManagementTable";
import { DateNavigator } from "./DateNavigator";
import { HelpTooltip } from "../ui/HelpTooltip";
import type { HistoryRow } from "./settlement-report";
import type { DailySettlementReport } from "./settlement-report";
import { businessCoreCall } from "../tauri-bridge";

const cash = (value: number | null) => value === null ? "확인 필요" : won(value);
export function DailySettlement({
  state, date, onDate,
}: {
  state: State;
  date: string;
  onDate: (date: string) => void;
  onNotice: NoticeSink;
}) {
  const requestId = useRef(0);
  const [loaded, setLoaded] = useState<{ state: State; date: string; report: DailySettlementReport } | null>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    const id = ++requestId.current;
    setLoaded(null);
    setFailure("");
    void businessCoreCall<HistoryRow[]>("rules", "list_order_history", {
      state, query: "", date,
    }).then((historyRows) => {
      if (requestId.current !== id) return null;
      return businessCoreCall<DailySettlementReport>("output", "prepare_settlement", {
        state, date, historyRows,
      });
    }).then((report) => {
      if (report && requestId.current === id) setLoaded({ state, date, report });
    }).catch((error: unknown) => {
      if (requestId.current === id) setFailure(String(error));
    });
    return () => { if (requestId.current === id) requestId.current++; };
  }, [state, date]);
  const report = loaded?.state === state && loaded.date === date ? loaded.report : null;
  return (
    <section className="daily-settlement">
      <PageHeading title="일일 결산" />
      <div className="management-search-toolbar management-date-toolbar">
        <span className="management-toolbar-label">결산 날짜</span>
        <DateNavigator label="결산 날짜" value={date} onChange={onDate}/>
      </div>
      {failure && <section className="card" role="alert">{failure}</section>}
      {!report && !failure && <section className="card" role="status">결산 자료 확인 중</section>}
      {report && <>
      <section className="card">
        <div className="section-title">
          <h2 className="settings-help-heading">{date} / 일일 결산 조회 <HelpTooltip title="일일 결산" purpose="선택한 날짜에 접수한 주문의 청구 금액과 실제 계좌 입금 내역을 따로 확인합니다." when="하루 주문 금액과 실제 들어온 돈을 점검할 때 사용합니다." steps={["조회할 날짜를 선택합니다.", "접수 주문과 청구 합계를 확인합니다.", "아래 실제 입금 내역과 비교합니다.", "미확정 항목이나 확인할 내용이 있는지 점검합니다."]} result="해당 날짜의 주문과 입금 상태를 확인할 수 있습니다." caution="청구 금액은 주문 접수 날짜, 실제 입금액은 은행 입금 날짜를 기준으로 집계하므로 두 금액을 단순히 더하지 않습니다." /></h2>
        </div>

        <div className="settlement-kpis">
          <div><small>접수 주문</small><strong>{report.orderRows.length}건</strong></div>
          <div><small>청구 합계 확인분</small><strong>{won(report.billedKnown)}</strong></div>
          <div><small>실제 계좌 입금</small><strong>{won(report.paidCash)}</strong></div>
          <div><small>미확정 청구 주문</small><strong>{report.billedUnknown}건</strong></div>
        </div>
        <h3>해당 날짜 접수 주문 / 청구 내역</h3>
        <div className="settlement-breakdown">
          <span>상품대금 확인분 <b>{won(report.productKnown)}</b></span>
          <span>고객 청구 배송비 확인분 <b>{won(report.shippingKnown)}</b></span>
          <span>부가세 확인분 <b>{won(report.vatKnown)}</b></span>
          <span>후불 주문 청구액 확인분 <b>{won(report.postpaidKnown)}</b></span>
          <span>현재 미수 확인분 <b>{won(report.outstandingKnown)}</b></span>
          <span>현재 공장 운임 확인분 <b>{won(report.actualFreightKnown)}</b></span>
        </div>
        <div className="settlement-review-summary">
          <span>미수 미확정 {report.outstandingUnknown}건</span>
          <span>실제 운임 미확정 {report.freightUnknown}건</span>
          <HelpTooltip title="미수금과 실제 운임" purpose="아직 받지 못한 돈과 실제 배송비 중 확인되지 않은 항목을 찾아 점검합니다." when="주문이나 운임이 확정되지 않아 금액을 확인해야 할 때 사용합니다." steps={["미수 미확정 건수와 실제 운임 미확정 건수를 확인합니다.", "아래 주문 내역에서 미확정 항목을 찾습니다.", "확인된 내용을 해당 주문에 반영합니다."]} result="현재 저장된 주문과 배송 자료를 기준으로 미수금과 실제 운임을 확인할 수 있습니다." caution="현재 미수금과 실제 운임은 선택 날짜에 실제로 입금되거나 지급된 돈과 같지 않을 수 있습니다." />
        </div>
        <div className="table-scroll settlement-scroll">
          <ManagementTable>
            <thead>
              <tr><th>거래처</th><th>결제 방식</th><th>상품대금</th>
                <th>청구 배송비</th><th>부가세</th><th>청구 합계</th>
                <th>실제 입금 배분 누계</th><th>현재 미수</th></tr>
            </thead>
            <tbody>
              {report.orderRows.map((order) => (
                <tr key={order.orderId}>
                  <td>{order.clientName}<small>{order.status}</small></td>
                  <td>{order.paymentTerms}</td>
                  <td className="money-value">{cash(order.subtotal)}</td>
                  <td className="money-value">{cash(order.shippingCharge)}</td>
                  <td className="money-value">{cash(order.vat)}</td>
                  <td className="money-value">{cash(order.total)}</td>
                  <td className="money-value">{won(order.paidAllocated)}</td>
                  <td className="money-value">{cash(order.outstanding)}</td>
                </tr>
              ))}
            </tbody>
          </ManagementTable>
        </div>
        {!report.orderRows.length && <EmptyState compact title="해당 날짜에 접수한 주문이 없습니다." />}
      </section>
      <section className="card">
        <h3>실제 입금 내역 / 입금 일시 기준</h3>
        <div className="settlement-breakdown">
          <span>실제 입금 합계 <b>{won(report.paidCash)}</b></span>
          <span>배송 건 배분액 <b>{won(report.allocatedCash)}</b></span>
          <span>미배분 입금액 <b>{won(report.unallocatedCash)}</b></span>
        </div>
        <div className="table-scroll settlement-scroll">
          <ManagementTable>
            <thead><tr><th>입금 일시</th><th>거래처</th><th>계좌</th>
              <th>실제 입금액</th><th>배분액</th><th>미배분</th><th>메모</th></tr></thead>
            <tbody>
              {report.paymentRows.map((p) => (
                <tr key={p.id}>
                  <td>{new Date(p.paidAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</td>
                  <td>{p.dealer}</td><td>{p.account}</td>
                  <td className="money-value">{won(p.amount)}</td>
                  <td className="money-value">{won(p.allocated)}</td>
                  <td className="money-value">{won(p.unallocated)}</td>
                  <td>{p.memo}</td>
                </tr>
              ))}
            </tbody>
          </ManagementTable>
        </div>
        {!report.paymentRows.length && <EmptyState compact title="해당 날짜의 실제 입금 기록이 없습니다." />}
      </section>
      {report.warnings.length > 0 && (
        <section className="card">
          <h3>결산 검토 사항</h3>
          <ul>{report.warnings.map((notice) => <li key={notice}>{notice}</li>)}</ul>
        </section>
      )}
      </>}
    </section>
  );
}
