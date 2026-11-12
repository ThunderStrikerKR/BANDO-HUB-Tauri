import type ExcelJS from "exceljs";
import { categoryPath } from "./category-tree";
import { catalogFromCategory, withCatalogRoots } from "./category-roots";
import { normalizeColor, validProductUrl, validateProduct } from "./domain";
import { productKey, registeredProducts } from "./product-models";
import { registryIdentity, registryKey } from "./product-registry";
import type { RegistrationBatch, RegistrationRow } from "./product-registry";
import type { Catalog, Product, State } from "./types";

/** A row is one actual selling configuration. Existing prices are never overwritten. */
export const REGISTRATION_HEADERS = [
  "최종 등록명", "브랜드", "색상", "구성 구분", "규격",
  "판매 단위", "상품군", "카테고리 경로", "도매가", "반도매가",
  "소매가", "상품 링크", "비고",
] as const;
const LEGACY_REGISTRATION_HEADERS = [
  REGISTRATION_HEADERS[0], "제조사 모델코드", ...REGISTRATION_HEADERS.slice(1),
] as const;
export interface RegistrationWorkbookPreview {
  fingerprint: string;
  revision: number;
  rows: RegistrationRow[];
}
const MAX_ROWS = 2000;
const MAX_BYTES = 20 * 1024 * 1024;

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("text" in value) return String(value.text ?? "").trim();
    if ("richText" in value) return value.richText.map((item) => item.text).join("").trim();
    return "";
  }
  return String(value).trim();
}
function catalogValue(value: string): Catalog | undefined {
  if (value === "반도스탠드") return "BANDOSTAND";
  if (value === "반도몰") return "BANDOMALL";
  return undefined;
}
function priceValue(raw: string): number | null {
  if (!raw) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)) throw Error("가격은 0 이상의 원 단위 정수로 입력하세요.");
  const amount = Number(raw.replaceAll(",", ""));
  if (!Number.isSafeInteger(amount) || amount < 0) throw Error("가격이 허용 범위를 벗어났습니다.");
  return amount === 0 ? null : amount;
}
function matchingCategory(state: State, raw: string, catalog: Catalog) {
  const all = withCatalogRoots(state.categories);
  const requested = raw.split(/\s*\/\s*|\s*>\s*/).filter(Boolean).join(" / ");
  const candidates = all.filter((item) =>
    categoryPath(all, item.id).map((part) => part.name).join(" / ") === requested &&
    catalogFromCategory(all, item.id) === catalog &&
    !all.some((child) => child.parentId === item.id) && item.active !== false
  );
  return candidates.length === 1 ? categoryPath(all, candidates[0].id) : undefined;
}
function existingMatches(state: State, product: Product): string[] {
  const variant = product.variants[0];
  return state.products.filter((p) => {
    if ((p.catalog ?? "BANDOSTAND") !== product.catalog) return false;
    // Full sale configuration name differentiates independent products that share a model and color.
    if (registryKey(p.name) !== registryKey(product.name)) return false;
    if (product.registrationIdentity && p.registrationIdentity === product.registrationIdentity) return true;
    if (registryKey(p.specification ?? "") !== registryKey(product.specification ?? "")) return false;
    if (registryKey(p.sellingUnit ?? "개") !== registryKey(product.sellingUnit ?? "개")) return false;
    return p.variants.some((v) =>
      normalizeColor(v.color) === normalizeColor(variant.color) &&
      registryKey(v.option ?? "") === registryKey(variant.option ?? "")
    );
  }).map((p) => p.id);
}
export async function exportRegistrationTemplate(state: State): Promise<number[]> {
  const excelJs = (await import("exceljs")).default;
  const wb = new excelJs.Workbook();
  const sheet = wb.addWorksheet("상품 등록");
  sheet.addRow([...REGISTRATION_HEADERS]);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: "M1" };
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF303030" } };
  const widths = [34, 20, 15, 19, 21, 13, 17, 55, 14, 14, 14, 48, 36];
  sheet.columns.forEach((column, i) => {
    column.width = widths[i];
    if (i >= 8 && i <= 10) column.numFmt = "#,##0";
  });
  for (let row = 2; row <= 500; row++) {
    sheet.getCell(row, 7).dataValidation = {
      type: "list", allowBlank: false, formulae: ['"반도스탠드,반도몰"'],
      showErrorMessage: true, error: "반도스탠드 또는 반도몰을 선택하세요.",
    };
  }
  const guide = wb.addWorksheet("작성 안내");
  [
    ["항목", "작성 기준"],
    ["작성 단위", "실제 판매 가능한 완성 상품(모델, 색상, 규격, 포함 구성) 하나당 한 행. 구분 요소는 최종 등록명에도 기재"],
    ["상품군", "반도스탠드 또는 반도몰 중 하나를 정확히 선택"],
    ["카테고리 경로", "카테고리 경로 목록 시트의 최하위 전체 경로를 그대로 입력"],
    ["도매가 / 반도매가 / 소매가", "공란 또는 0은 미등록. 기존 가격은 덮어쓰지 않음"],
    ["중복 또는 미확인 항목", "미리보기에서 중복 또는 보류로 표시하며 자동 등록하지 않음"],
    ["상품 링크", "반도스탠드 또는 반도몰 공식 상품 상세페이지 URL만 허용"],
    ["수식 및 병합 셀", "허용하지 않음"],
  ].forEach((row) => guide.addRow(row));
  guide.getColumn(1).width = 38;
  guide.getColumn(2).width = 85;
  const paths = wb.addWorksheet("카테고리 경로 목록");
  paths.addRow(["상품군", "카테고리 경로"]);
  const all = withCatalogRoots(state.categories);
  for (const c of all) {
    const catalog = catalogFromCategory(all, c.id);
    if (!catalog || all.some((child) => child.parentId === c.id) || c.active === false) continue;
    paths.addRow([
      catalog === "BANDOSTAND" ? "반도스탠드" : "반도몰",
      categoryPath(all, c.id).map((item) => item.name).join(" / "),
    ]);
  }
  paths.getColumn(1).width = 20;
  paths.getColumn(2).width = 70;
  const output = await wb.xlsx.writeBuffer();
  return Array.from(new Uint8Array(output as ArrayBuffer));
}
export async function previewRegistrationWorkbook(state: State, file: File): Promise<RegistrationWorkbookPreview> {
  if (!/\.xlsx$/i.test(file.name)) throw Error(".xlsx 상품 등록 양식만 업로드할 수 있습니다.");
  if (file.size > MAX_BYTES) throw Error("20MB 이하의 등록 양식을 선택하세요.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const excelJs = (await import("exceljs")).default;
  const wb = new excelJs.Workbook();
  await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const sheet = wb.getWorksheet("상품 등록");
  if (!sheet) throw Error("반도허브 등록 양식의 '상품 등록' 시트가 없습니다.");
  const legacy = cellText(sheet.getRow(1).getCell(2)) === "제조사 모델코드";
  const sourceHeaders = legacy ? LEGACY_REGISTRATION_HEADERS : REGISTRATION_HEADERS;
  sourceHeaders.forEach((header, index) => {
    if (cellText(sheet.getRow(1).getCell(index + 1)) !== header) {
      throw Error("상품 등록 양식의 열 이름 또는 순서가 다릅니다: " + header);
    }
  });
  if (sheet.rowCount > MAX_ROWS + 1) throw Error("한 번에 최대 2,000행까지 등록할 수 있습니다.");
  const rows: RegistrationRow[] = [];
  const seen = new Map<string, number>();
  const prior: Product[] = [...state.products];
  for (let rowNo = 2; rowNo <= sheet.rowCount; rowNo++) {
    const sourceCells = sourceHeaders.map((_,i)=>sheet.getRow(rowNo).getCell(i+1));
    const sourceData = sourceCells.map(cellText);
    const cells = legacy ? sourceCells.filter((_,i)=>i!==1) : sourceCells;
    const data = legacy ? sourceData.filter((_,i)=>i!==1) : sourceData;
    if (!data.some(Boolean)) continue;
    const values: Record<string, string> = {};
    REGISTRATION_HEADERS.forEach((header, index) => { values[header] = data[index]; });
    const errors: string[] = [], holds: string[] = [];
    if (cells.some((cell) => cell.isMerged ||
      (typeof cell.value === "object" && cell.value !== null && "formula" in cell.value))) {
      errors.push("병합 셀과 수식은 허용하지 않습니다.");
    }
    const name = values["최종 등록명"];
    if (!name) errors.push("최종 등록명을 입력하세요.");
    const configuration = values["구성 구분"].trim();
    if (configuration && !registryKey(name).includes(registryKey(configuration))) {
      holds.push("구성 구분 정보는 별도 옵션이 아니라 최종 등록명에 포함해야 합니다.");
    }
    if (!values["판매 단위"]) errors.push("판매 단위를 입력하세요.");
    const catalog = catalogValue(values["상품군"]);
    if (!catalog) errors.push("상품군을 반도스탠드 또는 반도몰로 지정하세요.");
    const category = catalog ? matchingCategory(state, values["카테고리 경로"], catalog) : undefined;
    if (!category) holds.push("카테고리 맵의 최하위 분류 경로를 확인하세요.");
    const brandName = values["브랜드"];
    const brands = (state.brands ?? []).filter((brand) =>
      [brand.name, brand.korean, ...brand.aliases].some((term) =>
        registryKey(term) === registryKey(brandName)));
    if (brandName && brands.length !== 1) holds.push("브랜드 등록 정보가 모호하거나 없습니다.");
    const prices: (number | null)[] = [];
    for (const header of ["도매가", "반도매가", "소매가"]) {
      try { prices.push(priceValue(values[header])); }
      catch (error) {
        errors.push(header + ": " + String(error instanceof Error ? error.message : error));
        prices.push(null);
      }
    }
    const url = values["상품 링크"];
    if (url && !validProductUrl(url)) errors.push("반도스탠드 / 반도몰 공식 상품 링크만 허용됩니다.");
    const color = normalizeColor(values["색상"] || "단일");
    const identity = (catalog ?? "UNKNOWN") + "|" +
      registryIdentity({ ...values, "색상": color }) + "|" + registryKey(name);
    const at = new Date().toISOString(), id = crypto.randomUUID();
    const product: Product | undefined = name && catalog && category && !errors.length ? {
      id, name, catalog,
      origin: catalog === "BANDOSTAND" ? "FACTORY" : "STORE",
      brandId: brands[0]?.id,
      category: category.map((c) => c.name).join(" > "),
      categories: category.map((c) => c.id),
      specification: values["규격"] || undefined,
      sellingUnit: values["판매 단위"],
      saleUnit: true, registrationIdentity: identity,
      verificationStatus: "REGISTERED",
      familyKey: id,
      defaultColor: color, colorStatus: color === "단일" ? "NOT_REQUIRED" : "KNOWN",
      active: true,
      variants: [{
        id: crypto.randomUUID(), color, option: values["구성 구분"],
        wholesale: prices[0], semi: prices[1], retail: prices[2], url, source: "MANUAL",
      }],
      createdAt: at, updatedAt: at,
    } : undefined;
    let duplicateIds: string[] = [];
    if (product) {
      duplicateIds = existingMatches({ ...state, products: prior }, product);
      // A verified duplicate remains a DUPLICATE in the review, not a
      // generic ERROR emitted by the product validator for the same record.
      // Independently malformed fields still take priority as ERROR.
      if (!duplicateIds.length) {
        try { validateProduct(product, registeredProducts(prior)); }
        catch (error) { errors.push(String(error instanceof Error ? error.message : error)); }
      }
    }
    const earlier = seen.get(identity);
    if (earlier !== undefined) holds.push(String(earlier) + "행과 같은 판매 구성입니다.");
    else seen.set(identity, rowNo);
    const status: RegistrationRow["status"] = errors.length ? "ERROR" :
      duplicateIds.length ? "DUPLICATE" : holds.length ? "HOLD" : "READY";
    rows.push({ row: rowNo, values, identity, status, errors: [...errors, ...holds],
      duplicateIds, product: status === "READY" ? product : undefined });
    if (product && status === "READY") prior.push(product);
  }
  if (!rows.length) throw Error("등록할 상품 행이 없습니다.");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const fingerprint = Array.from(new Uint8Array(digest)).map((n) => n.toString(16).padStart(2, "0")).join("");
  return { fingerprint, revision: state.revision ?? 0, rows };
}
export function prepareRegistrationCommit(state: State, preview: RegistrationWorkbookPreview, actor: string) {
  if ((state.revision ?? 0) !== preview.revision) throw Error("상품 데이터가 변경되었습니다. 등록 파일을 다시 검증하세요.");
  const ready = preview.rows.filter((row) => row.status === "READY" && row.product);
  if (!ready.length) throw Error("등록 가능한 상품이 없습니다.");
  const next: State = structuredClone(state);
  const createdIds: string[] = [];
  for (const row of ready) {
    const product = structuredClone(row.product!);
    if (existingMatches(next, product).length) {
      throw Error(String(row.row) + "행: 중복 상품이 발견됐습니다. 다시 검증하세요.");
    }
    validateProduct(product, registeredProducts(next.products));
    if ((next.deletedProductKeys ?? []).includes(productKey(product))) {
      throw Error(String(row.row) + "행: 삭제된 상품은 재등록하지 않습니다.");
    }
    next.products.push(product);
    createdIds.push(product.id);
  }
  const batch: RegistrationBatch = {
    id: crypto.randomUUID(), fingerprint: preview.fingerprint,
    at: new Date().toISOString(), actor,
    rows: preview.rows.map(({ product: _product, ...row }) => row),
    createdIds,
  };
  next.registrationBatches = [...(next.registrationBatches ?? []), batch];
  return { next, batch, created: createdIds.length, skipped: preview.rows.length - createdIds.length };
}
export async function exportRegistrationResults(batch: RegistrationBatch): Promise<number[]> {
  const excelJs = (await import("exceljs")).default;
  const wb = new excelJs.Workbook();
  const sheet = wb.addWorksheet("등록 결과");
  sheet.addRow(["행", ...REGISTRATION_HEADERS, "결과", "사유", "등록 상품 ID"]);
  let created = 0;
  for (const item of batch.rows) {
    const id = item.status === "READY" ? batch.createdIds[created++] ?? "" : "";
    sheet.addRow([item.row, ...REGISTRATION_HEADERS.map((h) => item.values[h] ?? ""),
      { READY: "등록 완료", ERROR: "오류", HOLD: "보류", DUPLICATE: "중복" }[item.status],
      item.errors.join(" / ") || item.duplicateIds.join(", "), id]);
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.columns.forEach((column, i) => { column.width = i === 0 ? 9 : i === 16 ? 40 : 23; });
  const output = await wb.xlsx.writeBuffer();
  return Array.from(new Uint8Array(output as ArrayBuffer));
}
