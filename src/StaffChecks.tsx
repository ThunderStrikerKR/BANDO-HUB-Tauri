import type { StaffBlock } from "./hub-messages";
export function StaffChecks({
  blocks,
  onSelect,
  onCancelApproval,
  onCandidate,
}: {
  blocks: StaffBlock[];
  onSelect: (block: StaffBlock) => void;
  onCancelApproval?: (b: StaffBlock) => void;
  onCandidate?: (b: StaffBlock, value: string) => void;
}) {
  const actions = blocks.filter((b) => b.severity !== "INFO"),
    facts = blocks.filter((b) => b.severity === "INFO"),
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
        {!actions.length && <p className="staff-empty">필수 확인 사항 없음</p>}
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
            <button className="issue-heading" onClick={() => onSelect(b)}>
              <b>{b.title}</b>
              <small>{b.detail}</small>
            </button>
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
                  <button onClick={() => onSelect(b)}>수량 수정</button>
                </>
              ) : (
                <button onClick={() => onSelect(b)}>
                  {b.kind === "UNASSIGNED_EVIDENCE"
                    ? "수동 분류로 귀속 확인"
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
              <button key={b.issueId ?? n} onClick={() => onSelect(b)}>
                {b.detail} / 클릭해 정정
              </button>
            ))}
          </details>
        )}
        {others.map((b, n) => (
          <article className="staff-fact" key={b.issueId ?? n}>
            <button onClick={() => onSelect(b)}>
              <b>{b.title}</b>
              <small>{b.detail} / 클릭해 정정</small>
            </button>
            {b.kind === "QUANTITY_MISSING" && (
              <button onClick={() => onCancelApproval?.(b)}>잠정 승인 취소</button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
