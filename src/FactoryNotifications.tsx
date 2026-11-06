import { replyNeedsReview } from "./factory-replies";
import { confirmAction } from "./dialogs";
import { useState } from "react";
import type { State } from "./types";
import { Modal } from "./ui";
import { won } from "./domain";
export function FactoryNotifications({
  state,
  onClose,
  onOpen,
}: {
  state: State;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const [error, setError] = useState("");
  return (
    <Modal title="공장 회신 알림" onClose={onClose}>
      <p role="alert" className="form-error">
        {error}
      </p>
      <div className="factory-notifications">
        {!state.factoryReplies?.length && (
          <p>공장 회신 내역이 없습니다. 설정에서 회신 수신 폴더를 지정하세요.</p>
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
              <button
                onClick={() =>
                  void window.bando!.openFactoryFile!(record.id).catch((e) => setError(String(e)))
                }
              >
                회신 파일 열기
              </button>
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
                              "기존 송장 / 실제 운임을 이 공장 회신 값으로 정정할까요? 이전 값과 이력은 보존합니다.",
                            ))
                          )
                            return;
                          try {
                            await window.bando!.approveFactoryConflict!(record.id, row.row);
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
