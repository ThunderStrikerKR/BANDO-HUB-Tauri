import { confirmAction } from "./dialogs";
import { factoryConflictConfirmation } from "./factory-conflict-review";
import { replyNeedsReview } from "./factory-replies";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { NoticeSink } from "./shared/notices";
import type { State } from "./types";
import { EmptyState } from "./ui/PageHeading";
import { ManagementTable } from "./ui/ManagementTable";

export function FactoryReplyHistory({
  state, query, onOpen, onRefresh, onNotice,
}: {
  state: State;
  query: string;
  onOpen: (id: string) => void;
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const records = (state.factoryReplies ?? [])
    .filter((r) => (r.filename + " " + r.businessDate).includes(query))
    .slice().reverse();
  const correct = (id: string, row: number) => void run(async () => {
    if (!(await confirmAction(factoryConflictConfirmation(state, id, row)))) return;
    if (!window.bando?.approveFactoryConflict) {
      throw Error("공장 회신 충돌 승인 기능을 사용할 수 없습니다.");
    }
    try {
      await window.bando.approveFactoryConflict(id, row, state.revision ?? 0);
    } finally {
      await onRefresh();
    }
    onNotice("회신 충돌 행을 정정하고 이전 값을 이력에 보존했습니다.", "success");
  });
  return (
    <section className="factory-reply-history">
      <h3>공장 회신 이력</h3>
      {!records.length ? (
        <EmptyState compact title={query ? "검색 조건에 맞는 공장 회신 이력이 없습니다." : "공장 회신 이력이 없습니다."} />
      ) : (
        <ManagementTable className="factory-reply-data-table">
          <thead>
            <tr>
              <th>업무 날짜</th>
              <th>회신 파일</th>
              <th>반영 상태</th>
              <th>연결된 주문 / 행별 검토</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td>{r.businessDate}</td>
                <td>
                  <strong>{r.filename}</strong>
                  {r.archivedPath && r.id.startsWith("factory-reply-") && (
                    <button type="button" disabled={busy}
                      onClick={() => void run(() => window.bando!.openFactoryFile!(r.id))}>
                      원본 Excel 열기
                    </button>
                  )}
                </td>
                <td>{replyNeedsReview(state, r) ? "직원 확인 필요" : "반영 완료"}</td>
                <td>
                  {[...new Set(r.rows.map((row) => row.orderId).filter(Boolean))].map((id) => (
                    <button type="button" key={id} onClick={() => onOpen(id!)}>
                      {r.rows.find((row) => row.orderId === id)?.name || "주문 보기"}
                    </button>
                  ))}
                  {r.error && (
                    <p className="form-error" role="alert">{r.error}</p>
                  )}
                  <details>
                    <summary>회신 행 {r.rows.length}건 보기</summary>
                    {r.rows.map((row) => {
                      const resolved = state.factoryReplies?.some((later) =>
                        later.resolves?.id === r.id && later.resolves.row === row.row &&
                        later.rows.some((result) => result.applied));
                      return (
                        <div className="factory-reply-history-row" key={row.row}>
                          <strong>{row.row}행 / {row.name}</strong>
                          <span>{row.tracking || "운송장 미입력"} / {row.actual === null ? "실제 운임 미확인" : row.actual.toLocaleString("ko-KR") + "원"}</span>
                          <span>{resolved ? "직원 정정 완료" : row.applied ? "반영 완료" : row.issue || "검토 필요"}</span>
                          {!resolved && !row.applied && row.shipmentId && row.issue?.includes("충돌") && (
                            <button type="button" disabled={busy} onClick={() => correct(r.id, row.row)}>
                              충돌 값 확인 후 정정
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </ManagementTable>
      )}
    </section>
  );
}
