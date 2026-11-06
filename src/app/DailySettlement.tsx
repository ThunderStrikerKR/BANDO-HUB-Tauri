import { useMemo } from "react";
import { won } from "../domain";
import { useAsyncTask } from "../shared/useAsyncTask";
import type { NoticeSink } from "../shared/notices";
import type { State } from "../types";
import { Field } from "../ui";
import { EmptyState, PageHeading } from "../ui/PageHeading";
import { DateNavigator } from "./DateNavigator";
import { orderHistory } from "./order-history";
import { exportDailySettlementWorkbook } from "./report-workbook";
import { dailySettlement } from "./settlement-report";

const cash = (value: number | null) => value === null ? "확인 필요" : won(value);
export function DailySettlement({
  state, date, onDate, onNotice,
}: {
  state: State;
  date: string;
  onDate: (date: string) => void;
  onNotice: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const report = useMemo(() => dailySettlement(state, date, orderHistory(state, "", date)),
    [state, date]);
  const download = () => void run(async () => {
    const api = window.bando;
    if (!api?.saveSettlementWorkbook) throw Error("일일 결산 Excel 저장 기능이 연결되지 않았습니다.");
    const latest = await api.load();
    if ((latest.revision ?? 0) !== report.revision) {
      throw Error("조회 중 데이터가 변경되었습니다. 최신 결산을 확인한 뒤 다시 다운로드하세요.");
    }
    const fresh = dailySettlement(latest, date, orderHistory(latest, "", date));
    const bytes = await exportDailySettlementWorkbook({
      date, revision: latest.revision ?? 0, report: fresh,
    });
    const location = await api.saveSettlementWorkbook(bytes);
    if (location) onNotice("일일 결산 Excel을 저장했습니다: " + location, "success");
  });
  return (
    <section className="daily-settlement">
      <PageHeading title="일일 결산"
        actions={<Field label="결산 날짜">
          <DateNavigator label="결산 날짜" value={date} onChange={onDate}/>
        </Field>}
      />
      <section className="card">
        <div className="section-title">
          <h2>{date} / 일일 결산 조회</h2>
          <button type="button" disabled={busy} onClick={download}>현재 결산 Excel 다운로드</button>
        </div>
        <p className="muted">
          청구 금액은 접수 확정일, 실제 입금액은 은행 입금 일시를 기준으로 조회합니다.
          청구액과 입금액은 발생 날짜가 다르므로 서로 합산하지 않습니다.
        </p>
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
        <p className="muted">
          미수 및 실제 운임은 현재 저장된 자료 기준입니다.
          이 날짜에 실제로 회수하거나 지급한 금액과 동일하지 않습니다.
          미수 미확정 {report.outstandingUnknown}건, 실제 운임 미확정 {report.freightUnknown}건입니다.
        </p>
        <div className="table-scroll settlement-scroll">
          <table>
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
          </table>
        </div>
        {!report.orderRows.length && <EmptyState title="해당 날짜에 접수한 주문이 없습니다." />}
      </section>
      <section className="card">
        <h3>실제 입금 내역 / 입금 일시 기준</h3>
        <div className="settlement-breakdown">
          <span>실제 입금 합계 <b>{won(report.paidCash)}</b></span>
          <span>배송 건 배분액 <b>{won(report.allocatedCash)}</b></span>
          <span>미배분 입금액 <b>{won(report.unallocatedCash)}</b></span>
        </div>
        <div className="table-scroll settlement-scroll">
          <table>
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
          </table>
        </div>
        {!report.paymentRows.length && <EmptyState title="해당 날짜의 실제 입금 기록이 없습니다." />}
      </section>
      {report.warnings.length > 0 && (
        <section className="card">
          <h3>결산 검토 사항</h3>
          <ul>{report.warnings.map((notice) => <li key={notice}>{notice}</li>)}</ul>
        </section>
      )}
    </section>
  );
}
