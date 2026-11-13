import { selectionHistory } from "./product-history";
import { confirmDiscardDraft } from "./shared/editor-flow";
import { useState } from "react";
import { ProductSearchDialog } from "./ProductSearchDialog";
import { nativeResolveProduct } from "./orders/native-rules";
import { suggestGroupRepresentative } from "./model-groups";
import { internalModel } from "./matching";
import { colorLabel } from "./product-models";
import { representativeProducts } from "./product-search";
import type { NoticeSink } from "./shared/notices";
import type { Item, Order, Product, Recipient, State } from "./types";
import { Modal } from "./ui";
export function IssueResolver({
  state,
  order,
  recipient,
  item,
  onApply,
  onClose,
  onNotice,
  onRemove,
}: {
  state: State;
  order: Order;
  recipient: Recipient;
  item: Item;
  onApply: (s: State, o: Order) => Promise<void>;
  onClose: () => void;
  onNotice: NoticeSink;
  onRemove?: () => void;
}) {
  const [step, setStep] = useState(1);
  const [scope, setScope] = useState<"client" | "once" | "common">("once"),
    [search, setSearch] = useState(false),
    [chosen, setChosen] = useState<Product>(),
    [variant, setVariant] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [useRepresentativeModel, setUseRepresentativeModel] = useState(false);
  const candidates = [
    ...new Map(
      [
        ...(item.productCandidates ?? [])
          .map((c) => state.products.find((p) => p.id === c.productId))
          .filter(
            (p): p is Product =>
              !!p &&
              p.active !== false &&
              !p.deletedAt &&
              !p.supersededBy &&
              p.catalog !== "DEMO" &&
              !p.variants.some((v) => v.source === "DEMO"),
          ),
        ...representativeProducts(state, item.raw, order.clientId),
      ]
        .filter((p) => p.catalog !== "DEMO" && !p.variants.some((v) => v.source === "DEMO"))
        .map((p) => [p.id, p]),
    ).values(),
  ];
  const exactCandidates = (item.productCandidates ?? [])
    .map(candidate => state.products.find(product => product.id === candidate.productId))
    .filter((product): product is Product => !!product);
  const representativeGuidance = suggestGroupRepresentative(state, exactCandidates);
  const representativeCandidate = representativeGuidance
    ? candidates.find(product => product.id === representativeGuidance.productId)
    : undefined;
  const chosenIsRepresentative = !!chosen && !!representativeCandidate &&
    chosen.id === representativeCandidate.id &&
    chosen.variants.some(v => v.id === variant);
  const uncertain = ["CATEGORY", "UNKNOWN"].includes(item.match?.kind ?? "UNKNOWN");
  const hasUnsavedSelection = !!chosen || !!variant || scope !== "once" || confirmed || useRepresentativeModel;
  const closeDraft = () => void confirmDiscardDraft("상품 확인 절차",hasUnsavedSelection,onClose,busy);
  return (
    <>
      <Modal title={step === 3 ? "선택한 상품 기억하기" : "상품 / 수량 확인 절차"} onClose={closeDraft} busy={busy}>
        {item.temporary && (
          <button className="danger" onClick={onRemove}>
            중복 / 오독 항목 제거
          </button>
        )}
        <p className="resolver-progress">{step} / 3 단계</p>
        <ol className="resolver-steps">
          {step === 1 && (
            <li>
              <b>발주 원문 확인</b>
              <p className="resolver-original">
                {item.sources?.find((s) => s.field === "product")?.text ||
                  item.raw ||
                  "상품명 없음"}
              </p>
              <p>
                {item.recognitionReason ||
                  item.issues.join(" / ") ||
                  "직원이 원문과 실제 상품을 확인하세요."}
              </p>
            </li>
          )}
          {step === 2 && (
            <li>
              <b>실제 등록 후보 검토</b>
              {representativeGuidance && representativeCandidate && (
                <div className="family-help">
                  <p>직원이 등록한 모델군의 대표모델: <strong>{representativeGuidance.productName}</strong></p>
                  <p>대표모델은 자동 확정되지 않습니다. 실제 발주서와 비교한 후 직원이 선택하세요.</p>
                  <button type="button" onClick={() => {
                    setChosen(representativeCandidate);
                    setVariant(representativeCandidate.variants[0].id);
                    setUseRepresentativeModel(true);
                  }}>
                    대표모델 {representativeGuidance.productName} 선택
                  </button>
                </div>
              )}
              <div className="resolver-candidates">
                {candidates.map((p, n) => (
                  <button
                    key={p.id}
                    aria-pressed={chosen?.id === p.id}
                    onClick={() => {
                      setChosen(p);
                      setVariant(p.variants.length === 1 ? p.variants[0].id : "");
                      setUseRepresentativeModel(false);
                    }}
                  >
                    <b>{internalModel(p.name)}</b>
                    <span title={p.subtitle || p.name}>{p.subtitle || p.category}</span>
                    <small>{colorLabel(p.variants[0]?.color ?? "")}</small>
                    {selectionHistory(
                      state,
                      order.clientId,
                      item.sources?.find((s) => s.field === "product")?.text || item.raw,
                    )
                      .filter((h) => h.productId === p.id)
                      .map((h) => (
                        <small key={h.variantId}>
                          과거 '{item.sources?.find((s) => s.field === "product")?.text || item.raw}
                          '가 {internalModel(p.name)}로 확인되었던 거래 {h.count}건
                        </small>
                      ))}
                    {item.match?.kind === "CONFLICT" && n === 0 ? " / 정확한 SKU 우선 후보" : ""}
                  </button>
                ))}
              </div>
              <button onClick={() => setSearch(true)}>다른 등록 상품 검색</button>
              {!candidates.length && (
                <p>적절한 후보가 없습니다. 등록된 상품을 검색하거나 원문의 상품 정보를 확인하세요.</p>
              )}
            </li>
          )}
          {step === 3 && (
            <li>
              <b>선택한 상품 기억하기</b>
              <label className="check">
                <input
                  type="radio"
                  name="issue-scope"
                  checked={scope === "client"}
                  onChange={() => setScope("client")}
                />{" "}
                이 거래처의 별칭으로 저장
              </label>
              <label className="check">
                <input
                  type="radio"
                  name="issue-scope"
                  checked={scope === "once"}
                  onChange={() => setScope("once")}
                />{" "}
                이번 주문에만 적용
              </label>
              <label className="check">
                <input
                  type="radio"
                  name="issue-scope"
                  checked={scope === "common"}
                  onChange={() => setScope("common")}
                />
                공통 별칭으로 저장
              </label>
              <p className="muted">
                선택한 상품과 상품 링크가 복사용 계좌 안내 메시지에 자동으로 포함됩니다.
              </p>
              {chosenIsRepresentative && (
                <label className="check">
                  <input type="checkbox" checked={useRepresentativeModel}
                    onChange={e => setUseRepresentativeModel(e.target.checked)} />
                  이번 주문은 직원이 선택한 대표모델 {representativeGuidance!.productName}로 처리하고 거래처에 통보
                </label>
              )}
              {uncertain && !(useRepresentativeModel && chosenIsRepresentative) && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />{" "}
                  원문 또는 실제 고객 회신으로 이 모델임을 확인했습니다
                </label>
              )}
              {uncertain && !(useRepresentativeModel && chosenIsRepresentative) && !confirmed && (
                <p>
                  모델 적용 후 실제 상품 링크를 포함한 고객 확인 요청을 추가합니다. 고객 확인 전에는
                  단계 진행을 막습니다.
                </p>
              )}
              <label className="field">
                <span>확정 색상 / 옵션</span>
                <select
                  aria-label="확정 색상 / 옵션"
                  value={variant}
                  onChange={(e) => setVariant(e.target.value)}
                >
                  <option value="">등록 옵션 선택</option>
                  {chosen?.variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {colorLabel(v.color)} {v.option}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          )}
        </ol>
        <div className="resolver-actions">
          <button type="button" disabled={busy} onClick={closeDraft}>닫기</button>
          {step === 3 && (
            <button
              className="primary"
              disabled={!chosen || !variant || busy}
              onClick={async () => {
                if (!chosen) return;
                setBusy(true);
                try {
                  const applyRepresentative = useRepresentativeModel && chosenIsRepresentative;
                  const result = await nativeResolveProduct(
                    state,
                    order,
                    recipient.id,
                    item.id,
                    chosen.id,
                    applyRepresentative ? "once" : scope,
                    !applyRepresentative && uncertain && !confirmed,
                    variant,
                    applyRepresentative ? representativeGuidance?.groupId : undefined,
                  );
                  await onApply(result.state, result.order);
                  onClose();
                } catch (e) {
                  onNotice(String(e), "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              선택 상품 적용
            </button>
          )}
          <button disabled={step === 1} onClick={() => setStep(step - 1)}>
            이전
          </button>
          {step < 3 && (
            <button disabled={step === 2 && !chosen} onClick={() => setStep(step + 1)}>
              다음
            </button>
          )}
        </div>
      </Modal>
      {search && (
        <ProductSearchDialog
          state={state}
          clientId={order.clientId}
          onChoose={(p) => {
            setChosen(p);
            setVariant(p.variants.length === 1 ? p.variants[0].id : "");
            setUseRepresentativeModel(false);
            setSearch(false);
          }}
          onClose={() => setSearch(false)}
        />
      )}
    </>
  );
}
