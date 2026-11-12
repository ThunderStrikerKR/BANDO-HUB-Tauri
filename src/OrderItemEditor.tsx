import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { itemFromProduct, resolvePrice } from "./domain";
import { productModelNames } from "./product-name-match";
import { searchProducts } from "./product-search";
import { sameValue } from "./shared/draft";
import { usePendingChanges } from "./shared/pending-changes";
import type { Client, Item, Product, State } from "./types";

function money(value: number | null): string {
  return value === null ? "가격 확인 필요" : value.toLocaleString("ko-KR") + "원";
}

/**
 * Product correction overlays only the BANDO HUB work panels.
 * Native showModal() would make the KakaoTalk panel inert, so this editor
 * deliberately uses an in-workspace non-modal surface instead.
 */
export function OrderItemEditor({
  state,
  item,
  client,
  locked,
  onApply,
  onConfirm,
  onClose,
  onRemove,
}: {
  state: State;
  item: Item;
  client: Client;
  locked: boolean;
  onApply: (i: Item) => void;
  onConfirm: () => void;
  onClose: () => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState<Item>(() => structuredClone(item));
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const [query, setQuery] = useState(() => {
    const product = state.products.find((product) => product.id === item.productId);
    if (product) return productModelNames(product)[0] ?? product.name;
    const recognized = (item.name || item.raw).match(
      /(?:BD[\s-]*)?(?:\d{3}(?:-1)?|[A-Za-z]+(?:[\s-]+[A-Za-z]+)*[\s-]*\d+(?:-\d+)?)/i,
    );
    return (recognized?.[0] ?? item.name.split(" / ")[0]).trim();
  });
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [left, setLeft] = useState(0);
  const [imageCache, setImageCache] = useState<Record<string, string | null>>({});
  const [invalidImage, setInvalidImage] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const originalFocus = useRef<HTMLElement | null>(null);

  const product = state.products.find((product) => product.id === draft.productId);
  const changed = draft.productId !== item.productId || draft.variantId !== item.variantId;
  usePendingChanges(!sameValue(draft, item));

  const results = useMemo(
    () => searchProducts(state, query, client.id)
      .filter((candidate) =>
        candidate.catalog !== "DEMO" &&
        !candidate.variants.some((variant) => variant.source === "DEMO"))
      .slice(0, 100),
    [state, query, client.id],
  );

  useLayoutEffect(() => {
    const workspace = document.querySelector<HTMLElement>(".hub-live-workspace");
    const target = workspace ?? document.body;
    const kakao = workspace?.querySelector<HTMLElement>(".hub-slot-0");
    const scroll = workspace?.querySelector<HTMLElement>(".hub-workspace-scroll");

    const measure = () => {
      if (!workspace || !kakao || kakao.hidden || !kakao.getClientRects().length) {
        setLeft(0);
        return;
      }
      const width = Math.max(0,
        Math.ceil(kakao.getBoundingClientRect().right -
          workspace.getBoundingClientRect().left + 6));
      setLeft(Math.min(width, workspace.clientWidth));
    };

    originalFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setHost(target);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    if (kakao) observer.observe(kakao);
    scroll?.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      scroll?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      if (originalFocus.current?.isConnected)
        originalFocus.current.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    if (host) closeButton.current?.focus({ preventScroll: true });
  }, [host]);

  useEffect(() => {
    const current = product;
    if (!current || current.imageOverride === "HIDDEN" ||
        current.imageOverride === "MANUAL") return;
    let active = true;
    void window.bando?.productImage?.(current.id)
      .then((image) => {
        if (active) setImageCache((cache) => ({
          ...cache,
          [current.id]: image?.data ?? null,
        }));
      })
      .catch(() => {
        if (active) setImageCache((cache) => ({ ...cache, [current.id]: null }));
      });
    return () => { active = false; };
  }, [product?.id, product?.imageOverride]);

  useEffect(() => { setInvalidImage(null); }, [product?.id]);

  const image = !product || product.imageOverride === "HIDDEN" ? null
    : product.imageOverride === "MANUAL" ? product.imageData ?? null
    : imageCache[product.id] ?? product.imageData ?? null;
  const usableImage = image && image !== invalidImage ? image : null;

  const choose = (candidate: Product) => {
    if (locked) return;
    if (candidate.variants.length !== 1 || candidate.requiresOption) {
      setSelectionError(candidate.requiresOption
        ? "상품 구성이 미확정입니다. 등록된 독립 상품을 선택하세요."
        : "가격 기록이 여러 개입니다. 상품 데이터를 확인하세요.");
      return;
    }
    setSelectionError("");
    if (candidate.id === item.productId &&
        candidate.variants[0].id === item.variantId) {
      setDraft(structuredClone(item));
      return;
    }
    const next = itemFromProduct(candidate, client,
      candidate.variants[0].color, item.quantity, candidate.variants[0].id);
    setDraft({
      ...next,
      id: item.id,
      raw: item.raw,
      sources: item.sources,
      quantity: item.quantity,
      quantityConfirmed: item.quantityConfirmed,
    });
  };

  const apply = () => {
    if (locked || !changed || !draft.productId || !draft.variantId ||
        !Number.isSafeInteger(item.quantity) || (item.quantity ?? 0) < 1) return;
    const next = { ...draft, manuallyConfirmed: true };
    delete next.quantityApproval;
    onApply(next);
    onClose();
  };

  if (!host) return null;
  return createPortal(
    <div
      className={"order-item-edit-layer" + (host === document.body ? " order-item-edit-body-host" : "")}
      style={{ left: host === document.body ? 0 : left }}
    >
      <section
        className="order-item-edit-dialog"
        role="dialog"
        aria-modal="false"
        aria-label="상품 상세 수정"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="order-item-edit-header">
          <h2>상품 상세 수정</h2>
          <button ref={closeButton} type="button" onClick={onClose}>닫기 ×</button>
        </header>
        <div className="order-item-edit-content">
          <div className="order-item-edit-product">
            <div className="order-item-edit-photo">
              {usableImage ? (
                <img
                  src={usableImage}
                  alt={product?.name ?? "등록 상품"}
                  onError={() => setInvalidImage(usableImage)}
                />
              ) : (
                <span>상품 사진 없음</span>
              )}
            </div>
            <div className="order-item-edit-fields">
              <div>
                <span className="order-item-edit-label">상품명</span>
                <strong className="order-item-edit-name">
                  {product?.name ?? draft.name}
                </strong>
              </div>
              <div>
                <span className="order-item-edit-label">카테고리</span>
                <span>{product?.category ?? "등록 상품 미연결"}</span>
              </div>
              <div>
                <span className="order-item-edit-label">가격</span>
                <strong className="order-item-edit-price">{money(draft.unitPrice)}</strong>
              </div>
            </div>
          </div>

          <button
            type="button"
            className="order-item-edit-toggle"
            aria-expanded={searchOpen}
            aria-controls="order-item-edit-search"
            disabled={locked}
            onClick={() => setSearchOpen((expanded) => !expanded)}
          >
            {searchOpen ? "검색 접기" : "상품 변경"}
          </button>

          <div
            id="order-item-edit-search"
            className={"order-item-edit-search" + (searchOpen ? " open" : "")}
            hidden={!searchOpen}
          >
            <input
              type="search"
              aria-label="상품 검색"
              placeholder="브랜드 / 상품명 / 모델 / 별칭 검색"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {selectionError && <p className="order-item-edit-error" role="alert">{selectionError}</p>}
            <div className="order-item-edit-results" aria-label="등록 상품 검색 결과">
              {results.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className={"order-item-edit-candidate" +
                    (candidate.id === draft.productId ? " selected" : "")}
                  aria-pressed={candidate.id === draft.productId}
                  onClick={() => choose(candidate)}
                >
                  <span className="order-item-edit-radio" aria-hidden="true" />
                  <span className="order-item-edit-candidate-text">
                    <strong>{candidate.name}</strong>
                    <small>{candidate.category}</small>
                  </span>
                  <span className="order-item-edit-candidate-price">
                    {money(candidate.variants.length === 1
                      ? resolvePrice(candidate, candidate.variants[0].id, client)
                      : null)}
                  </span>
                </button>
              ))}
              {!results.length && (
                <p className="order-item-edit-empty">검색 결과가 없습니다.</p>
              )}
            </div>
          </div>
        </div>
        <footer className="order-item-edit-footer">
          {item.modelProposal?.required && (
            <button type="button" disabled={locked} onClick={onConfirm}>
              고객 확인 완료
            </button>
          )}
          <button type="button" className="danger" disabled={locked} onClick={onRemove}>
            삭제
          </button>
          <button type="button" onClick={onClose}>취소</button>
          <button
            type="button"
            className="primary"
            disabled={locked || !changed || !draft.productId || !draft.variantId ||
              !Number.isSafeInteger(item.quantity) || (item.quantity ?? 0) < 1}
            onClick={apply}
          >
            적용
          </button>
        </footer>
      </section>
    </div>,
    host,
  );
}
