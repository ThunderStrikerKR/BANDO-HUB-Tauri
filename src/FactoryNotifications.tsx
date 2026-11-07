import { replyNeedsReview } from "./factory-replies";
import { factoryConflictConfirmation } from "./factory-conflict-review";
import { confirmAction } from "./dialogs";
import { useState } from "react";
import type { State } from "./types";
import { Modal } from "./ui";
import { won } from "./domain";
export function FactoryNotifications({
  state,
  onClose,
  onOpen,
  onRefresh,
}: {
  state: State;
  onClose: () => void;
  onOpen: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <Modal title="공장 회신 알림" onClose={onClose}>
      <p role="alert" className="form-error">
        {error}
      </p>
      <div className="factory-notifications">
        {!state.factoryReplies?.length && (
          <p>공장 회신 내역이 없습니다. 공장 목록의 엑셀 작성 이력에서 회신 파일을 업로드하세요.</p>
        )}
        {state.factoryReplies
          ?.slice()
          .reverse()
          .map((record) => (
            <article key={record.id}>
              <h3>
                {record.filename} / {" "}
                {!replyNeedsReview(state, record)
                  ? "반영 완료"
                  : record.status === "PARTIAL"
                    ? "일부 반영"
                    : "직원 확인 필요"}
              </h3>
              <small>
                {record.businessDate} / {new Date(record.at).toLocaleString("ko-KR")}
              </small>
              {record.archivedPath && record.id.startsWith("factory-reply-") && (
                <button type="button"
                  onClick={() =>
                    void window.bando!.openFactoryFile!(record.id).catch((e) => setError(String(e)))
                  }
                >
                  회신 원본 열기
                </button>
              )}
              {record.error && <p className="form-error">{record.error}</p>}
              {record.rows.map((row) => (
                <div key={row.row}>
                  <p>
                    {row.row}행 / {row.name} / {" "}
                    {row.applied
                      ? `${row.tracking} / 실제 운임 ${won(row.actual)}`
                      : row.issue || "직원 확인 필요"}
                  </p>
                  {!row.applied &&
                    row.shipmentId &&
                    row.issue?.includes("충돌") &&
                    !state.factoryReplies?.some(
                      (r) => r.resolves?.id === record.id && r.resolves.row === row.row,
                    ) && (
                      <button
                        onClick={async () => {
                          if (
                            !(await confirmAction(
                              factoryConflictConfirmation(state, record.id, row.row),
                            ))
                          )
                            return;
                          try {
                            if (!window.bando?.approveFactoryConflict) {
                              throw Error("공장 회신 충돌 승인 기능을 사용할 수 없습니다.");
                            }
                            try {
                              await window.bando.approveFactoryConflict(
                                record.id, row.row, state.revision ?? 0,
                              );
                            } finally {
                              await onRefresh();
                            }
                          } catch (e) {
                            setError(String(e));
                          }
                        }}
                      >
                        충돌 값 확인 후 정정
                      </button>
                    )}
                  {row.orderId && (
                    <button
                      onClick={() => {
                        onClose();
                        onOpen(row.orderId!);
                      }}
                    >
                      해당 주문 보기
                    </button>
                  )}
                </div>
              ))}
            </article>
          ))}
      </div>
    </Modal>
  );
}
