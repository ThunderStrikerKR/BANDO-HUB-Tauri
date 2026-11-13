import { useEffect, useMemo, useRef, useState } from "react";
import { confirmDiscardDraft } from "./shared/editor-flow";
import { Modal } from "./ui";
import { itemFromProduct } from "./domain";
import { businessCoreCall } from "./tauri-bridge";
import { productModelNames } from "./product-name-match";
import { useNativeProductIds } from "./native-catalog-queries";
import type { Client, Item, Product, State } from "./types";

function money(value: number | null): string {
  return value === null ? "가격 확인 필요" : value.toLocaleString("ko-KR") + "원";
}

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
  const [catalogPrices, setCatalogPrices] = useState<Record<string, number | null>>({});
  const [priceError, setPriceError] = useState("");
  const [pricePending, setPricePending] = useState(false);
  const priceRequest = useRef(0);
  const selectedPriceRequest = useRef(0);
  const [imageCache, setImageCache] = useState<Record<string, string | null>>({});
  const [invalidImage, setInvalidImage] = useState<string | null>(null);

  const product = state.products.find((product) => product.id === draft.productId);
  const changed = draft.productId !== item.productId || draft.variantId !== item.variantId;
  const closeDraft = () => void confirmDiscardDraft("상품 상세 수정", changed, onClose);

  const {products: matchedProducts, error: searchError} = useNativeProductIds(
    state, "search_products", {
      query, clientId: client.id, excludeDemo: true,
    }, [query, client.id],
  );
  // Stable result identity prevents duplicate price lookups on every render.
  const results = useMemo(() => matchedProducts.slice(0, 100), [matchedProducts]);

  const clientQuoteSignature = JSON.stringify(client);
  useEffect(() => {
    const request = ++priceRequest.current;
    const eligible = results.filter((candidate) =>
      candidate.variants.length === 1 && !candidate.requiresOption);
    setCatalogPrices({});
    setPriceError("");
    if (!eligible.length) return;
    void businessCoreCall<{ prices: Array<number | null> }>(
      "rules", "resolve_unit_prices", {
        quotes: eligible.map((candidate) => ({
          product: candidate, variantId: candidate.variants[0].id,
        })),
        client,
      },
    ).then(({ prices }) => {
      if (request !== priceRequest.current) return;
      if (prices.length !== eligible.length)
        throw Error("상품 가격 조회 결과 수가 일치하지 않습니다.");
      setCatalogPrices(Object.fromEntries(
        eligible.map((candidate, index) => [candidate.id, prices[index]]),
      ));
    }).catch((error) => {
      if (request !== priceRequest.current) return;
      setPriceError("Rust 가격 조회 실패: " +
        (error instanceof Error ? error.message : String(error)));
    });
    return () => {
      if (request === priceRequest.current) priceRequest.current++;
    };
  }, [results, clientQuoteSignature]);

  useEffect(() => () => { selectedPriceRequest.current++; }, []);

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
    if (locked || pricePending) return;
    if (candidate.variants.length !== 1 || candidate.requiresOption) {
      setSelectionError(candidate.requiresOption
        ? "상품 구성이 미확정입니다. 등록된 독립 상품을 선택하세요."
        : "가격 기록이 여러 개입니다. 상품 데이터를 확인하세요.");
      return;
    }
    setSelectionError("");
    if (candidate.id === item.productId &&
        candidate.variants[0].id === item.variantId) {
      selectedPriceRequest.current++;
      setDraft(structuredClone(item));
      return;
    }
    const request = ++selectedPriceRequest.current;
    setPricePending(true);
    void businessCoreCall<{ unitPrice: number | null }>(
      "rules", "resolve_unit_price", {
        product: candidate, variantId: candidate.variants[0].id, client,
      },
    ).then(({ unitPrice }) => {
      if (request !== selectedPriceRequest.current) return;
      const next = itemFromProduct(candidate, client,
        candidate.variants[0].color, item.quantity,
        candidate.variants[0].id, unitPrice);
      setDraft({
        ...next, id: item.id, raw: item.raw, sources: item.sources,
        quantity: item.quantity, quantityConfirmed: item.quantityConfirmed,
      });
    }).catch((error) => {
      if (request === selectedPriceRequest.current)
        setSelectionError("Rust 가격 조회 실패: " +
          (error instanceof Error ? error.message : String(error)));
    }).finally(() => {
      if (request === selectedPriceRequest.current) setPricePending(false);
    });
  };

  const apply = () => {
    if (pricePending || locked || !changed || !draft.productId || !draft.variantId ||
        !Number.isSafeInteger(item.quantity) || (item.quantity ?? 0) < 1) return;
    const next = { ...draft, manuallyConfirmed: true };
    delete next.quantityApproval;
    onApply(next);
    onClose();
  };

  return (
    <Modal
      title="상품 상세 수정"
      draft={draft}
      onClose={closeDraft}
      className="order-item-editor-modal"
    >
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
            {priceError && <p className="order-item-edit-error" role="alert">{priceError}</p>}
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
                    {candidate.variants.length === 1 &&
                      Object.hasOwn(catalogPrices, candidate.id)
                      ? money(catalogPrices[candidate.id])
                      : "가격 확인 중"}
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
          <button type="button" onClick={closeDraft}>닫기</button>
          <button
            type="button"
            className="primary"
            disabled={pricePending || locked || !changed || !draft.productId || !draft.variantId ||
              !Number.isSafeInteger(item.quantity) || (item.quantity ?? 0) < 1}
            onClick={apply}
          >
            적용
          </button>
        </footer>
    </Modal>
  );
}
