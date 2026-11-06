import { FactoryReplyHistory } from "./FactoryReplyHistory";
import { ActualFreightField } from "./ActualFreightField";
import { useState } from "react";
import { markFactoryDelivered, reopenUnsentExport } from "./corrections";
import { won } from "./domain";
import { internalModel } from "./matching";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { State } from "./types";
import { markStoreSent, restoreShipment, shipmentContext } from "./workflow";
export function WorkflowQueue({
  state,
  onSave,
  onRefresh,
  onOpen,
  onNotice,
  onSettings,
}: {
  state: State;
  onSave: (s: State) => Promise<void>;
  onRefresh: () => Promise<void>;
  onOpen: (id: string) => void;
  onNotice: NoticeSink;
  onSettings?: () => void;
}) {
  const { busy, run } = useAsyncTask(onNotice),
    [scope, setScope] = useState<"FACTORY" | "STORE" | "HISTORY">("FACTORY"),
    [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState("");
  const rows = (state.workflow?.queue ?? [])
    .filter((q) => q.status === "QUEUED" && q.origin === scope)
    .filter((q) => {
      const ship = state.workflow!.shipments.find((s) => s.id === q.shipmentId)!;
      const ctx = shipmentContext(state, ship);
      return (
        ctx.client.name +
        ctx.recipient.name +
        ctx.recipient.items.map((i) => i.name).join(" ")
      ).includes(query);
    });
  const legacy =
    scope === "FACTORY"
      ? state.queue
          .filter(
            (id) =>
              !state.workflow?.queue.some(
                (q) => state.workflow?.shipments.find((s) => s.id === q.shipmentId)?.orderId === id,
              ),
          )
          .map((id) => state.orders.find((o) => o.id === id)!)
          .filter((o) => o && (o.raw + o.clientSnapshot?.name).includes(query))
      : [];
  const visible = [...rows.map((q) => q.id), ...legacy.map((o) => o.id)],
    chosen = selected.filter((id) => visible.includes(id)),
    all = !!visible.length && chosen.length === visible.length;
  const companyMissing = chosen.some((id) => {
    const q = state.workflow?.queue.find((row) => row.id === id),
      ship = state.workflow?.shipments.find((s) => s.id === q?.shipmentId),
      order = state.orders.find((o) => o.id === ship?.orderId),
      sender = q?.snapshot?.sender;
    return (
      ["DEALER", "RETAIL"].includes(order?.orderType ?? "") &&
      (!sender?.name || !sender.address || !(sender.phone || sender.mobile))
    );
  });
  return (
    <section className="excel-workspace">
      <h1>엑셀 / 매장 발송 관리</h1>
      <div className="workflow-queue-tabs">
        {(["FACTORY", "STORE", "HISTORY"] as const).map((value, index) => (
          <button
            key={value}
            aria-pressed={scope === value}
            onClick={() => {
              setScope(value);
              setSelected([]);
              setQuery("");
            }}
          >
            {["공장 엑셀 대기", "매장 발송 대기", "엑셀 작성 이력"][index]}
          </button>
        ))}
      </div>
      <input
        aria-label="엑셀 목록 검색"
        value={query}
        placeholder="거래처 / 수취인 / 상품 검색"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="excel-table-scroll">
        {scope === "HISTORY" ? (
          <table>
            <thead>
              <tr>
                <th>작성 날짜</th>
                <th>작성 건수</th>
                <th>파일 / 주문</th>
                <th>조회</th>
              </tr>
            </thead>
            <tbody>
              {state.exports
                .filter(
                  (e) =>
                    e.filename.includes(query) ||
                    e.orderIds.some((id) =>
                      state.orders.find((o) => o.id === id)?.clientSnapshot?.name?.includes(query),
                    ),
                )
                .slice()
                .reverse()
                .map((e) => (
                  <tr key={e.id}>
                    <td>{new Date(e.at).toLocaleString("ko-KR")}</td>
                    <td>{e.queueEntryIds?.length ?? e.orderIds.length}건</td>
                    <td>
                      {e.filename}
                      <small>
                        {e.orderIds
                          .map(
                            (id) =>
                              state.orders.find((o) => o.id === id)?.clientSnapshot?.name ||
                              "반도스탠드",
                          )
                          .join(" / ")}
                      </small>
                    </td>
                    <td>
                      <button onClick={() => void run(() => window.bando!.openExportFile(e.id))}>
                        파일 열기
                      </button>
                      <details>
                        <summary>관련 주문</summary>
                        {e.orderIds.map((id) => (
                          <button key={id} onClick={() => onOpen(id)}>
                            주문 상세 보기
                          </button>
                        ))}
                        {e.queueEntryIds
                          ?.map((id) => state.workflow?.queue.find((q) => q.id === id))
                          .filter((q) => q?.fileOnly)
                          .map((q) => (
                            <div key={q!.id}>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void run(() => onSave(markFactoryDelivered(state, q!.shipmentId)))
                                }
                              >
                                실제 공장 전달 확인
                              </button>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void run(() => onSave(reopenUnsentExport(state, q!.shipmentId)))
                                }
                              >
                                전달 전 정정 / 재출력
                              </button>
                            </div>
                          ))}
                      </details>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="현재 결과 전체 선택"
                    checked={all}
                    ref={(el) => {
                      if (el) el.indeterminate = chosen.length > 0 && !all;
                    }}
                    disabled={!visible.length}
                    onChange={(e) => setSelected(e.target.checked ? visible : [])}
                  />
                </th>
                <th>거래처 / 발주</th>
                <th>수취인 / 배송 품목</th>
                <th>금액</th>
                <th>처리</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => {
                const ship = state.workflow!.shipments.find((s) => s.id === q.shipmentId)!,
                  ctx = shipmentContext(state, ship),
                  row = q.snapshot?.recipient ?? ctx.recipient;
                return (
                  <tr key={q.id} data-queue-id={q.id}>
                    <td>
                      <input
                        aria-label={"엑셀 선택 " + row.name}
                        type="checkbox"
                        checked={chosen.includes(q.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, q.id]
                              : selected.filter((id) => id !== q.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      {ctx.order.orderType === "RETAIL"
                        ? "반도스탠드"
                        : ctx.client.displayName || ctx.client.name}
                      <small>
                        {ctx.order.orderType === "RETAIL"
                          ? "소매 주문"
                          : "발주 " +
                            state.workflow!.sources.find((s) => s.id === ship.sourceId)?.number}
                      </small>
                    </td>
                    <td>
                      {row.name}
                      <small>
                        {row.items
                          .map((i) => internalModel(i.name) + " × " + i.quantity)
                          .join(" / ")}
                      </small>
                    </td>
                    <td>
                      {ctx.order.orderType === "RETAIL"
                        ? "결제 완료 주문"
                        : won(q.snapshot?.total ?? null)}
                    </td>
                    <td>
                      <button onClick={() => onOpen(ship.orderId)}>상세 보기</button>
                      <details>
                        <summary>관리</summary>
                        <ActualFreightField
                          state={state}
                          shipmentId={ship.id}
                          origin={q.origin}
                          onSave={onSave}
                        />
                        <button
                          disabled={busy || ctx.order.orderType === "RETAIL"}
                          onClick={() => void run(() => onSave(restoreShipment(state, ship.id)))}
                        >
                          이관 복구
                        </button>
                        {q.origin === "STORE" && (
                          <button
                            disabled={busy}
                            onClick={() => void run(() => onSave(markStoreSent(state, q.id)))}
                          >
                            매장 발송 확인
                          </button>
                        )}
                      </details>
                    </td>
                  </tr>
                );
              })}
              {legacy.map((o) => (
                <tr key={o.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={"이전 주문 선택 " + o.id}
                      checked={chosen.includes(o.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, o.id]
                            : selected.filter((id) => id !== o.id),
                        )
                      }
                    />
                  </td>
                  <td>{o.clientSnapshot?.name}</td>
                  <td>{o.recipients.map((r) => r.name).join(", ")}</td>
                  <td>기존 확정 금액 유지</td>
                  <td>
                    <button onClick={() => onOpen(o.id)}>주문 열기</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {scope === "HISTORY" && (
          <FactoryReplyHistory state={state} query={query} onOpen={onOpen} onNotice={onNotice} />
        )}
      </div>
      <footer className="excel-fixed-footer">
        <button onClick={() => void run(() => window.bando!.openExcelDirectory())}>
          폴더 열기
        </button>
        {companyMissing && onSettings && <button onClick={onSettings}>반도스탠드 정보 설정</button>}
        {scope !== "HISTORY" && (
          <button
            className="primary"
            disabled={busy || !chosen.length}
            onClick={() =>
              void run(async () => {
                const result = await window.bando!.exportExcel(chosen);
                if (!result.cancelled) {
                  await onRefresh();
                  setSelected([]);
                  onNotice("발송 엑셀을 저장했습니다.", "success");
                }
              })
            }
          >
            선택 {chosen.length}건 엑셀 작성
          </button>
        )}
      </footer>
    </section>
  );
}
