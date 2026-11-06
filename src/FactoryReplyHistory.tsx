import type { State } from "./types";
import type { NoticeSink } from "./shared/notices";
import { replyNeedsReview } from "./factory-replies";
export function FactoryReplyHistory({
  state,
  query,
  onOpen,
  onNotice,
}: {
  state: State;
  query: string;
  onOpen: (id: string) => void;
  onNotice: NoticeSink;
}) {
  const records = (state.factoryReplies ?? [])
    .filter((r) => (r.filename + " " + r.businessDate).includes(query))
    .slice()
    .reverse();
  return (
    <section>
      <h3>공장 회신 이력</h3>
      {!records.length ? (
        <p>공장 회신 이력이 없습니다.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>업무 날짜</th>
              <th>회신 파일</th>
              <th>반영 상태</th>
              <th>연결된 주문</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td>{r.businessDate}</td>
                <td>
                  <button
                    onClick={() =>
                      void window.bando!.openFactoryFile!(r.id).catch((e) =>
                        onNotice(String(e), "error"),
                      )
                    }
                  >
                    {r.filename}
                  </button>
                </td>
                <td>{replyNeedsReview(state, r) ? "직원 확인 필요" : "반영 완료"}</td>
                <td>
                  {[...new Set(r.rows.map((row) => row.orderId).filter(Boolean))].map((id) => (
                    <button key={id} onClick={() => onOpen(id!)}>
                      {r.rows.find((row) => row.orderId === id)?.name || "주문 보기"}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
