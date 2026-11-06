import { RepresentativeManager } from "./RepresentativeManager";
import { CategoryManager } from "./CategoryManager";
import { categoryPath } from "./category-tree";
import { catalogFromCategory, withCatalogRoots } from "./category-roots";
import { BrandCombobox, ProductCategoryPicker } from "./ProductDetailComponents";
import { SALE_STATES } from "./sale-status";
import { isRepresentative } from "./model-families";
import { useEffect, useMemo, useState } from "react";
import { AliasManager } from "./AliasManager";
import { ClassificationFilters, RegistrySettings } from "./Classification";
import { confirmAction } from "./dialogs";
import { normalizeColor, uid, validateProduct, won } from "./domain";
import { CatalogPanel } from "./ManagementUI";
import { ProductPriceWorkbookTools } from "./ProductPriceWorkbookTools";
import { PriceCell } from "./PriceCell";
import {
  colorLabel,
  normalizeModel,
  productKey,
  registeredProducts,
  sortProducts,
  variantLabel,
} from "./product-models";
import { classifiedProducts } from "./product-registry";
import { ProductImports } from "./ProductImports";
import { RegistrationManager } from "./RegistrationManager";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { Product, State, Variant } from "./types";
import { Field, Modal, MoneyInput, clone } from "./ui";
export function ProductManager({
  state,
  onSave,
  onRefresh,
  onNotice,
}: {
  state: State;
  onSave: (state: State) => Promise<void>;
  onRefresh: () => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy: savingView, run: runSave } = useAsyncTask(onNotice);
  const [major, setMajor] = useState(""),
    [minor, setMinor] = useState(""),
    [brand, setBrand] = useState("");
  const [search, setSearch] = useState(""),
    [missing, setMissing] = useState(false),
    [edit, setEdit] = useState<Product>(),
    [section, setSection] = useState("상품 목록"),
    [adding, setAdding] = useState(false),
    [priceMode, setPriceMode] = useState(false),
    [detailPriceMode, setDetailPriceMode] = useState(false),
    [categoryPicker, setCategoryPicker] = useState(false);
  const [localImage, setLocalImage] = useState<{ id: string; data: string }>();
  useEffect(() => {
    setLocalImage(undefined);
    if (!edit) return;
    const id = edit.id;
    let current = true;
    void window.bando
      ?.productImage?.(id)
      .then((image) => {
        if (current && image) setLocalImage({ id, data: image.data });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [edit?.id]);
  const detailImage = edit && (
    edit.imageOverride === "HIDDEN" ? undefined :
    edit.imageOverride === "MANUAL" ? edit.imageData :
    (localImage?.id === edit.id ? localImage.data : edit.imageData)
  );
  const classifiedIds = useMemo(
    () => new Set(classifiedProducts(state, major, minor, brand).map((p) => p.id)),
    [state.products, state.categories, major, minor, brand],
  );
  const products = sortProducts(
    state.products.filter((p) => !p.deletedAt && !p.supersededBy),
  ).filter(
    (p) =>
      p.catalog !== "DEMO" &&
      !p.variants.some((v) => v.source === "DEMO") &&
      classifiedIds.has(p.id) &&
      (p.name + " " + p.code + " " + p.subtitle)
        .toLowerCase()
        .replace(/\s/g, "")
        .includes(search.toLowerCase().replace(/\s/g, "")) &&
      (!missing || p.variants.some((v) => !v.wholesale || !v.semi || !v.retail)),
  );
  const create = () => {
    setDetailPriceMode(false);
    setCategoryPicker(false);
    const at = new Date().toISOString();
    setEdit({
      id: uid(),
      code: "",
      name: "",
      subtitle: "",
      category: "",
      catalog: "BANDOSTAND",
      origin: "FACTORY",
      defaultColor: "단일",
      active: true,
      saleUnit: true,
      colorStatus: "NOT_REQUIRED",
      variants: [
        {
          id: uid(),
          color: "단일",
          option: "",
          wholesale: null,
          semi: null,
          retail: null,
          url: "",
          source: "MANUAL",
        },
      ],
      createdAt: at,
      updatedAt: at,
    });
  };
  const save = async () => {
    if (!edit) return;
    await runSave(async () => {
      const p = clone(edit);
      p.code = normalizeModel(p.manufacturerCode?.trim() || p.code || p.name);
      p.name = normalizeModel(p.name || p.code);
      p.saleUnit = true;
      p.familyKey ??= p.registrationIdentity
        ? p.id
        : (p.catalog ?? "BANDOSTAND") + "|" + p.code.replace(/\s/g, "").toUpperCase();
      p.modelKey = productKey(p);
      p.modelCodes = [p.code];
      p.variants = p.variants.map((v) => ({
        ...v,
        color: normalizeColor(v.color),
      }));
      p.defaultColor = normalizeColor(p.defaultColor);
      p.updatedAt = new Date().toISOString();
      if (p.categories?.length) {
        const rootCatalog = catalogFromCategory(withCatalogRoots(state.categories), p.categories.at(-1)!);
        if (rootCatalog) p.catalog = rootCatalog;
      }
      validateProduct(p, registeredProducts(state.products));
      const next = clone(state),
        index = next.products.findIndex((x) => x.id === p.id);
      if (index >= 0) next.products[index] = p;
      else next.products.push(p);
      await onSave(next);
      setEdit(undefined);
      onNotice("상품 상세 정보를 저장했습니다.", "success");
    });
  };
  const openDetail = (p: Product) => {
    setDetailPriceMode(false);
    setCategoryPicker(false);
    setEdit(clone(p));
  };
  const remove = async (p: Product) => {
    if (
      !(await confirmAction(
        p.name +
          "을 등록 상품에서 삭제할까요? 과거 주문과 가격 기록은 보존하며 홈페이지 재수집으로 자동 복원하지 않습니다.",
      ))
    )
      return;
    try {
      const next = clone(state);
      next.products.find((x) => x.id === p.id)!.deletedAt = new Date().toISOString();
      next.deletedProductKeys = [...new Set([...(next.deletedProductKeys ?? []), productKey(p)])];
      next.aliases = next.aliases.filter((a) => a.productId !== p.id);
      await onSave(next);
      setEdit(undefined);
      onNotice("상품을 삭제하고 과거 기록은 보존했습니다.");
    } catch (e) {
      onNotice(String(e), "error");
    }
  };
  return (
    <div className="fixed-manager">
      <nav className="product-subnav" aria-label="상품 관리 메뉴">
        {[
          "상품 목록",
          "카테고리 관리",
          "모델군 관리",
          "별칭 관리",
          "브랜드 관리",
          "상품 동기화",
        ].map((label) => (
          <button
            key={label}
            aria-current={section === label ? "page" : undefined}
            onClick={() => { setSection(label); setSearch(""); }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="management-search">
        <input
          aria-label="상품 검색"
          placeholder={section === "카테고리 관리" ? "카테고리 이름 또는 전체 경로 검색" : section === "모델군 관리" ? "모델 코드 또는 상품명 검색" : "모델명 또는 상품명 검색"}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="management-scroll">
        {section === "상품 목록" && (
          <>
            <div className="manager-bar">
              <div>
                <h2>
                  상품 가격표 <span>{products.length}개 모델</span>
                </h2>
                <small>
                  {priceMode
                    ? "가격 수정 중 / 0은 미등록 / Enter 저장 / Esc 취소 / Tab 다음 셀"
                    : "가격 잠금 / 수정하려면 가격 수정 모드를 켜세요."}
                </small>
              </div>
              <div className="actions">
                <button
                  aria-pressed={priceMode}
                  className={priceMode ? "primary" : ""}
                  onClick={() => setPriceMode(!priceMode)}
                >
                  {priceMode ? "가격 수정 모드 종료" : "가격 수정 모드 켜기"}
                </button>
                <RegistrationManager state={state} onSave={onSave} onRefresh={onRefresh} onNotice={onNotice} />
                <button onClick={() => setAdding(!adding)}>상품 추가</button>
              </div>
            </div>
            {adding && (
              <section className="card">
                <button className="primary" onClick={create}>
                  직접 등록
                </button>
                <ProductImports state={state} onSave={onSave} onRefresh={onRefresh} onNotice={onNotice} />
              </section>
            )}
            <section className="card product-prices">
              <div className="manager-filters">
                <ClassificationFilters
                  state={state}
                  major={major}
                  minor={minor}
                  brand={brand}
                  onChange={(a, b, c) => {
                    setMajor(a);
                    setMinor(b);
                    setBrand(c);
                  }}
                />
                <label className="check">
                  <input
                    type="checkbox"
                    checked={missing}
                    onChange={(e) => setMissing(e.target.checked)}
                  />{" "}
                  가격 미등록만
                </label>
              </div>
              <ProductPriceWorkbookTools state={state} onSave={onSave} onRefresh={onRefresh} onNotice={onNotice} locked={!priceMode} />
              <div className="price-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>상품명 / 부제</th>
                      <th>도매가</th>
                      <th>반도매가</th>
                      <th>소매가</th>
                      <th>상세</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.flatMap((p) =>
                      p.variants.map((v, index) => (
                        <tr key={v.id}>
                          <td>
                            <div className="product-title-line">
                              <b>
                                {p.name}{" "}
                                {isRepresentative(state, p) && (
                                  <small className="representative-badge">대표</small>
                                )}
                              </b>
                              <span>{p.subtitle}</span>
                              {p.colorStatus !== "NOT_REQUIRED" &&
                                !`${p.name} ${p.subtitle ?? ""}`.includes(colorLabel(v.color)) && (
                                  <span>{colorLabel(v.color)}</span>
                                )}
                            </div>
                          </td>
                          {(["wholesale", "semi", "retail"] as const).map((tier) => (
                            <td key={tier}>
                              <PriceCell
                                enabled={priceMode}
                                value={v[tier]}
                                label={`${p.name} ${variantLabel(v)} ${{ wholesale: "도매가", semi: "반도매가", retail: "소매가" }[tier]}`}
                                onSave={async (n, expected) => {
                                  await window.bando!.setPrice(p.id, v.id, tier, n, expected);
                                  await onRefresh();
                                }}
                              />
                            </td>
                          ))}
                          <td>
                            <button onClick={() => openDetail(p)}>상세 관리</button>
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
                {!products.length && <p className="empty">등록된 상품이 없습니다.</p>}
              </div>
            </section>
          </>
        )}
        {section === "카테고리 관리" && (
          <CategoryManager state={state} onSave={onSave} onNotice={onNotice} query={search} />
        )}
        {section === "모델군 관리" && <RepresentativeManager state={state} onSave={onSave} query={search} />}
        {section === "별칭 관리" && (
          <AliasManager state={state} onSave={onSave} onNotice={onNotice} />
        )}
        {section === "브랜드 관리" && (
          <RegistrySettings state={state} onSave={onSave} onNotice={onNotice} categories={false} />
        )}
        {section === "상품 동기화" && (
          <CatalogPanel state={state} onRefresh={onRefresh} onError={onNotice} />
        )}
        {edit && (
          <Modal
            draft={edit}
            busy={savingView}
            className="product-detail-dialog"
            title="상품 상세관리"
            onClose={() => { if (!savingView) { setEdit(undefined); setCategoryPicker(false); } }}
          >
            <div className="product-detail-body">
              <div className="product-detail-top">
                <div className="product-detail-image-column">
                  <div className="product-detail-image">
                    {detailImage ? <img src={detailImage} alt={edit.name} /> : <span>대표이미지 없음</span>}
                  </div>
                  <div className="product-detail-image-actions">
                    <label className="product-image-upload">
                      이미지 등록
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          if (!file) return;
                          if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
                            onNotice("이미지는 JPG, PNG, WEBP 형식이며 5MB 이하여야 합니다.", "error");
                            return;
                          }
                          const reader = new FileReader();
                          reader.onload = () => {
                            if (typeof reader.result === "string")
                              setEdit((prev) => prev ? { ...prev, imageData: reader.result as string, imageOverride: "MANUAL" } : prev);
                          };
                          reader.readAsDataURL(file);
                          event.currentTarget.value = "";
                        }}
                      />
                    </label>
                    <button type="button" onClick={() => setEdit({ ...edit, imageData: undefined, imageOverride: "HIDDEN" })}>
                      이미지 제거
                    </button>
                  </div>
                  <small>로컬에 저장된 이미지 사용</small>
                </div>
                <div className="product-detail-right-fields">
                  <div className="product-detail-fieldline">
                    <label htmlFor="product-detail-brand">제조사(브랜드)</label>
                    <BrandCombobox
                      key={edit.id}
                      brands={state.brands ?? []}
                      brandId={edit.brandId}
                      onChange={(brandId) => setEdit((prev) => prev ? { ...prev, brandId } : prev)}
                    />
                  </div>
                  <div className="product-detail-fieldline">
                    <label htmlFor="product-detail-status">판매 상태</label>
                    <select
                      id="product-detail-status"
                      value={!edit.saleStatus || edit.saleStatus === "판매 표시" ? edit.active === false ? "판매중지" : "판매중" : edit.saleStatus === "등록 대기" ? "판매준비중" : edit.saleStatus}
                      onChange={(event) => setEdit({ ...edit, saleStatus: event.target.value, active: true })}
                    >
                      {SALE_STATES.map((status) => <option key={status}>{status}</option>)}
                    </select>
                  </div>
                  <div className="product-detail-price-heading">
                    <strong>판매 가격</strong>
                    <button type="button" disabled={edit.variants.length !== 1} onClick={() => setDetailPriceMode((open) => !open)}>
                      {detailPriceMode ? "가격 수정 잠금" : "가격 수정"}
                    </button>
                  </div>
                  {edit.variants.length !== 1 && (
                    <small className="product-detail-multi-note">기존 상품에 옵션이 여러 개 있습니다. 세부 가격은 고급 정보에서 확인하세요.</small>
                  )}
                  {edit.variants[0] && (["wholesale", "semi", "retail"] as const).map((tier) => (
                    <div className="product-detail-fieldline" key={tier}>
                      <label htmlFor={"product-price-" + tier}>{({ wholesale: "도매가", semi: "반도매가", retail: "소매가" })[tier]}</label>
                      <div className="product-detail-money">
                        <fieldset disabled={!detailPriceMode || edit.variants.length !== 1}>
                          <MoneyInput
                            id={"product-price-" + tier}
                            placeholder="미등록"
                            label={({ wholesale: "도매가", semi: "반도매가", retail: "소매가" })[tier]}
                            value={edit.variants[0][tier]}
                            onChange={(amount) => setEdit((prev) => prev ? {
                              ...prev,
                              variants: prev.variants.map((v, i) => i === 0 ? { ...v, [tier]: amount } : v),
                            } : prev)}
                          />
                        </fieldset>
                        <span>원</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="product-detail-wide-fields">
                <Field label="상품명 / 모델명">
                  <input value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })} />
                </Field>
                <Field label="상품 설명">
                  <input value={edit.subtitle ?? ""} onChange={(event) => setEdit({ ...edit, subtitle: event.target.value })} />
                </Field>
                <div className="field">
                  <label className="field-label">카테고리</label>
                  <div className="product-category-value">
                    <span title={edit.categories?.length ? categoryPath(withCatalogRoots(state.categories), edit.categories.at(-1)!).map((c) => c.name).join(" / ") : "미분류"}>
                      {edit.categories?.length ? categoryPath(withCatalogRoots(state.categories), edit.categories.at(-1)!).map((c) => c.name).join(" / ") : "미분류"}
                    </span>
                    <button type="button" onClick={() => setCategoryPicker(true)}>카테고리 변경</button>
                  </div>
                </div>
              </div>
              <details className="product-detail-advanced">
                <summary>고급 정보 / 공식 상품 URL / 배송 그룹 / 변경 이력</summary>
                <Field label="배송 그룹">
                  <select
                    value={edit.shippingGroupId ?? ""}
                    onChange={(event) => setEdit({ ...edit, shippingGroupId: event.target.value || undefined })}
                  >
                    <option value="">미지정</option>
                    {state.shipping?.groups.filter((g) => !g.deletedAt).map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </Field>
                {edit.variants.map((variant, index) => (
                  <div key={variant.id} className="product-detail-variant-extra">
                    <Field label={"공식 상세페이지 URL " + (index + 1)}>
                      <input
                        value={variant.url}
                        onChange={(event) => setEdit({ ...edit, variants: edit.variants.map((v) => v.id === variant.id ? { ...v, url: event.target.value } : v) })}
                      />
                    </Field>
                    {edit.variants.length > 1 && <p className="muted">{variantLabel(variant)}: 도매 {won(variant.wholesale)}, 반도매 {won(variant.semi)}, 소매 {won(variant.retail)}</p>}
                  </div>
                ))}
                <p className="muted">원래 모델: {edit.originalCode || "없음"} / 홈페이지 상품 ID: {edit.siteRefs?.join(", ") || edit.siteId || "없음"}</p>
                {edit.priceHistory?.slice().reverse().map((history, index) => (
                  <p className="muted" key={index}>{history.at} / {history.field} / {String(history.before)} → {String(history.after)}</p>
                ))}
                <div className="product-risk">
                  <button className="danger" disabled={!state.products.some((p) => p.id === edit.id)} onClick={() => void remove(edit)}>상품 삭제</button>
                </div>
              </details>
            </div>
            <div className="product-detail-footer">
              <button type="button" disabled={savingView} onClick={() => setEdit(undefined)}>취소</button>
              <button type="button" className="primary" disabled={savingView} onClick={() => void save()}>
                {savingView ? "저장 중" : "변경사항 저장"}
              </button>
            </div>
          </Modal>
        )}
        {edit && categoryPicker && (
          <ProductCategoryPicker
            categories={state.categories ?? []}
            onClose={() => setCategoryPicker(false)}
            onSelect={(id) => {
              const all = withCatalogRoots(state.categories);
              const catalog = catalogFromCategory(all, id);
              setEdit((prev) => prev ? {
                ...prev,
                categories: [id],
                category: categoryPath(all, id).map((c) => c.name).join(" > "),
                catalog: catalog ?? prev.catalog,
              } : prev);
              setCategoryPicker(false);
            }}
          />
        )}
      </div>
    </div>
  );
}
