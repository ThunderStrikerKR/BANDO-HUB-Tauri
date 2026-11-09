import { WorkingRawDialog } from "./WorkingRawDialog";
import { rawCorrectionAllowed } from "./working-raw";
import { useState } from "react";
import { CorrectionPanel } from "./CorrectionPanel";
import { ActualFreightField } from "./ActualFreightField";
import { contactProblem } from "./contact";
import { deliveryRequirements, validDeliveryAddress } from "./delivery-requirements";
import { IssueResolver } from "./IssueResolver";
import { LinkContext, Linked } from "./LinkedText";
import { OrderItemEditor } from "./OrderItemEditor";
import { ProductSearchDialog } from "./ProductSearchDialog";
import { SourceDocument } from "./SourceDocument";
import { StaffChecks } from "./StaffChecks";
import { WorkflowFooter, WorkflowFreightRows } from "./WorkflowFooter";
import { repriceOrder, resolvePrice, won } from "./domain";
import { confirmProposedProduct } from "./issue-actions";
import { internalModel } from "./matching";
import { useOrderDesk, type OrderDeskProps } from "./orders/useOrderDesk";
import { addressParts } from "./parser";
import { billingSnapshot } from "./replies";
import { Field, clone } from "./ui";
import { clientChangeIssue, orderGrandTotal, reconcileWorkflow, shipmentVat } from "./workflow";
export function OrderDesk(props: OrderDeskProps) {
  const [correcting, setCorrecting] = useState(false);
  const [changeRequest, setChangeRequest] = useState<string>();
  const {
    highlight,
    linkController,
    setHighlight,
    viewMode,
    place,
    state,
    draft,
    source,
    client,
    setSource,
    saved,
    onChange,
    exported,
    onWorkflowSave,
    onSaveState,
    onNotice,
    portalTargets,
    staffBlocks,
    selectIssue,
    recEdit,
    products,
    pricingClient,
    shownRecipient,
    setItemEditing,
    itemEdit,
    activeShipment,
    flowState,
    setProductSearch,
    activeGroupId,
    run,
    resolving,
    setResolving,
    productSearch,
    chooseProduct,
    itemEditing,
  } = useOrderDesk(props);
  if (draft.orderType === "RETAIL")
    return (
      <>
        {viewMode !== "reception" &&
          place(
            <section className="desk-pane review-pane retail-summary">
              <header className="pane-heading">
                <h2>소매 주문 / 반도스탠드</h2>
              </header>
              <div className="retail-order-body">
                {draft.recipients.map((r) => (
                  <article key={r.id}>
                    <h3>{r.name}</h3>
                    <p>{r.address}</p>
                    <p>{r.mobile || r.phone}</p>
                    <p>{r.note}</p>
                    <h3>품목 및 운임</h3>
                    {r.items.map((i) => (
                      <p key={i.id}>
                        {i.name} — {i.color} × {i.quantity}
                      </p>
                    ))}
                    <p>출고지: {r.dispatchOrigin === "STORE" ? "매장" : "공장"}</p>
                    <p>
                      실제 출고 운임:{" "}
                      {r.actualFreight === null || r.actualFreight === undefined
                        ? "회신 확인 필요"
                        : won(r.actualFreight)}
                    </p>
                  </article>
                ))}
                {state.workflow?.shipments
                  .filter((s) => s.orderId === draft.id)
                  .map(
                    (ship) =>
                      draft.recipients.find((r) => r.id === ship.recipientId)?.dispatchOrigin && (
                        <ActualFreightField
                          key={ship.id}
                          state={state}
                          shipmentId={ship.id}
                          origin={
                            draft.recipients.find((r) => r.id === ship.recipientId)!.dispatchOrigin!
                          }
                          onSave={onWorkflowSave}
                        />
                      ),
                  )}
                <p>송하인: {draft.senderSnapshot?.name}</p>
              </div>
            </section>,
            portalTargets?.details,
          )}
      </>
    );
  return (
    <LinkContext.Provider
      value={{
        active: highlight,
        recipientId: linkController?.recipientId,
        setActive: setHighlight,
      }}
    >
      {changeRequest && (
        <CorrectionPanel
          state={state}
          sid={changeRequest}
          onSave={onWorkflowSave}
          onClose={() => setChangeRequest(undefined)}
          onNotice={onNotice}
        />
      )}
      <div className="desk-grid">
        {viewMode !== "details" &&
          place(
            <SourceDocument
              state={state}
              onManual={props.onManual}
              onSettings={props.onSettings}
              order={draft}
              text={source}
              client={client}
              onText={(value) => {
                setSource(value);
              }}
              onOrder={onChange}
              onDealer={async (c) => {
                if (c.id === draft.clientId) return;
                const issue = clientChangeIssue(state, draft, c.id);
                if (issue) throw Error(issue);
                if (exported || draft.deletedAt)
                  throw Error("완료 / 삭제된 주문의 거래처는 변경할 수 없습니다.");
                const next = repriceOrder(
                  {
                    ...clone(draft),
                    clientId: c.id,
                    clientSnapshot: clone(c),
                    pricesLocked: false,
                    notified: false,
                    paid: false,
                    postpaidApproved: false,
                    status: "REVIEW",
                  },
                  c,
                  state,
                );
                if (draft.pricesLocked)
                  next.billingHistory = [
                    ...(next.billingHistory ?? []),
                    billingSnapshot(draft, state, "거래처 변경"),
                  ];
                next.updatedAt = new Date().toISOString();
                if (saved) await onWorkflowSave(reconcileWorkflow(state, next));
                onChange(next);
              }}
              onSave={onWorkflowSave}
              onSaveState={onSaveState}
              onNotice={onNotice}
            />,
            portalTargets?.source,
          )}
        {viewMode !== "reception" &&
          place(
            <section className="desk-pane review-pane compact-review">
              <div className="review-layout">
                {rawCorrectionAllowed(flowState, draft) && (
                  <button onClick={() => setCorrecting(true)}>원문 정정</button>
                )}
                <StaffChecks
                  blocks={staffBlocks}
                  onSelect={selectIssue}
                  onCancelApproval={(b) => {
                    if (b.itemId)
                      recEdit(
                        b.recipientId,
                        (r) => {
                          const i = r.items.find((i) => i.id === b.itemId);
                          if (i) delete i.quantityApproval;
                        },
                        false,
                      );
                  }}
                  onCandidate={(b, value) =>
                    recEdit(
                      b.recipientId,
                      (r) => {
                        if (b.kind === "OPTION") {
                          const i = r.items.find((i) => i.id === b.itemId),
                            p = products.find((p) => p.id === i?.productId),
                            v = p?.variants.find((v) => v.id === value);
                          if (i && p && v) {
                            i.variantId = v.id;
                            i.color = v.color;
                            i.url = v.url;
                            i.unitPrice = resolvePrice(p, v.id, pricingClient);
                            i.issues = i.issues.filter((x) => !/색상|옵션/.test(x));
                            i.manuallyConfirmed = true;
                            delete i.quantityApproval;
                          }
                          return;
                        }
                        const field = b.kind?.slice(10);
                        if (field && ["name", "address", "phone", "mobile"].includes(field)) {
                          (r as unknown as Record<string, unknown>)[field] = value;
                          r.confirmedFields = [...new Set([...(r.confirmedFields ?? []), field])];
                          if (field === "address")
                            r.addressStatus = validDeliveryAddress(r.address)
                              ? "COMPLETE"
                              : "INCOMPLETE";
                        }
                      },
                      false,
                    )
                  }
                />
                <div className="recipient-body">
                  <header className="recipient-section-heading">
                    <h2>수취인별 주문 정보</h2>
                    <b>{draft.recipients.find((r) => r.id === shownRecipient)?.name}</b>
                    {exported &&
                      activeShipment &&
                      state.workflow?.queue.some(
                        (q) =>
                          q.shipmentId === activeShipment.id &&
                          ["EXPORTED", "STORE_SENT"].includes(q.status),
                      ) && (
                        <button onClick={() => setChangeRequest(activeShipment.id)}>
                          전달 후 변경 요청
                        </button>
                      )}
                  </header>
                  <div className="receipt-panel-content">
                    {!draft.recipients.length && (
                      <p className="detail-empty">발주 원문을 입력하거나 배송 건을 선택하세요.</p>
                    )}
                    {draft.recipients
                      .filter((r) => r.id === shownRecipient)
                      .map((r) => (
                        <article className="recipient-review" key={r.id}>
                          <div className="recipient-fields">
                            <Linked linkKey={r.id + ":name"}>
                              <Field label="이름">
                                <input
                                  aria-invalid={
                                    !deliveryRequirements(r, draft.receptionVersion !== 1).name
                                  }
                                  value={r.name}
                                  disabled={exported}
                                  onChange={(e) =>
                                    recEdit(
                                      r.id,
                                      (r) => {
                                        r.name = e.target.value;
                                        r.confirmedFields = [
                                          ...new Set([...(r.confirmedFields ?? []), "name"]),
                                        ];
                                      },
                                      false,
                                    )
                                  }
                                />
                              </Field>
                            </Linked>
                            <Linked linkKey={r.id + ":address"}>
                              <Field label="주소">
                                <input
                                  aria-invalid={
                                    !deliveryRequirements(r, draft.receptionVersion !== 1).address
                                  }
                                  value={r.address}
                                  disabled={exported}
                                  onChange={(e) =>
                                    recEdit(
                                      r.id,
                                      (r) => {
                                        r.address = e.target.value;
                                        r.addressParts = addressParts(e.target.value);
                                        r.confirmedFields = [
                                          ...new Set([...(r.confirmedFields ?? []), "address"]),
                                        ];
                                        r.addressStatus = validDeliveryAddress(r.address)
                                          ? "COMPLETE"
                                          : "INCOMPLETE";
                                      },
                                      false,
                                    )
                                  }
                                />
                              </Field>
                            </Linked>
                            <div className="recipient-phones">
                              <Linked linkKey={r.id + ":mobile"}>
                                <Field label="휴대폰">
                                  <input
                                    aria-invalid={
                                      !deliveryRequirements(r, draft.receptionVersion !== 1).contact
                                    }
                                    value={r.mobile}
                                    disabled={exported}
                                    onChange={(e) =>
                                      recEdit(
                                        r.id,
                                        (r) => {
                                          r.mobile = e.target.value;
                                          r.confirmedFields = [
                                            ...new Set([...(r.confirmedFields ?? []), "mobile"]),
                                          ];
                                        },
                                        false,
                                      )
                                    }
                                  />
                                  {!deliveryRequirements(r, draft.receptionVersion !== 1).contact &&
                                    r.mobile && (
                                      <small className="form-error">
                                        {contactProblem(r.mobile, true)}
                                      </small>
                                    )}
                                </Field>
                              </Linked>
                              <Linked linkKey={r.id + ":phone"}>
                                <Field label="전화">
                                  <input
                                    aria-invalid={
                                      !deliveryRequirements(r, draft.receptionVersion !== 1).contact
                                    }
                                    value={r.phone}
                                    disabled={exported}
                                    onChange={(e) =>
                                      recEdit(
                                        r.id,
                                        (r) => {
                                          r.phone = e.target.value;
                                          r.confirmedFields = [
                                            ...new Set([...(r.confirmedFields ?? []), "phone"]),
                                          ];
                                        },
                                        false,
                                      )
                                    }
                                  />
                                  {!deliveryRequirements(r, draft.receptionVersion !== 1).contact &&
                                    r.phone && (
                                      <small className="form-error">
                                        {contactProblem(r.phone, false)}
                                      </small>
                                    )}
                                </Field>
                              </Linked>
                            </div>
                            <Field label="요청 메시지">
                              <input
                                value={r.note}
                                disabled={exported}
                                onChange={(e) =>
                                  recEdit(
                                    r.id,
                                    (r) => {
                                      r.note = e.target.value;
                                      r.confirmedFields = [
                                        ...new Set([...(r.confirmedFields ?? []), "note"]),
                                      ];
                                    },
                                    false,
                                  )
                                }
                              />
                            </Field>
                          </div>
                        </article>
                      ))}
                    {!!draft.replies?.length && (
                      <details className="reply-history">
                        <summary>최초 주문 이후 회신 {draft.replies.length}건</summary>
                        {draft.replies.map((r) => (
                          <p key={r.id}>{r.raw}</p>
                        ))}
                      </details>
                    )}
                  </div>
                </div>
                <section className="items-freight-panel">
                  <header className="recipient-section-heading">
                    <h2>품목 및 운임</h2>
                  </header>
                  <div className="items-freight-scroll receipt-panel-content">
                    {draft.recipients
                      .filter((r) => r.id === shownRecipient)
                      .map((r) => (
                        <article key={r.id}>
                          <table className="compact-items">
                            <thead>
                              <tr>
                                <th>품목</th>
                                <th>수량</th>
                                <th>금액</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.items.map((i) => (
                                <tr key={i.id} data-item-id={i.id}>
                                  <td>
                                    <Linked linkKey={i.id + ":product"}>
                                      <button
                                        className="item-row-edit"
                                        aria-invalid={!i.productId || !i.variantId}
                                        onClick={() => setItemEditing({ rid: r.id, iid: i.id })}
                                        aria-label={"상품 수정 " + i.name}
                                      >
                                        {internalModel(i.name)}
                                      </button>
                                    </Linked>
                                  </td>
                                  <td>
                                    <Linked linkKey={i.id + ":quantity"}>
                                      <input
                                        type="number"
                                        aria-label={"수량 " + i.name}
                                        aria-invalid={
                                          i.quantityConfirmed === false ||
                                          !Number.isSafeInteger(i.quantity) ||
                                          (i.quantity ?? 0) < 1
                                        }
                                        min="1"
                                        step="1"
                                        disabled={exported}
                                        value={i.quantity ?? ""}
                                        onChange={(e) => {
                                          const q =
                                            e.target.value === "" ? null : Number(e.target.value);
                                          if (q !== null && (!Number.isInteger(q) || q < 1)) return;
                                          itemEdit(r.id, i.id, (item) => {
                                            item.quantity = q;
                                            item.quantityConfirmed = true;
                                            item.issues = item.issues.filter(
                                              (x) => !x.includes("수량"),
                                            );
                                          });
                                        }}
                                      />
                                    </Linked>
                                  </td>
                                  <td>
                                    <Linked linkKey={i.id + ":price"}>
                                      <button
                                        className="item-row-edit item-amount"
                                        onClick={() => setItemEditing({ rid: r.id, iid: i.id })}
                                      >
                                        {i.unitPrice !== null &&
                                        i.quantity !== null &&
                                        i.productId &&
                                        i.variantId
                                          ? won(i.unitPrice * i.quantity)
                                          : "확인 필요"}
                                      </button>
                                    </Linked>
                                  </td>
                                </tr>
                              ))}
                              {activeShipment?.recipientId === r.id && (
                                <WorkflowFreightRows
                                  state={flowState}
                                  shipment={activeShipment}
                                  activeKey={highlight}
                                  onFreight={(origin, value) =>
                                    recEdit(
                                      r.id,
                                      (r) => {
                                        r.shippingCharges = {
                                          ...activeShipment.charges,
                                          [origin]: value,
                                        };
                                      },
                                      false,
                                    )
                                  }
                                  onCode={(v) => recEdit(r.id, (r) => (r.freightCode = v), false)}
                                />
                              )}
                            </tbody>
                          </table>
                          <div className="recipient-row-actions">
                            <button
                              disabled={exported}
                              onClick={() => setProductSearch({ rid: r.id })}
                            >
                              ＋ 상품 추가
                            </button>
                            <div className="dispatch-origin" role="group" aria-label="발송지">
                              <span className="dispatch-origin-label">발송지:</span>
                              {(["FACTORY", "STORE"] as const).map((origin) => (
                                <button
                                  key={origin}
                                  disabled={exported}
                                  aria-pressed={
                                    (r.dispatchOrigin ??
                                      (r.items.every((i) => i.origin === "STORE")
                                        ? "STORE"
                                        : r.items.every((i) => i.origin === "FACTORY")
                                          ? "FACTORY"
                                          : undefined)) === origin
                                  }
                                  onClick={() =>
                                    recEdit(
                                      r.id,
                                      (row) => {
                                        const previous =
                                          row.dispatchOrigin ?? row.items[0]?.origin ?? "FACTORY";
                                        row.dispatchOrigin = origin;
                                        row.items.forEach((i) => (i.origin = origin));
                                        if (row.shippingCharges)
                                          row.shippingCharges = {
                                            [origin]: row.shippingCharges[previous] ?? null,
                                          };
                                      },
                                      false,
                                    )
                                  }
                                >
                                  {origin === "FACTORY" ? "공장" : "매장"}
                                </button>
                              ))}
                            </div>
                          </div>
                        </article>
                      ))}
                    {!(activeShipment && activeGroupId) && (
                      <div className="pending-shipping">
                        거래처 선택 후 운임과 청구금액을 확인합니다.
                      </div>
                    )}
                  </div>
                  {activeShipment && activeGroupId ? (
                    <WorkflowFooter
                      state={flowState}
                      shipment={activeShipment}
                      groupId={activeGroupId}
                      onVat={(v) =>
                        recEdit(activeShipment.recipientId, (r) => (r.vatOverride = v), false)
                      }
                    />
                  ) : null}
                </section>
              </div>
              <div className="order-grand-total">
                총 주문 금액{" "}
                <span className="shipment-count">
                  | 택배{" "}
                  {flowState.workflow?.shipments.filter(
                    (s) =>
                      s.orderId === draft.id &&
                      !s.legacyArchived &&
                      !flowState.workflow?.groups.find((g) => g.id === s.groupId)?.deletedAt,
                  ).length ?? 0}
                  건 |
                </span>
                <b>
                  {orderGrandTotal(flowState, draft.id) === null
                    ? "—"
                    : won(orderGrandTotal(flowState, draft.id))}
                </b>
                <small>
                  (
                  {draft.recipients.some((r) => shipmentVat(draft, r)) &&
                  draft.recipients.some((r) => !shipmentVat(draft, r))
                    ? "배송 건별 부가세 적용"
                    : draft.recipients.some((r) => shipmentVat(draft, r))
                      ? "부가세 포함"
                      : "부가세 별도"}
                  )
                </small>
              </div>
            </section>,
            portalTargets?.details,
          )}
        {resolving &&
          (() => {
            const r = draft.recipients.find((r) => r.id === resolving.rid),
              i = r?.items.find((i) => i.id === resolving.iid);
            return r && i ? (
              <IssueResolver
                state={state}
                order={draft}
                recipient={r}
                item={i}
                onClose={() => setResolving(undefined)}
                onRemove={() => {
                  recEdit(r.id, (r) => (r.items = r.items.filter((x) => x.id !== i.id)));
                  setResolving(undefined);
                }}
                onNotice={onNotice}
                onApply={async (next, order) => {
                  if (JSON.stringify(next.aliases) !== JSON.stringify(state.aliases))
                    await onSaveState(next);
                  if (
                    order.recipients
                      .find((r) => r.id === resolving.rid)
                      ?.items.find((i) => i.id === resolving.iid)?.modelProposal?.required
                  ) {
                    order.requestedIssueIds = [
                      ...new Set([
                        ...(order.requestedIssueIds ?? []),
                        ["issue", order.id, resolving.rid, resolving.iid, "MODEL_CONFIRM"].join(
                          ":",
                        ),
                      ]),
                    ];
                  }
                  onChange(order);
                }}
              />
            ) : null;
          })()}
        {productSearch && (
          <ProductSearchDialog
            state={state}
            clientId={draft.clientId}
            onClose={() => setProductSearch(undefined)}
            onChoose={(p) => chooseProduct(productSearch.rid, p, productSearch.iid)}
          />
        )}
        {itemEditing &&
          !productSearch &&
          (() => {
            const r = draft.recipients.find((r) => r.id === itemEditing.rid),
              i = r?.items.find((i) => i.id === itemEditing.iid);
            return r && i ? (
              <OrderItemEditor
                state={state}
                item={i}
                client={pricingClient}
                locked={exported}
                onClose={() => setItemEditing(undefined)}
                onApply={(next) => itemEdit(r.id, i.id, (item) => Object.assign(item, next))}
                onRemove={() => {
                  recEdit(r.id, (r) => (r.items = r.items.filter((x) => x.id !== i.id)));
                  setItemEditing(undefined);
                }}
                onConfirm={() =>
                  void run(async () => {
                    const result = confirmProposedProduct(state, draft, r.id, i.id);
                    if (JSON.stringify(result.state.aliases) !== JSON.stringify(state.aliases))
                      await onSaveState(result.state);
                    onChange(result.order);
                    setItemEditing(undefined);
                  })
                }
              />
            ) : null;
          })()}
      </div>
      {correcting && (
        <WorkingRawDialog
          state={flowState}
          order={draft}
          onClose={() => setCorrecting(false)}
          onApply={async (next) => {
            const updated = next.orders.find((o) => o.id === draft.id)!;
            if (saved) await onSaveState(next);
            setSource(updated.analysisRaw ?? updated.raw);
            onChange(updated);
          }}
        />
      )}
    </LinkContext.Provider>
  );
}
