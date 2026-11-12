import type ExcelJS from "exceljs";
import { normalizeColor, validateProduct } from "./domain";
import { registeredProducts } from "./product-models";
import type { Catalog, Product, State, Variant, Price } from "./types";

export const PRODUCT_SYNC_HEADERS = [
  "__상품ID", "신규등록키", "상품명", "상품설명", "신규 모델코드",
  "상품군", "출고구분", "카테고리 ID 경로", "브랜드 ID",
  "규격", "판매 단위", "기본 색상", "거래 상태", "__보관 상태",
] as const;
export const OPTION_SYNC_HEADERS = [
  "__상품ID", "신규등록키", "__가격기록ID", "색상", "공식 원본 구성(읽기 전용)",
  "도매가", "반도매가", "소매가", "__가격 원본", "__공식 사이트 옵션 ID",
] as const;

const FORMAT = "BANDO-HUB-PRODUCTS-V2";
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 20000;
const EMPTY = "[비우기]";
const identity = (p: Product) =>
  (p.catalog ?? "BANDOSTAND") + "|" + p.name.normalize("NFKC").trim().toLowerCase() +
  "|" + normalizeColor(p.defaultColor);
const isArchived = (p: Product) => !!(p.deletedAt || p.supersededBy);
const displayGroup = (group: Catalog | undefined) => group === "BANDOMALL" ? "반도몰" : "반도스탠드";
const groupValue = (text: string): Catalog => {
  if (text === "반도몰" || text === "BANDOMALL") return "BANDOMALL";
  if (text === "반도스탠드" || text === "BANDOSTAND") return "BANDOSTAND";
  throw Error("상품군은 반도스탠드 또는 반도몰이어야 합니다.");
};
const parsePrice = (raw: string, previous: Price): Price => {
  if (raw === "") return previous;
  if (raw === EMPTY || raw === "삭제") return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)) throw Error("가격은 0 이상의 정수, 공란 또는 [비우기]로 입력하세요.");
  const price = Number(raw.replaceAll(",", ""));
  if (!Number.isSafeInteger(price) || price < 0) throw Error("가격 범위를 벗어났습니다.");
  return price;
};
const textValue = (cell: ExcelJS.Cell): string => {
  const value = cell.value;
  if (cell.isMerged || cell.type === 6 ||
      (typeof value === "object" && value !== null && "formula" in value)) {
    throw Error("병합된 셀이나 수식은 허용되지 않습니다.");
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("text" in value) return String(value.text ?? "").trim();
    if ("richText" in value) return value.richText.map((part) => part.text).join("").trim();
    throw Error("문자 또는 숫자 셀을 사용하세요.");
  }
  return String(value).trim();
};
const optional = (raw: string, previous = "") => raw === EMPTY ? "" : raw === "" ? previous : raw;
const yesNo = (raw: string, previous: boolean) => {
  if (!raw) return previous;
  if (["사용", "예", "Y"].includes(raw)) return true;
  if (["중지", "아니오", "N"].includes(raw)) return false;
  throw Error("상태는 사용 또는 중지로 입력하세요.");
};
const labelPrice = (value: Price) => value === null ? "" : value;
const rowProduct = (p: Product) => [
  p.id, "", p.name, p.subtitle ?? "", "", displayGroup(p.catalog),
  p.origin === "STORE" ? "매장" : "공장", (p.categories ?? []).join(" / "),
  p.brandId ?? "", p.specification ?? "", p.sellingUnit ?? "",
  p.defaultColor, p.active ? "사용" : "중지",
  isArchived(p) ? "보관" : "정상",
];
const rowOption = (p: Product, v: Variant) => [
  p.id, "", v.id, v.color, v.option ?? "", labelPrice(v.wholesale),
  labelPrice(v.semi), labelPrice(v.retail), v.source, v.siteOptionId ?? "",
];

export type ProductRowStatus = "ADD" | "UPDATE" | "UNCHANGED" | "HOLD" | "ERROR";
export interface ProductSyncRow {
  sheet: "상품 목록" | "상품별 가격";
  row: number;
  id: string;
  name: string;
  status: ProductRowStatus;
  changes: string[];
  errors: string[];
}
export interface ProductSyncPreview {
  revision: number;
  products: Product[];
  rows: ProductSyncRow[];
  missingProducts: number;
  missingOptions: number;
  createdProducts: number;
  updatedProducts: number;
  createdOptions: number;
  updatedOptions: number;
}
export interface WorkbookSource {
  revision: number;
  products: { row: number; cells: string[] }[];
  options: { row: number; cells: string[] }[];
}

export async function exportProductSyncWorkbook(state: State): Promise<number[]> {
  const Excel = (await import("exceljs")).default;
  const book = new Excel.Workbook();
  const products = book.addWorksheet("상품 목록");
  products.addRow([...PRODUCT_SYNC_HEADERS]);
  const options = book.addWorksheet("상품별 가격");
  options.addRow([...OPTION_SYNC_HEADERS]);
  for (const p of state.products) {
    products.addRow(rowProduct(p));
    for (const v of p.variants) options.addRow(rowOption(p, v));
  }
  for (const [sheet, widths] of [
    [products, [38, 22, 35, 48, 23, 19, 12, 28, 39, 24, 18, 18, 14, 16]],
    [options, [38, 22, 40, 18, 27, 18, 18, 18, 16, 35]],
  ] as const) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: "A1", to: sheet === products ? "N1" : "J1" };
    widths.forEach((width, i) => {
      const column = sheet.getColumn(i + 1);
      column.width = width;
      column.numFmt = "@";
    });
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF303030" } };
  }
  const categories = book.addWorksheet("카테고리 및 브랜드 참고");
  categories.addRow(["구분", "식별자", "이름", "상위 카테고리 ID"]);
  for (const category of state.categories ?? []) {
    categories.addRow(["카테고리", category.id, category.name, category.parentId ?? ""]);
  }
  for (const brand of state.brands ?? []) categories.addRow(["브랜드", brand.id, brand.name, ""]);
  const guide = book.addWorksheet("작성 안내");
  [
    ["항목", "작성 규칙"],
    ["작업 방법", "현재 상품과 옵션 전체를 내보냅니다. 수정 후 업로드하면 변경된 행만 저장합니다."],
    ["기존 상품", "__상품ID와 기존 __옵션ID는 변경하지 마세요. 카페24 P코드는 모델코드가 아닙니다."],
    ["신규 상품", "__상품ID는 공란으로 두고 신규등록키, 상품명과 상품군을 입력하세요. 모델 표기는 상품명에 포함합니다."],
    ["신규 옵션", "판매 옵션 및 가격 시트에 동일한 신규등록키를 입력하세요. __옵션ID는 공란으로 둡니다."],
    ["기존 상품 옵션 추가", "기존 __상품ID를 넣고 __옵션ID를 비워 새 옵션 행을 추가합니다."],
    ["기존 코드 호환", "기존 2시트 양식의 모델코드 열은 사용하지 않으며 신규 양식에서 제거됩니다."],
    ["기본색 및 상태", "기본색은 등록된 옵션 중 한 개와 정확히 일치해야 합니다. 상태는 사용 또는 중지입니다."],
    ["홈페이지 미연결", "상품 등록과 수정에 홈페이지 상품번호나 카페24 옵션 ID는 필요하지 않습니다."],
    ["공란", "기존 필드는 값을 유지합니다. 선택 텍스트나 가격을 지울 때 [비우기]를 사용하세요."],
    ["원본 정보", "__가격 원본, __홈페이지 옵션 ID, __보관 상태는 편집하지 않습니다."],
    ["가격 변경", "옵션 ID가 일치해야 하며, 소매가 수동 수정은 공식 수집 가격과 별도로 기록합니다."],
    ["누락 행", "Excel에 없는 상품과 옵션은 삭제하거나 중지하지 않습니다."],
    ["보안", "수식/병합 셀, 중복 ID, 오래된 DB 버전, 미확인 등록키, 잘못된 참조는 저장할 수 없습니다."],
    ["실제 반영", "미리보기에서 확인 후 승인하면 백업을 생성하고 변경사항만 저장합니다."],
  ].forEach((row) => guide.addRow(row));
  guide.getColumn(1).width = 28;
  guide.getColumn(2).width = 105;
  const meta = book.addWorksheet("__반도허브_관리정보");
  meta.addRow(["종류", FORMAT]);
  meta.addRow(["DB버전", state.revision ?? 0]);
  meta.state = "veryHidden";
  return Array.from(new Uint8Array(await book.xlsx.writeBuffer() as ArrayBuffer));
}

function categoryEdit(state: State, p: Product, raw: string): void {
  if (!raw || raw === (p.categories ?? []).join(" / ")) return;
  const ids = raw.split("/").map((id) => id.trim()).filter(Boolean);
  const categories = ids.map((id) => state.categories?.find((c) => c.id === id));
  if (!ids.length || categories.some((c) => !c || c.active === false)) throw Error("등록되지 않은 카테고리 ID입니다.");
  for (let i = 1; i < ids.length; i++) {
    if (categories[i]?.parentId !== ids[i - 1]) throw Error("카테고리 계층이 일치하지 않습니다.");
  }
  const last = categories.at(-1);
  if (state.categories?.some((c) => c.parentId === last?.id && c.active !== false)) {
    throw Error("최하위 카테고리를 선택하세요.");
  }
  p.categories = ids;
  p.category = categories.map((c) => c!.name).join(" > ");
}
function brandEdit(state: State, p: Product, raw: string): void {
  if (!raw) return;
  const value = optional(raw, p.brandId ?? "");
  if (value && !state.brands?.some((b) => b.id === value)) {
    throw Error("등록되지 않은 브랜드 ID입니다.");
  }
  if (value) p.brandId = value;
  else delete p.brandId;
}

function updateExistingProduct(state: State, current: Product, cells: string[]): Product {
  const p = structuredClone(current);
  if (isArchived(p)) {
    if (JSON.stringify(rowProduct(p).map(String)) !== JSON.stringify(cells.map((x) => x))) {
      throw Error("보관된 상품은 Excel에서 변경할 수 없습니다.");
    }
    return p;
  }
  if (cells[1]) throw Error("기존 상품에는 신규등록키를 입력하지 마세요.");
  if (cells[4] && cells[4] !== EMPTY) throw Error("상품코드 열은 사용하지 않습니다. 코드를 제거한 새 양식을 사용하세요.");
  if (cells[5] && cells[5] !== displayGroup(p.catalog)) throw Error("기존 상품군 변경은 지원하지 않습니다.");
  if (cells[6] && cells[6] !== (p.origin === "STORE" ? "매장" : "공장")) {
    throw Error("기존 상품의 출고구분은 Excel에서 변경하지 않습니다.");
  }
  if (cells[13] && cells[13] !== "정상") throw Error("보관 상태는 변경할 수 없습니다.");
  p.name = optional(cells[2], p.name);
  delete p.code;
  delete p.manufacturerCode;
  delete p.modelCodes;
  delete p.originalCode;
  delete p.modelKey;
  if (cells[3]) {
    if (cells[3] === EMPTY) delete p.subtitle;
    else p.subtitle = cells[3];
  }
  if (!p.name) throw Error("상품명은 비울 수 없습니다.");
  categoryEdit(state, p, cells[7]);
  brandEdit(state, p, cells[8]);
  if (cells[9]) {
    if (cells[9] === EMPTY) delete p.specification;
    else p.specification = cells[9];
  }
  if (cells[10]) {
    if (cells[10] === EMPTY) delete p.sellingUnit;
    else p.sellingUnit = cells[10];
  }
  p.defaultColor = optional(cells[11], p.defaultColor);
  p.active = yesNo(cells[12], p.active);
  return p;
}
function createProduct(state: State, cells: string[]): Product {
  const at = new Date().toISOString();
  if (cells[4] && cells[4] !== EMPTY)
    throw Error("상품코드 입력은 지원하지 않습니다. 모델 표기는 상품명에 포함하세요.");
  const group = groupValue(cells[5]);
  const id = crypto.randomUUID();
  const p: Product = {
    id, name: cells[2],
    catalog: group, origin: group === "BANDOMALL" ? "STORE" : "FACTORY",
    category: "", defaultColor: cells[11], active: yesNo(cells[12], true),
    variants: [], createdAt: at, updatedAt: at, saleUnit: true,
    colorStatus: "KNOWN", verificationStatus: "REGISTERED",
  };
  if (!p.name.trim()) throw Error("신규 상품명을 입력하세요.");
  if (!p.defaultColor) throw Error("신규 상품의 기본 색상을 입력하세요.");
  if (cells[6] && cells[6] !== (p.origin === "STORE" ? "매장" : "공장")) {
    throw Error("상품군과 출고구분이 일치하지 않습니다.");
  }
  p.subtitle = optional(cells[3]);
  p.specification = optional(cells[9]);
  p.sellingUnit = optional(cells[10]);
  categoryEdit(state, p, cells[7]);
  brandEdit(state, p, cells[8]);
  p.familyKey = p.id;
  return p;
}
function newVariant(cells: string[]): Variant {
  const color = cells[3];
  if (!color || color === EMPTY) throw Error("독립 상품의 색상을 입력하세요. 색상 구분이 없으면 단일로 입력하세요.");
  if (cells[8] || cells[9] || cells[4]) throw Error("신규 상품의 가격 기록에는 옵션명이나 외부 식별자를 직접 입력하지 않습니다. 구분 정보는 상품명에 기재하세요.");
  return {
    id: crypto.randomUUID(), color, option: "",
    wholesale: parsePrice(cells[5], null),
    semi: parsePrice(cells[6], null),
    retail: parsePrice(cells[7], null),
    source: "MANUAL", url: "",
  };
}
function editVariant(original: Variant, cells: string[], p: Product): Variant {
  if (cells[8] && cells[8] !== original.source) throw Error("가격 원본은 변경할 수 없습니다.");
  if (cells[9] && cells[9] !== (original.siteOptionId ?? "")) throw Error("공식 사이트 식별자는 변경할 수 없습니다.");
  const v = structuredClone(original);
  v.color = optional(cells[3], v.color);
  if (cells[4] && cells[4] !== (original.option ?? "")) {
    throw Error("공식 원본 구성 표기는 수정할 수 없습니다. 상품 구분은 상품명에서 수정하세요.");
  }
  const at = new Date().toISOString();
  for (const [index, field] of [[5, "wholesale"], [6, "semi"], [7, "retail"]] as const) {
    const next = parsePrice(cells[index], v[field]);
    if (v[field] !== next) {
      p.priceHistory ??= [];
      p.priceHistory.push({
        at, field: v.id + "." + field, before: v[field], after: next,
        source: "MANUAL_EXCEL",
      });
      v[field] = next;
      if (field === "retail") v.source = "MANUAL";
    }
  }
  return v;
}

export function previewProductSyncRows(state: State, source: WorkbookSource): ProductSyncPreview {
  const revision = state.revision ?? 0;
  if (revision !== source.revision) throw Error("Excel 다운로드 후 상품 데이터가 변경되었습니다. 다시 내려받으세요.");
  if (source.products.length > MAX_ROWS || source.options.length > MAX_ROWS) throw Error("Excel은 시트당 20,000행까지 지원합니다.");
  const next = structuredClone(state.products);
  const rows: ProductSyncRow[] = [];
  const seenProducts = new Set<string>();
  const seenOptions = new Set<string>();
  const keys = new Map<string, string>();
  const blocked = new Set<string>();
  const originalOptions = new Set(state.products.flatMap((p) => p.variants.map((v) => p.id + "|" + v.id)));
  let createdProducts = 0, createdOptions = 0, updatedProducts = 0, updatedOptions = 0;
  const addRow = (sheet: ProductSyncRow["sheet"], row: number, id: string,
    name: string, status: ProductRowStatus, changes: string[] = [], errors: string[] = []) =>
    rows.push({ sheet, row, id, name, status, changes, errors });

  for (const { row, cells } of source.products) {
    if (!cells.some(Boolean)) continue;
    const id = cells[0], key = cells[1], locator = id || "new:" + key;
    try {
      if (!!id === !!key) throw Error("기존 상품 ID 또는 신규등록키 중 하나만 입력하세요.");
      if (seenProducts.has(locator)) throw Error("상품 ID 또는 신규등록키가 중복되었습니다.");
      seenProducts.add(locator);
      const old = id ? state.products.find((p) => p.id === id) : undefined;
      if (id && !old) throw Error("존재하지 않는 상품 ID입니다. 기존 ID를 수정하지 마세요.");
      if (key && !/^[\w가-힣-]{1,60}$/.test(key)) throw Error("신규등록키에는 공백 없이 문자, 숫자, 밑줄, 하이픈만 입력하세요.");
      const candidate = old ? updateExistingProduct(state, old, cells) : createProduct(state, cells);
      const idx = next.findIndex((p) => p.id === candidate.id);
      if (idx >= 0) next[idx] = candidate;
      else next.push(candidate);
      if (key) keys.set(key, candidate.id);
      const changed = !old || JSON.stringify(rowProduct(old)) !== JSON.stringify(rowProduct(candidate));
      const status: ProductRowStatus = !old ? "ADD" : changed ? "UPDATE" : "UNCHANGED";
      if (status === "ADD") createdProducts++;
      if (status === "UPDATE") updatedProducts++;
      addRow("상품 목록", row, candidate.id, candidate.name, status,
        !old ? ["신규 상품 등록"] : changed ? ["상품 정보 수정"] : []);
    } catch (error) {
      blocked.add(locator);
      addRow("상품 목록", row, locator, cells[2], "ERROR", [],
        [error instanceof Error ? error.message : String(error)]);
    }
  }
  for (const { row, cells } of source.options) {
    if (!cells.some(Boolean)) continue;
    const id = cells[0], key = cells[1], optionId = cells[2];
    const locator = id || "new:" + key;
    try {
      if (!!id === !!key || blocked.has(locator)) throw Error("옵션의 상품 ID 또는 신규등록키가 잘못되었습니다.");
      const productId = id || keys.get(key);
      if (!productId) throw Error("옵션이 연결될 상품 행을 찾지 못했습니다.");
      const product = next.find((p) => p.id === productId)!;
      if (!product) throw Error("상품 ID가 존재하지 않습니다.");
      if (isArchived(product)) {
        const archivedOption = optionId && state.products.find((p) => p.id === productId)
          ?.variants.find((v) => v.id === optionId);
        if (!archivedOption || JSON.stringify(rowOption(product, archivedOption).map(String)) !==
          JSON.stringify(cells.map(String))) {
          throw Error("보관된 상품과 옵션은 Excel에서 수정할 수 없습니다.");
        }
        addRow("상품별 가격", row, productId + "|" + optionId,
          product.name + " / " + archivedOption.color, "UNCHANGED");
        seenOptions.add(productId + "|" + optionId);
        continue;
      }
      const keyId = productId + "|" + (optionId || "new:" + normalizeColor(cells[3]) + "|" + cells[4]);
      if (seenOptions.has(keyId)) throw Error("옵션 행이 중복되었습니다.");
      seenOptions.add(keyId);
      const original = optionId ? state.products.find((p) => p.id === productId)
        ?.variants.find((v) => v.id === optionId) : undefined;
      if (optionId && !original) throw Error("옵션 ID가 존재하지 않습니다. 기존 옵션 ID를 변경하지 마세요.");
      if (key && optionId) throw Error("새 상품은 옵션 ID를 비워야 합니다.");
      if (!original && product.variants.length !== 0) throw Error("기존 상품에 두 번째 가격 구성은 추가할 수 없습니다. 별도 상품을 등록하세요.");
      const candidate = original ? editVariant(original, cells, product) : newVariant(cells);
      const at = product.variants.findIndex((v) => v.id === candidate.id);
      if (at >= 0) product.variants[at] = candidate;
      else product.variants.push(candidate);
      const changed = !original || JSON.stringify(original) !== JSON.stringify(candidate);
      if (changed) product.updatedAt = new Date().toISOString();
      if (!original) createdOptions++;
      else if (changed) updatedOptions++;
      addRow("상품별 가격", row, productId + "|" + candidate.id,
        product.name + " / " + candidate.color, !original ? "ADD" : changed ? "UPDATE" : "UNCHANGED",
        !original ? ["신규 옵션 등록"] : changed ? ["옵션 또는 가격 수정"] : []);
    } catch (error) {
      addRow("상품별 가격", row, locator + "|" + optionId, cells[3], "ERROR", [],
        [error instanceof Error ? error.message : String(error)]);
    }
  }
  for (const product of next) {
    const original = state.products.find((p) => p.id === product.id);
    if (original && JSON.stringify(original) === JSON.stringify(product)) continue;
    try {
      if (product.variants.length !== 1) throw Error("독립 상품에는 가격 기록이 정확히 하나 있어야 합니다.");
      const optionKeys = product.variants.map((v) => normalizeColor(v.color) + "|" + (v.option ?? "").trim().toLowerCase());
      if (new Set(optionKeys).size !== optionKeys.length) throw Error("색상과 옵션명 조합이 중복되었습니다.");
      if (!product.variants.some((v) => normalizeColor(v.color) === normalizeColor(product.defaultColor))) {
        throw Error("기본 색상에 해당하는 판매 옵션이 없습니다.");
      }
      for (const v of product.variants) {
        if (!v.color || ![v.wholesale, v.semi, v.retail].every((n) =>
          n === null || Number.isSafeInteger(n) && n >= 0)) throw Error("옵션 색상 또는 가격을 확인하세요.");
      }
      if (!original) {
        const duplicates = next.filter((p) =>
          p.id !== product.id && !isArchived(p) && identity(p) === identity(product) && p.name.trim() === product.name.trim());
        if (duplicates.length) throw Error("같은 상품명과 판매 구성을 가진 기존 상품이 있습니다.");
        validateProduct(product, registeredProducts(state.products));
      }
      product.saleUnit = true;
      product.updatedAt = new Date().toISOString();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rows.push({
        sheet: "상품 목록", row: source.products.find((x) => x.cells[0] === product.id ||
          (x.cells[1] && keys.get(x.cells[1]) === product.id))?.row ?? 0,
        id: product.id, name: product.name,
        status: /같은 상품명|중복 상품|판매 구성/.test(message) ? "HOLD" : "ERROR",
        changes: [], errors: [message],
      });
    }
  }
  const missingProducts = state.products.filter((p) => !seenProducts.has(p.id)).length;
  const missingOptions = [...originalOptions].filter((k) => !seenOptions.has(k)).length;
  return { revision, products: next, rows, missingProducts, missingOptions,
    createdProducts, updatedProducts, createdOptions, updatedOptions };
}

export async function previewProductSyncWorkbook(state: State, file: File): Promise<ProductSyncPreview> {
  if (!/\.xlsx$/i.test(file.name) || file.size > MAX_BYTES || file.size <= 0) {
    throw Error("20MB 이하의 .xlsx 상품 전체 목록을 선택하세요.");
  }
  const Excel = (await import("exceljs")).default;
  const book = new Excel.Workbook();
  await book.xlsx.load(new Uint8Array(await file.arrayBuffer()) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const products = book.getWorksheet("상품 목록");
  const options = book.getWorksheet("상품별 가격");
  const meta = book.getWorksheet("__반도허브_관리정보");
  if (!products || !options || !meta || textValue(meta.getCell("B1")) !== FORMAT) {
    throw Error("반도허브에서 내려받은 상품 전체 목록 Excel만 업로드할 수 있습니다.");
  }
  const revision = Number(textValue(meta.getCell("B2")));
  if (!Number.isSafeInteger(revision) || revision < 0) throw Error("Excel DB 버전이 올바르지 않습니다.");
  for (const [sheet, headers] of [[products, PRODUCT_SYNC_HEADERS], [options, OPTION_SYNC_HEADERS]] as const) {
    for (const [index, header] of headers.entries()) {
      if (textValue(sheet.getRow(1).getCell(index + 1)) !== header) {
        throw Error("Excel 열 이름 또는 순서가 다릅니다: " + header);
      }
    }
    if (sheet.rowCount > MAX_ROWS + 1) throw Error("시트당 최대 20,000행만 업로드할 수 있습니다.");
  }
  const read = (sheet: ExcelJS.Worksheet, count: number) => {
    const rows: { row: number; cells: string[] }[] = [];
    for (let row = 2; row <= sheet.rowCount; row++) {
      const cells: string[] = [];
      for (let col = 1; col <= count; col++) {
        const cell = sheet.getRow(row).getCell(col);
        if ((col === 1 || col === 3) && typeof cell.value === "number") {
          throw Error(row + "행: 내부 ID는 텍스트로 입력해야 합니다.");
        }
        cells.push(textValue(cell));
      }
      rows.push({ row, cells });
    }
    return rows;
  };
  return previewProductSyncRows(state, {
    revision, products: read(products, PRODUCT_SYNC_HEADERS.length),
    options: read(options, OPTION_SYNC_HEADERS.length),
  });
}

export function applyProductSyncWorkbook(state: State, preview: ProductSyncPreview): {
  next: State; createdProducts: number; updatedProducts: number;
  createdOptions: number; updatedOptions: number;
} {
  if ((state.revision ?? 0) !== preview.revision) throw Error("검토 후 데이터가 변경되었습니다. 파일을 다시 검증하세요.");
  if (preview.rows.some((r) => r.status === "ERROR" || r.status === "HOLD")) {
    throw Error("상품 Excel에 오류나 중복 의심 항목이 있습니다. 변경사항을 저장하지 않습니다.");
  }
  const next = structuredClone(state);
  // This patch only replaces explicitly modified product entries. Unlisted
  // products and options are still present in preview.products.
  next.products = structuredClone(preview.products);
  return { next, createdProducts: preview.createdProducts, updatedProducts: preview.updatedProducts,
    createdOptions: preview.createdOptions, updatedOptions: preview.updatedOptions };
}
