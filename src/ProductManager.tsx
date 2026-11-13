import { ColorGuidanceManager } from "./ColorGuidanceManager";
import { CategoryManager } from "./CategoryManager";
import { categoryPath } from "./category-tree";
import { catalogFromCategory, withCatalogRoots } from "./category-roots";
import { BrandCombobox, ProductCategoryPicker } from "./ProductDetailComponents";
import { SALE_STATES } from "./sale-status";
import { useEffect, useMemo, useState } from "react";
import { AliasManager } from "./AliasManager";
import { ClassificationFilters, RegistrySettings } from "./Classification";
import { confirmAction } from "./dialogs";
import { uid } from "./domain";
import { businessCoreCall } from "./tauri-bridge";
import { PriceCell } from "./PriceCell";
import {
  colorLabel,
  registeredProducts,
  sortProducts,
  variantLabel,
} from "./product-models";
import { useNativeProductIds } from "./native-catalog-queries";
import { ProductImports } from "./ProductImports";
import { ProductSyncWorkbookTools } from "./ProductSyncWorkbookTools";
import { optimizeProductImage } from "./product-image-preprocess";
import { RegistrationManager } from "./RegistrationManager";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import { sameProductEditor } from "./shared/meaningful-changes";
import { requestEditorLeave, requestPageLeave, usePageLeaveGuard } from "./shared/page-leave";

import type { Product, State, Variant } from "./types";
import { Field, Modal, MoneyInput, clone } from "./ui";
import { HelpTooltip } from "./ui/HelpTooltip";
import { EmptyState, PageHeading } from "./ui/PageHeading";
import { ManagementTable } from "./ui/ManagementTable";
import { ManagementSearch } from "./ui/ManagementSearch";
export function ProductManager({
  state,
  onSave,
  onRefresh,
  onNotice,
}: {
  state: State;
  onSave: (state: State) => Promise<void>;
  onRefresh: (committed?: State) => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy: savingView, run: runSave } = useAsyncTask(onNotice);
  const [category, setCategory] = useState(""),
    [brand, setBrand] = useState("");
  const [search, setSearch] = useState(""),
    [missing, setMissing] = useState(false),
    [edit, setEdit] = useState<Product>(),
    [originalEdit, setOriginalEdit] = useState<Product>(),
    [section, setSection] = useState("상품 목록"),
    [adding, setAdding] = useState(false),
    [excelOpen, setExcelOpen] = useState(false),
    [priceMode, setPriceMode] = useState(false),
    [detailPriceMode, setDetailPriceMode] = useState(false),
    [categoryPicker, setCategoryPicker] = useState(false);
  const editDirty = !!edit && !!originalEdit && !sameProductEditor(edit, originalEdit);
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
  const classified = useNativeProductIds(
    state, "classified_products", {category, brand}, [category, brand],
  );
  const classifiedIds = useMemo(
    () => new Set(classified.products.map((p) => p.id)),
    [classified.products],
  );
  const products = sortProducts(
    state.products.filter((p) => !p.deletedAt && !p.supersededBy),
  ).filter(
    (p) =>
      p.catalog !== "DEMO" &&
      !p.variants.some((v) => v.source === "DEMO") &&
      classifiedIds.has(p.id) &&
      (p.name + " " + (p.subtitle ?? ""))
        .toLowerCase()
        .replace(/\s/g, "")
        .includes(search.toLowerCase().replace(/\s/g, "")) &&
      (!missing || p.variants.some((v) => !v.wholesale || !v.semi || !v.retail)),
  );
  const create = () => {
    setDetailPriceMode(false);
    setCategoryPicker(false);
    const at = new Date().toISOString();
    const fresh: Product = {
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
    };
    setEdit(fresh);
    setOriginalEdit(clone(fresh));
  };
  const save = async (): Promise<boolean> => {
    if (!edit) return true;
    const result = await runSave(async () => {
      // The native reducer owns normalization, legacy modelKey semantics,
      // category-root reconciliation and the final candidate validation.
      const { state: next } = await businessCoreCall<{ state: State }>(
        "catalog_clients", "upsert_product_from_editor", {
          state, product: edit, updatedAt: new Date().toISOString(),
        },
      );
      await onSave(next);
      setEdit(undefined);
      setOriginalEdit(undefined);
      onNotice("상품 상세 정보를 저장했습니다.", "success");
    });
    return result.ok;
  };
  usePageLeaveGuard({
    label: "상품",
    hasChanges: () => editDirty,
    busy: () => savingView,
    save,
    discard: () => { setEdit(undefined); setOriginalEdit(undefined); setCategoryPicker(false); },
  });
  const closeDetail = async () => {
    if (!edit || savingView) return;
    if (editDirty) {
      const leave = await requestEditorLeave({
        label: "상품",
        hasChanges: () => editDirty,
        save,
        discard: () => { setEdit(undefined); setOriginalEdit(undefined); setCategoryPicker(false); },
      }, (message) => onNotice(message, "error"));
      if (!leave.proceed) return;
    }
    setEdit(undefined);
    setOriginalEdit(undefined);
    setCategoryPicker(false);
  };
  const chooseSection = async (next: string) => {
    if (next === section) return;
    const leave = await requestPageLeave((message) => onNotice(message, "error"));
    if (!leave.proceed) return;
    setSection(next);
    setSearch("");
  };
  const openDetail = (p: Product) => {
    setDetailPriceMode(false);
    setCategoryPicker(false);
    setEdit(clone(p));
    setOriginalEdit(clone(p));
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
      const { state: next } = await businessCoreCall<{ state: State }>(
        "catalog_clients", "archive_product", {
          state, productId: p.id, at: new Date().toISOString(),
        },
      );
      await onSave(next);
      setEdit(undefined);
      setOriginalEdit(undefined);
      onNotice("상품을 삭제하고 과거 기록은 보존했습니다.");
    } catch (e) {
      onNotice(String(e), "error");
    }
  };
  return (
    <div className="fixed-manager">
      <PageHeading title="상품 관리" />
      <nav className="product-subnav management-tabbar" aria-label="상품 관리 메뉴">
        {[
          "상품 목록",
          "카테고리 관리",
          "모델군 관리",
          "별칭 관리",
          "브랜드 관리",
        ].map((label) => (
          <button
            key={label}
            aria-current={section === label ? "page" : undefined}
            onClick={() => void chooseSection(label)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className={"management-scroll" + (section === "상품 목록" && !adding && !excelOpen ? " product-list-workspace" : "")}>
        {section === "상품 목록" && (
          <>
            <div className="product-list-subheading">
              <div className="product-heading-help">
                  <h2>상품 가격표 <span>{products.length}개 상품</span></h2>
                  <HelpTooltip
                    title="상품 가격 수정"
                    purpose="등록된 상품의 도매가, 반도매가, 소매가를 확인하거나 변경하는 기능입니다."
                    when="판매 가격이 달라졌거나 잘못 등록한 가격을 고칠 때 사용합니다."
                    steps={["가격 수정 모드 켜기를 누릅니다.", "변경할 가격을 입력합니다.", "Enter를 눌러 해당 가격을 저장합니다.", "수정을 마치면 가격 수정 모드 종료를 누릅니다."]}
                    result="저장한 가격이 상품 가격표에 반영됩니다."
                    caution="수정 모드를 켜기 전에는 가격을 바꿀 수 없습니다. 가격이 비어 있으면 등록되지 않은 상태입니다."
                  />
              </div>
              <div className="management-section-actions" aria-label="상품 목록 작업">
                <button type="button" aria-expanded={excelOpen} onClick={() => setExcelOpen((open) => !open)}>Excel 관리</button>
                      <button
                        aria-pressed={priceMode}
                        className={priceMode ? "primary" : ""}
                        onClick={() => setPriceMode(!priceMode)}
                      >
                        {priceMode ? "가격 수정 모드 종료" : "가격 수정 모드 켜기"}
                      </button>
                      <button className="primary" onClick={() => setAdding(!adding)}>상품 추가</button>
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
            {excelOpen && <section className="card product-excel-panel">
              <h3>상품 Excel 관리 <HelpTooltip
                title="상품 Excel 관리"
                purpose="상품을 여러 개 수정하거나 새 상품을 한꺼번에 등록할 때 사용합니다."
                when="가격이나 상품 정보를 많이 변경해야 할 때 사용합니다."
                steps={["현재 상품 전체 Excel을 내려받거나 신규 등록 양식을 받습니다.", "Excel 파일에 상품 정보를 입력하거나 수정합니다.", "파일을 업로드하고 변경 내용을 확인합니다.", "오류가 없을 때 변경사항을 승인합니다."]}
                result="검토한 상품 정보만 저장됩니다."
                caution="색상이나 가방 포함 여부 등 판매 구성이 다르면 각각 별도의 상품으로 관리합니다."
              /> </h3>
              <ProductSyncWorkbookTools onSave={onSave} onRefresh={onRefresh} onNotice={onNotice} />
              <RegistrationManager state={state} onSave={onSave} onRefresh={onRefresh} onNotice={onNotice} />
            </section>}
            <section className="card product-prices">
              <div className="management-search-toolbar">
                <ManagementSearch label="상품 검색" placeholder="모델명 또는 상품명 검색"
                  value={search} onChange={setSearch}/>
              </div>
              <div className="manager-filters">
                <ClassificationFilters
                  state={state}
                  category={category}
                  brand={brand}
                  onChange={(nextCategory, nextBrand) => {
                    setCategory(nextCategory);
                    setBrand(nextBrand);
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
              <div className="price-table-scroll">
                <ManagementTable>
                  <thead>
                    <tr>
                      <th>상품명 / 상품설명</th>
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
                                  const committed = await window.bando!.setPrice(p.id, v.id, tier, n, expected);
                                  await onRefresh(committed);
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
                </ManagementTable>
                {!products.length && <EmptyState compact title={search || missing || category || brand ? "조건에 맞는 상품이 없습니다." : "등록된 상품이 없습니다."} />}
              </div>
            </section>
          </>
        )}
        {section === "카테고리 관리" && (
          <CategoryManager state={state} onSave={onSave} onNotice={onNotice}
            query={search} onQueryChange={setSearch} />
        )}
        {section === "모델군 관리" && <ColorGuidanceManager state={state} onRefresh={onRefresh}
          query={search} onQueryChange={setSearch} />}
        {section === "별칭 관리" && (
          <AliasManager state={state} onSave={onSave} onNotice={onNotice} />
        )}
        {section === "브랜드 관리" && (
          <RegistrySettings state={state} onSave={onSave} onNotice={onNotice} categories={false} />
        )}
        {edit && (
          <Modal
            draft={edit}
            dirty={editDirty}
            busy={savingView}
            className="product-detail-dialog"
            title={state.products.some((item) => item.id === edit.id) ? "상품 상세 관리" : "상품 등록"}
            onClose={() => void closeDetail()}
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
                        disabled={savingView}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          if (!file) return;
                          const editingId = edit.id;
                          void runSave(async () => {
                            const imageData = await optimizeProductImage(file);
                            setEdit((previous) => previous?.id === editingId
                              ? { ...previous, imageData, imageOverride: "MANUAL" }
                              : previous);
                          });
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
                    <span className="product-heading-help"><strong>판매 가격</strong><HelpTooltip title="상품 가격" purpose="이 상품을 거래처에 판매할 때 적용할 가격을 등록합니다." steps={["가격 수정을 눌러 입력을 시작합니다.", "도매가, 반도매가, 소매가를 각각 입력합니다.", "상품 상세 화면 아래의 변경사항 저장을 누릅니다."]} result="거래처 가격 등급에 맞는 금액으로 주문 금액을 계산할 수 있습니다." /></span>
                    <button type="button" disabled={edit.variants.length !== 1} onClick={() => setDetailPriceMode((open) => !open)}>
                      {detailPriceMode ? "가격 수정 잠금" : "가격 수정"}
                    </button>
                  </div>
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
                <Field label="상품명" help={{ purpose: "매장 직원과 공장 직원이 같은 상품을 정확히 구별할 수 있도록 이름을 정합니다.", steps: ["상품의 모델명과 판매 구성의 차이를 알 수 있도록 입력합니다.", "가방 포함 또는 미포함, 바퀴 포함 여부, 크기 등 주문에 중요한 차이를 빠뜨리지 않습니다.", "상품 정보를 저장합니다."], result: "입력한 상품명이 주문 확인과 발송 업무에 사용됩니다.", caution: "판매 구성이 다르면 옵션 하나로 합치지 않고 각각 별도 상품으로 등록합니다." }}>
                  <input value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })} />
                </Field>
                <Field label="상품설명" help={{ purpose: "매장 직원이 상품 특징을 기억하거나 상품을 구별할 때 참고할 내용을 남깁니다.", steps: ["직원에게 필요한 상품 특징이나 참고사항을 입력합니다.", "변경사항을 저장합니다."], result: "매장 상품 관리에서 상품 정보를 확인할 때 참고할 수 있습니다.", caution: "주문서와 공장에 전달해야 할 구성 정보는 상품설명이 아니라 상품명에 적습니다." }}>
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
              {edit.variants.length === 1 && (
                <div className="product-detail-wide-fields">
                  <Field label="상품 색상" help={{ purpose: "이 상품의 판매 색상을 기록해 다른 색상의 상품과 구별합니다.", steps: ["상품에 실제 색상 구분이 있다면 해당 색상을 입력합니다.", "색상 구분이 없는 상품은 단일로 입력합니다.", "변경사항을 저장합니다."], result: "주문 접수와 상품 검색에서 색상을 확인할 수 있습니다." }}>
                    <input
                      value={edit.variants[0].color}
                      placeholder="예: 블랙 / 색상 구분이 없으면 단일"
                      onChange={(event) => setEdit((old) => old ? {
                        ...old,
                        defaultColor: event.target.value,
                        variants: old.variants.map((v) => ({ ...v, color: event.target.value })),
                      } : old)}
                    />
                  </Field>
                </div>
              )}
              <details className="product-detail-advanced">
                <summary>고급 정보 / 홈페이지 연결 (선택) / 배송 그룹 / 변경 이력</summary>
                <Field label="배송 그룹" help={{ purpose: "같은 포장 기준으로 배송할 수 있는 상품을 묶어 운임을 관리합니다.", when: "이미 확인된 배송 그룹을 이 상품에 적용할 때 사용합니다.", steps: ["해당 상품이 속할 배송 그룹을 선택합니다.", "상품 정보를 저장합니다."], result: "주문에서 해당 그룹에 등록된 운임 기준을 참고할 수 있습니다.", caution: "포장 조건이 확인되지 않았다면 그룹을 임의로 선택하지 않습니다." }}>
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
                {edit.variants.length === 1 && (
                  <div className="product-detail-variant-extra">
                    <Field label="홈페이지 상품 연결" help={{ purpose: "공식 쇼핑몰의 상품 주소를 저장해 상품 정보를 빠르게 확인합니다.", steps: ["해당 상품의 공식 상세페이지 주소를 입력합니다.", "변경사항을 저장합니다."], result: "필요한 경우 상품 안내에 해당 주소를 사용할 수 있습니다.", caution: "이 주소를 입력해도 모든 주문 메시지에 자동으로 링크가 붙는 것은 아닙니다." }}>
                      <input
                        value={edit.variants[0].url}
                        onChange={(event) => setEdit({
                          ...edit,
                          variants: edit.variants.map((v, index) =>
                            index === 0 ? { ...v, url: event.target.value } : v),
                        })}
                      />
                    </Field>
                  </div>
                )}
                <p className="muted">홈페이지 연결 ID: {edit.siteRefs?.join(", ") || edit.siteId || "없음"}</p>
                {edit.priceHistory?.slice().reverse().map((history, index) => (
                  <p className="muted" key={index}>{history.at} / {history.field} / {String(history.before)} → {String(history.after)}</p>
                ))}
                <div className="product-risk">
                  <button className="danger" disabled={!state.products.some((p) => p.id === edit.id)} onClick={() => void remove(edit)}>상품 삭제</button>
                </div>
              </details>
            </div>
            <div className="product-detail-footer">
              <button type="button" disabled={savingView} onClick={() => void closeDetail()}>닫기</button>
              <button type="button" className="primary" disabled={savingView || (!editDirty && state.products.some((p) => p.id === edit.id))} onClick={() => void save()}>
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
