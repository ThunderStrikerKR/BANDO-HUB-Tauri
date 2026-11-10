import { FactoryReplyHistory } from "./FactoryReplyHistory";
import { HelpTooltip } from "./ui/HelpTooltip";
import { FactoryReplyImport } from "./FactoryReplyImport";
import { ActualFreightField } from "./ActualFreightField";
import { actualFreightOf, recordActualFreight } from "./actual-freight";
import { requestPageLeave, usePageLeaveGuard } from "./shared/page-leave";
import { createFactoryWorkbook, previewFactoryExport, recordFactoryExport } from "./factory-export";
import { createStoreWorkbook, previewStoreExport, recordStoreExport } from "./store-export";
import { confirmAction } from "./dialogs";
import { useState } from "react";
import { markFactoryDelivered, reopenUnsentExport } from "./corrections";
import { won } from "./domain";
import { internalModel } from "./matching";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { Origin, Price, State } from "./types";
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
  const [freightDrafts, setFreightDrafts] = useState<Record<string, { shipmentId: string; origin: Origin; value: Price }>>({});
  const pendingFreight = Object.values(freightDrafts).filter(({shipmentId, origin, value}) => {
    const ship = state.workflow?.shipments.find((s) => s.id === shipmentId);
    const row = state.orders.find((o) => o.id === ship?.orderId)
      ?.recipients.find((r) => r.id === ship?.recipientId);
    return !ship || !row || actualFreightOf(ship, row, origin) !== value;
  });
  const saveFreightDrafts = async (): Promise<boolean> => {
    if (busy) return false;
    if (!pendingFreight.length) return true;
    try {
      let latest = await window.bando!.load();
      for (const { shipmentId, origin, value } of pendingFreight)
        latest = recordActualFreight(latest, shipmentId, origin, value);
      await onSave(latest);
      setFreightDrafts({});
      return true;
    } catch (error) {
      onNotice(String(error), "error");
      return false;
    }
  };
  usePageLeaveGuard({
    label: "실제 출고 운임",
    hasChanges: () => pendingFreight.length > 0,
    busy: () => busy,
    save: saveFreightDrafts,
    discard: () => setFreightDrafts({}),
  });
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
  // Historical orders without frozen export snapshots are not directly exportable.
  const visible = rows.map((q) => q.id),
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
      <h1 className="settings-help-heading">엑셀 / 매장 발송 관리 <HelpTooltip title="발송 Excel 관리" purpose="공장이나 매장에서 발송할 주문을 모아 배송용 Excel 파일을 만듭니다." when="주문 확인과 입금 처리 후 물품을 발송하기 위한 자료가 필요할 때 사용합니다." steps={["공장 엑셀 대기 또는 매장 발송 대기 탭을 선택합니다.", "발송할 주문을 검색하고 확인합니다.", "대상 주문을 선택합니다.", "아래 Excel 작성 버튼을 눌러 파일을 만듭니다."]} result="선택한 발송 건을 Excel 파일로 저장해 출고 업무에 사용할 수 있습니다." caution="Excel 파일을 만들었다고 실제로 상품이 포장되거나 발송 완료되는 것은 아닙니다." /></h1>
      <div className="workflow-queue-tabs">
        {(["FACTORY", "STORE", "HISTORY"] as const).map((value, index) => (
          <button
            key={value}
            aria-pressed={scope === value}
            onClick={() => void (async () => {
              if (scope === value) return;
              const leave = await requestPageLeave((message) => onNotice(message, "error"));
              if (!leave.proceed) return;
              setScope(value);
              setSelected([]);
              setQuery("");
            })()}
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
      {scope === "HISTORY" && (
        <FactoryReplyImport onSave={onSave} onRefresh={onRefresh} onNotice={onNotice} />
      )}
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
                      {e.savedPath ? (
                        <div className="actions">
                          <button type="button" disabled={busy}
                            onClick={() => void run(async () => {
                              await window.bando!.openExportFile(e.id);
                              onNotice("저장된 Excel 파일을 열었습니다.", "success");
                            })}>
                            파일 열기
                          </button>
                          <button type="button" disabled={busy}
                            onClick={() => void run(async () => {
                              await window.bando!.copy(e.savedPath!);
                              onNotice("저장 경로를 복사했습니다.", "success");
                            })}>
                            파일 경로 복사
                          </button>
                        </div>
                      ) : <span className="muted">기존 파일 위치를 확인하세요.</span>}
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
                              {q!.origin === "STORE" ? (
                                <button
                                  disabled={busy}
                                  onClick={() => void run(async () => {
                                    if (!(await confirmAction(
                                      "이 매장 발송 파일의 상품을 실제 발송했나요? 파일 작성만으로 발송 완료 처리하지 않습니다."
                                    ))) return;
                                    await onSave(markStoreSent(state, q!.id));
                                  })}
                                >
                                  매장 발송 확인
                                </button>
                              ) : (<>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    if (!(await confirmAction("이 발송 파일을 실제 공장에 전달했나요? 직원 확인 후에만 전달 완료로 표시합니다."))) return;
                                    await onSave(markFactoryDelivered(state, q!.shipmentId));
                                  })
                                }
                              >
                                실제 공장 전달 확인
                              </button>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    if (!(await confirmAction("아직 공장에 전달하지 않은 출력본을 폐기하고 다시 작성할까요? 기존 출력 이력은 보존됩니다."))) return;
                                    await onSave(reopenUnsentExport(state, q!.shipmentId));
                                  })
                                }
                              >
                                전달 전 정정 / 재출력
                              </button>
                              </>)}
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
                          draftValue={freightDrafts[q.origin + ":" + ship.id]?.value}
                          onDraftChange={(value) => setFreightDrafts((previous) => ({
                            ...previous,
                            [q.origin + ":" + ship.id]: { shipmentId: ship.id, origin: q.origin, value },
                          }))}
                          onDraftSaved={() => setFreightDrafts((previous) => {
                            const next = { ...previous };
                            delete next[q.origin + ":" + ship.id];
                            return next;
                          })}
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
                      disabled
                      title="기존 주문은 출고 이관 후 출력할 수 있습니다."
                      aria-label={"이전 주문 선택 불가 " + o.id}
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
          <FactoryReplyHistory state={state} query={query} onOpen={onOpen}
            onRefresh={onRefresh} onNotice={onNotice} />
        )}
      </div>
      <footer className="excel-fixed-footer">
        {scope !== "HISTORY" && <small className="muted">저장 위치는 Windows 저장 창에서 선택합니다. 파일 작성은 발송 완료가 아닙니다.</small>}
        {companyMissing && onSettings && <button onClick={onSettings}>반도스탠드 정보 설정</button>}
        {scope !== "HISTORY" && (
          <button
            className="primary"
            disabled={busy || !chosen.length}
            onClick={() =>
              void run(async () => {
                if (scope === "STORE") {
                  const current = await window.bando!.load();
                  const preview = previewStoreExport(current, chosen);
                  if (!(await confirmAction(
                    "매장 발송 " + preview.rows.length + "건의 Excel을 작성할까요? 실제 포장과 택배 발송은 별도로 확인합니다."
                  ))) return;
                  if (!window.bando!.saveStoreWorkbook) {
                    throw Error("매장 Excel 저장 기능이 연결되지 않았습니다.");
                  }
                  await window.bando!.backup();
                  const bytes = await createStoreWorkbook(preview);
                  const savedPath = await window.bando!.saveStoreWorkbook(bytes);
                  if (!savedPath) return;
                  try {
                    const latest = await window.bando!.load();
                    const result = recordStoreExport(latest, preview, savedPath);
                    await onSave(result.next);
                    setSelected([]);
                    onNotice("매장 발송 " + preview.rows.length +
                      "건의 출력 이력을 저장했습니다. 실제 발송은 별도 확인해야 합니다.", "success");
                  } catch (error) {
                    throw Error("Excel 파일 저장 후 매장 출력 이력 기록에 실패했습니다. " +
                      "이 파일을 사용하지 말고 확인하세요: " + savedPath + " / " + String(error));
                  }
                  return;
                }
                const current = await window.bando!.load();
                const preview = previewFactoryExport(current, chosen);
                if (!(await confirmAction(
                  "공장 발송 " + preview.rows.length + "건의 로젠택배 Excel을 작성할까요? 저장 후 실제 공장 전달은 별도로 확인합니다."
                ))) return;
                if (!window.bando!.saveFactoryWorkbook) throw Error("공장 Excel 저장 기능이 연결되지 않았습니다.");
                await window.bando!.backup();
                const bytes = await createFactoryWorkbook(preview);
                const savedPath = await window.bando!.saveFactoryWorkbook(bytes);
                if (!savedPath) return;
                try {
                  const latest = await window.bando!.load();
                  const result = recordFactoryExport(latest, preview, savedPath);
                  await onSave(result.next);
                  setSelected([]);
                  onNotice("공장 발송 " + preview.rows.length + "건의 출력 이력을 저장했습니다. 실제 공장 전달은 별도로 확인해 주세요.", "success");
                } catch (error) {
                  throw Error("Excel 파일은 저장됐지만 출력 이력 기록에 실패했습니다. 공장에 전달하지 말고 파일을 확인하세요: " +
                    savedPath + " / " + String(error));
                }
              })
            }
          >
            {scope === "STORE" ? "선택 " + chosen.length + "건 매장 Excel 작성" : "선택 " + chosen.length + "건 공장 Excel 작성"}
          </button>
        )}
      </footer>
    </section>
  );
}
