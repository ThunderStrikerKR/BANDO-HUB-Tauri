import { validDeliveryAddress } from "./delivery-requirements";
import { useEffect, useRef, useState } from "react";
import { sameValue } from "./shared/draft";
import { confirmDiscardDraft } from "./shared/editor-flow";

import { nativeApplyCorrectionAction } from "./orders/native-rules";
import { businessCoreCall } from "./tauri-bridge";
import { itemFromProduct } from "./domain";
import { internalModel } from "./matching";
import { ProductSearchDialog } from "./ProductSearchDialog";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { Product, Recipient, State } from "./types";
import { Field, Modal, MoneyInput } from "./ui";
import { shipmentContext } from "./workflow";
export function CorrectionPanel({
  state,
  sid,
  onSave,
  onClose,
  onNotice,
}: {
  state: State;
  sid: string;
  onSave: (s: State) => Promise<void>;
  onClose: () => void;
  onNotice: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const ship = state.workflow!.shipments.find((s) => s.id === sid)!,
    ctx = shipmentContext(state, ship),
    [after, setAfter] = useState<Recipient>(() => structuredClone(ctx.recipient)),
    [search, setSearch] = useState<string>();
  const changed = !sameValue(after, ctx.recipient);
  const closeDraft = () => void confirmDiscardDraft("공장 전달 후 정정 요청", changed, onClose, busy);
  const requests = state.workflow!.changeRequests.filter((r) => r.shipmentId === sid);
  const [nativeView, setNativeView] = useState<{
    state: State;
    requests: Record<string, { status: string; message: string | null }>;
  }>();
  useEffect(() => {
    let active = true;
    void businessCoreCall<{ requests: { id: string; status: string; message: string | null }[] }>(
      "rules", "apply_correction_action", {
        action: "correction_view", state, shipmentId: sid,
      },
    ).then(({ requests }) => {
      if (active) setNativeView({
        state, requests: Object.fromEntries(requests.map((entry) => [entry.id, entry])),
      });
    }).catch((error) => {
      if (active) onNotice("Rust 정정 안내문 생성 실패: " +
        (error instanceof Error ? error.message : String(error)), "error");
    });
    return () => { active = false; };
  }, [state, sid, onNotice]);
  const view = nativeView?.state === state ? nativeView.requests : undefined;
  const latestSelection = useRef({ state, search });
  latestSelection.current = { state, search };
  const setProduct = (p: Product) => {
    const target = search;
    if (!target || busy) return;
    const client = ctx.client;
    void run(async () => {
      // The old itemFromProduct helper must not calculate a TS quote before
      // its unitPrice is overwritten. Only a registered independent variant
      // can be quoted; unconfigured products keep the original null price.
      const variantId = p.variants.length === 1 && !p.requiresOption
        ? p.variants[0].id : undefined;
      const unitPrice = variantId
        ? (await businessCoreCall<{ unitPrice: number | null }>(
            "rules", "resolve_unit_price", { product: p, variantId, client },
          )).unitPrice
        : null;
      if (latestSelection.current.state !== state ||
          latestSelection.current.search !== target) return;
      setAfter((recipient) => ({
        ...recipient,
        items: recipient.items.map((item) => item.id === target
          ? {
              ...itemFromProduct(
                p, client, undefined, item.quantity, variantId, unitPrice,
              ),
              id: item.id,
              manuallyConfirmed: true,
              quantityConfirmed: true,
              issues: [],
              sources: item.sources,
            }
          : item),
      }));
      setSearch(undefined);
    });
  };
  return (
    <>
      <Modal draft={after} busy={busy} title="공장 전달 후 정정 요청" onClose={closeDraft}>
        <p>
          배송 ID {sid} / 원본 전달 스냅샷과 입금 이력은 보존합니다. 새 출고 주문을 만들지 않습니다.
        </p>
        {ship.delivery || ship.collectedAt ? (
          <p className="warnings">
            택배 수거 / 배송 이후입니다. 일반 정정 대신 별도 배송 변경 / 반품 처리가 필요합니다.
          </p>
        ) : (
          <>
            {(["name", "address", "mobile", "phone", "note"] as const).map((field) => (
              <Field
                key={field}
                label={
                  {
                    name: "정정 수취인",
                    address: "정정 주소",
                    mobile: "정정 휴대폰",
                    phone: "정정 전화",
                    note: "정정 요청사항",
                  }[field]
                }
              >
                <input
                  value={after[field]}
                  onChange={(e) =>
                    setAfter({
                      ...after,
                      [field]: e.target.value,
                      ...(field === "address"
                        ? {
                            addressStatus: validDeliveryAddress(e.target.value)
                              ? ("COMPLETE" as const)
                              : ("INCOMPLETE" as const),
                          }
                        : {}),
                    })
                  }
                />
              </Field>
            ))}
            {after.items.map((i) => (
              <div className="correction-item" key={i.id}>
                <button onClick={() => setSearch(i.id)}>{internalModel(i.name)} / 상품 변경</button>
                <input
                  aria-label={"정정 수량 " + internalModel(i.name)}
                  type="number"
                  min="1"
                  value={i.quantity ?? ""}
                  onChange={(e) => {
                    const quantity = e.target.value === "" ? null : Number(e.target.value);
                    setAfter({
                      ...after,
                      items: after.items.map((x) =>
                        x.id === i.id ? { ...x, quantity, quantityConfirmed: true } : x,
                      ),
                    });
                  }}
                />
              </div>
            ))}
            {[...new Set(after.items.map((i) => i.origin))].map((origin) => (
              <Field key={origin} label={(origin === "FACTORY" ? "공장" : "매장") + " 정정 운임"}>
                <MoneyInput
                  value={after.shippingCharges?.[origin] ?? ship.charges[origin] ?? null}
                  onChange={(v) =>
                    setAfter({
                      ...after,
                      shippingCharges: {
                        ...ship.charges,
                        ...after.shippingCharges,
                        [origin]: v,
                      },
                    })
                  }
                />
              </Field>
            ))}
            <button
              disabled={busy}
              onClick={() => void (async () => {
                const result = await run(async () => onSave(await nativeApplyCorrectionAction(state, "request_correction", { shipmentId: sid, afterRecipient: after })));
                if (result.ok) onClose();
              })()}
            >
              정정 요청 등록
            </button>
          </>
        )}
        {requests.map((r) => {
          const status = view?.[r.id]?.status;
          const message = view?.[r.id]?.message;
          return (
            <article className="correction-request" key={r.id}>
              <h3>
                {status === "CONFIRMED"
                  ? "공장 반영 직원 확인"
                  : status === "PENDING_FACTORY"
                    ? "공장 반영 대기"
                    : status === "REGISTERED" ? "정정 요청 등록" : "상태 확인 중"}
              </h3>
              <small>
                {r.at} / {r.actor}
              </small>
              {r.afterRecipient ? (
                <>
                  {message != null ? <pre>{message}</pre> : <p>정정 안내문 확인 중</p>}
                  <button
                    disabled={busy || message == null || status === "CONFIRMED"}
                    onClick={() =>
                      void run(async () => {
                        if (message == null) throw Error("정정 안내문 확인이 완료되지 않았습니다.");
                        await window.bando!.copy(message);
                        await onSave(await nativeApplyCorrectionAction(state, "copied_correction", { requestId: r.id }));
                        onNotice(
                          "정정 문구를 복사했습니다. 실제 공장 반영은 아직 대기 상태입니다.",
                          "success",
                        );
                      })
                    }
                  >
                    공장 전달용 변경 문구 복사
                  </button>
                  <button
                    disabled={
                      busy || status !== "PENDING_FACTORY" || !!ship.delivery || !!ship.collectedAt
                    }
                    onClick={() => void run(async () => onSave(await nativeApplyCorrectionAction(state, "confirm_correction", { requestId: r.id })))}
                  >
                    실제 공장 반영 확인
                  </button>
                </>
              ) : (
                <p>{r.text} / 이전 버전의 요청 기록(반영 확정 아님)</p>
              )}
            </article>
          );
        })}
      </Modal>
      {search && (
        <ProductSearchDialog
          state={state}
          clientId={ctx.order.clientId}
          onChoose={setProduct}
          onClose={() => setSearch(undefined)}
        />
      )}
    </>
  );
}
