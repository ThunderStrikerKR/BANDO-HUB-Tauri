import type { StaffBlock } from "./hub-messages";
export function StaffChecks({
  blocks,
  loading = false,
  error = "",
  onSelect,
  onApproveOne,
  canApproveOne,
  approvingQuantity = false,
  onCancelApproval,
  onCandidate,
}: {
  blocks: StaffBlock[];
  loading?: boolean;
  error?: string;
  onSelect: (block: StaffBlock) => void;
  onApproveOne?: (block: StaffBlock) => void;
  canApproveOne?: (block: StaffBlock) => boolean;
  approvingQuantity?: boolean;
  onCancelApproval?: (b: StaffBlock) => void;
  onCandidate?: (b: StaffBlock, value: string) => void;
}) {
  const visible = loading || error ? [] : blocks;
  const actions = visible.filter((b) => b.severity !== "INFO"),
    facts = visible.filter((b) => b.severity === "INFO"),
    inherited = facts.filter(
      (b) =>
        b.kind === "APPLIED" && b.resolutionSource === "코어" && b.title === "공통 상품 자동 적용",
    ),
    others = facts.filter((b) => !inherited.includes(b));
  return (
    <section className="staff-checks" aria-label="확인할 내용">
      <h3>
        확인할 내용{" "}
        <small>
          조치 {actions.length}건 / 안내 {facts.length}건
        </small>
      </h3>
      <div className="staff-check-scroll">
        {loading
          ? <p className="staff-empty">확인 항목을 계산하고 있습니다.</p>
          : error
            ? <p className="form-error" role="alert">Rust 확인 항목 조회 실패: {error}</p>
            : !actions.length && <p className="staff-empty">필수 확인 사항 없음</p>}
        {actions.map((b, n) => (
          <article
            className={
              "staff-block" +
              ([
                "MODEL",
                "ALIAS_CONFLICT",
                "CATEGORY_CONFLICT",
                "QUANTITY_LINK",
                "NAME",
                "ADDRESS",
                "CONTACT",
                "PRICE",
                "ITEM",
                "MODEL_CONFIRM",
                "QUANTITY_INVALID",
              ].includes(b.kind ?? "")
                ? " essential-issue"
                : "")
            }
            key={b.issueId ?? n}
          >
            <div className="issue-heading">
              <b>{b.title}</b>
              <small className={b.kind === "UNASSIGNED_EVIDENCE" ? "unassigned-evidence-detail" : undefined}>
                {b.detail}
              </small>
            </div>
            {b.kind === "UNASSIGNED_EVIDENCE" && (
              <small className="unassigned-evidence-hint">
                상품 또는 수량으로 인식된 문구입니다. 수동 분류에서 실제 주문 내용과 연결할지 확인하세요.
              </small>
            )}
            {b.resolution === "PENDING_CUSTOMER" && (
              <small>거래처 확인 대기 / 문의 복사만으로 해결되지 않습니다.</small>
            )}
            <div className="issue-actions">
              {b.choices?.map((c, n) => (
                <button key={n} onClick={() => onCandidate?.(b, c.value)}>
                  {c.label} → 적용
                </button>
              ))}
              {b.kind === "QUANTITY_MISSING" ? (
                <>
                  <button type="button" onClick={() => onSelect(b)}>수량 수정</button>
                  <button
                    type="button"
                    disabled={approvingQuantity || !onApproveOne || !canApproveOne?.(b)}
                    title={!canApproveOne?.(b)
                      ? "상품이 정확히 연결된 수량 미기재 건에만 1개 잠정 처리를 사용할 수 있습니다."
                      : "직원 판단으로 1개를 잠정 적용합니다. 고객에게 보내는 안내문에 1개 발송 예정 문구가 포함됩니다."}
                    onClick={() => onApproveOne?.(b)}
                  >
                    {approvingQuantity ? "처리 중" : "1개로 잠정 처리"}
                  </button>
                </>
              ) : (
                <button onClick={() => onSelect(b)}>
                  {b.kind === "UNASSIGNED_EVIDENCE"
                    ? "수동 분류에서 확인"
                    : [
                          "MODEL",
                          "MODEL_CHOICE",
                          "ALIAS_CONFLICT",
                          "CATEGORY_CONFLICT",
                          "QUANTITY_LINK",
                          "OPTION",
                        ].includes(b.kind ?? "")
                      ? "해결 절차 보기"
                      : "입력 위치로 이동"}
                </button>
              )}
            </div>
          </article>
        ))}
        {inherited.length > 0 && (
          <details className="staff-fact">
            <summary>공통 상품 자동 적용 / {inherited.length}개 항목</summary>
            {inherited.map((b, n) => (
              <div className="staff-fact-entry" key={b.issueId ?? n}>
                <div className="staff-fact-message">{b.detail}</div>
                <div className="issue-actions">
                  <button onClick={() => onSelect(b)}>입력 위치로 이동</button>
                </div>
              </div>
            ))}
          </details>
        )}
        {others.map((b, n) => (
          <article className="staff-fact" key={b.issueId ?? n}>
            <div className="staff-fact-message">
              <b>{b.kind === "QUANTITY_MISSING" && b.resolution === "PROVISIONALLY_APPROVED"
                ? "수량 1개 잠정 처리됨"
                : b.title}</b>
              <small>{b.detail}</small>
              {b.kind === "QUANTITY_MISSING" && b.resolution === "PROVISIONALLY_APPROVED" && (
                <small>1개 발송 예정 안내가 복사용 메시지에 포함됩니다. 실제 수량이 확인되면 수량을 수정하세요.</small>
              )}
            </div>
            <div className="issue-actions">
              <button onClick={() => onSelect(b)}>입력 위치로 이동</button>
              {b.kind === "QUANTITY_MISSING" && b.resolution === "PROVISIONALLY_APPROVED" && (
                <button type="button" onClick={() => onCancelApproval?.(b)}>잠정 승인 취소</button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
