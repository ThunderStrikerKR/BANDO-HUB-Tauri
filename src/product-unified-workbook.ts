import type ExcelJS from "exceljs";
import type { Product, State } from "./types";
import {
  applyProductSyncWorkbook,
  previewProductSyncRows,
  type ProductSyncPreview,
  type ProductSyncRow,
  type WorkbookSource,
} from "./product-sync-workbook";

/** One independent product and exactly one protected price record per worksheet row.
 * Existing SQLite records retain their IDs. The legacy V2 workbook engine is
 * intentionally kept separate; old two-sheet files are never silently remapped.
 */
export const UNIFIED_PRODUCT_HEADERS = [
  "__상품ID", "신규등록키", "상품명", "상품설명", "색상",
  "도매가", "반도매가", "소매가",
  "상품군", "출고구분", "카테고리 ID 경로", "브랜드 ID",
  "규격", "판매 단위", "거래 상태", "__보관 상태",
  "__가격기록ID", "공식 원본 구성(읽기 전용)", "__가격 원본",
  "__공식 사이트 옵션 ID",
] as const;

const FORMAT = "BANDO-HUB-PRODUCTS-UNIFIED-V2";
const LEGACY_FORMAT = "BANDO-HUB-PRODUCTS-UNIFIED-V1";
const LEGACY_HEADERS = [...UNIFIED_PRODUCT_HEADERS.slice(0, 8),
  "신규 모델코드", ...UNIFIED_PRODUCT_HEADERS.slice(8)];
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 20_000;
const WIDTHS = [38, 22, 44, 50, 19, 17, 17, 17, 18, 13,
  32, 34, 22, 20, 15, 16, 38, 32, 19, 35] as const;

const value = (cell: ExcelJS.Cell): string => {
  const data = cell.value;
  if (cell.isMerged || cell.type === 6 ||
    (typeof data === "object" && data !== null && "formula" in data)) {
    throw Error("병합된 셀이나 수식은 허용되지 않습니다.");
  }
  if (data === null || data === undefined) return "";
  if (typeof data === "object") {
    if ("text" in data) return String(data.text ?? "").trim();
    if ("richText" in data) return data.richText.map((part) => part.text).join("").trim();
    throw Error("문자 또는 숫자 셀을 사용하세요.");
  }
  return String(data).trim();
};
const displayGroup = (p: Product) => p.catalog === "BANDOMALL" ? "반도몰" : "반도스탠드";
const rowForProduct = (p: Product) => {
  if (p.variants.length !== 1) {
    throw Error("독립 상품 규칙 위반: " + p.name + "의 가격 기록이 하나가 아닙니다.");
  }
  const v = p.variants[0];
  if (v.color !== p.defaultColor) {
    throw Error("상품 색상과 가격 기록 색상이 일치하지 않습니다: " + p.name);
  }
  return [
    p.id, "", p.name, p.subtitle ?? "", v.color,
    v.wholesale, v.semi, v.retail, displayGroup(p),
    p.origin === "STORE" ? "매장" : "공장", (p.categories ?? []).join(" / "),
    p.brandId ?? "", p.specification ?? "", p.sellingUnit ?? "",
    p.active === false ? "중지" : "사용",
    p.deletedAt || p.supersededBy ? "보관" : "정상",
    v.id, v.option ?? "", v.source, v.siteOptionId ?? "",
  ];
};

export async function exportUnifiedProductWorkbook(state: State): Promise<number[]> {
  const Excel = (await import("exceljs")).default;
  const book = new Excel.Workbook();
  const sheet = book.addWorksheet("상품 목록");
  sheet.addRow([...UNIFIED_PRODUCT_HEADERS]);
  for (const p of state.products) sheet.addRow(rowForProduct(p));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: "T1" };
  WIDTHS.forEach((width, index) => {
    const col = sheet.getColumn(index + 1);
    col.width = width;
    col.numFmt = index >= 5 && index <= 7 ? "#,##0" : "@";
  });
  const heading = sheet.getRow(1);
  heading.font = { bold: true, color: { argb: "FFFFFFFF" } };
  heading.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF303030" } };

  const categories = book.addWorksheet("카테고리 및 브랜드 참고");
  categories.addRow(["구분", "식별자", "이름", "상위 카테고리 ID"]);
  for (const c of state.categories ?? []) categories.addRow(["카테고리", c.id, c.name, c.parentId ?? ""]);
  for (const b of state.brands ?? []) categories.addRow(["브랜드", b.id, b.name, ""]);

  const guide = book.addWorksheet("작성 안내");
  [
    ["항목", "작성 규칙"],
    ["작업 방법", "독립 상품 1개가 한 행입니다. 상품명, 설명, 색상, 세 종류의 가격을 같은 행에서 수정하세요."],
    ["기존 상품", "__상품ID 및 __가격기록ID, 출고구분과 상품군을 변경하지 마세요."],
    ["신규 상품", "__상품ID와 __가격기록ID는 비우고 신규등록키, 상품명, 상품군, 색상을 입력하세요."],
    ["색상 구분 없음", "색상 칸에 '단일'로 입력하세요. 다른 색상이나 구성은 별도의 상품 행으로 등록하세요."],
    ["상품명과 설명", "상품명은 거래처, 매장, 공장 공통 표시입니다. 가방 포함 여부와 바퀴 구성 등은 미포함도 생략하지 말고 명시하세요. 설명은 매장 내부 참고입니다."],
    ["상품 식별", "상품명에 모델명, 색상 및 판매 구성을 기재하고 내부 상품 ID는 변경하지 않습니다."],
    ["가격", "도매가, 반도매가, 소매가는 각기 다른 독립 상품에 직접 입력합니다. 공란은 기존 값 유지, [비우기]는 값 제거입니다."],
    ["읽기 전용", "__상품ID, __가격기록ID, 공식 원본 구성, __가격 원본, __공식 사이트 옵션 ID, __보관 상태는 수정하지 마세요."],
    ["누락 행", "Excel에서 누락된 기존 상품은 삭제하거나 중지하지 않습니다."],
    ["검증", "수식, 병합 셀, 중복 ID, 미확인 신규등록키, 오래된 DB 버전과 잘못된 참조는 거부합니다."],
    ["반영", "미리보기 검토 및 명시적 승인 후 백업을 만들고 변경사항을 저장합니다."],
  ].forEach((row) => guide.addRow(row));
  guide.getColumn(1).width = 27;
  guide.getColumn(2).width = 118;

  const meta = book.addWorksheet("__반도허브_관리정보");
  meta.addRow(["종류", FORMAT]);
  meta.addRow(["DB버전", state.revision ?? 0]);
  meta.state = "veryHidden";
  return Array.from(new Uint8Array(await book.xlsx.writeBuffer() as ArrayBuffer));
}

/** Convert one human-facing Excel row to the legacy validated state-patch
 * engine's two internal records. These are not multiple purchasable options.
 */
const toValidatedRows = (row: number, values: string[]) => {
  // V1 import is explicit; V2 omits the obsolete model-code column.
  const c = values.length === 20
    ? [...values.slice(0, 8), "", ...values.slice(8)]
    : values;
  return {
  product: {
    row, cells: [c[0], c[1], c[2], c[3], c[8], c[9], c[10],
      c[11], c[12], c[13], c[14], c[4], c[15], c[16]],
  },
  price: {
    row, cells: [c[0], c[1], c[17], c[4], c[18], c[5], c[6],
      c[7], c[19], c[20]],
  },
  };
};

function consolidateRows(items: ProductSyncRow[]): ProductSyncRow[] {
  const rows = new Map<number, ProductSyncRow>();
  const priority = { UNCHANGED: 0, UPDATE: 1, ADD: 2, HOLD: 3, ERROR: 4 };
  for (const item of items) {
    const prior = rows.get(item.row);
    if (!prior) {
      rows.set(item.row, { ...item, sheet: "상품 목록",
        changes: [...item.changes], errors: [...item.errors] });
      continue;
    }
    if (priority[item.status] > priority[prior.status]) prior.status = item.status;
    if (item.name && item.sheet === "상품 목록") prior.name = item.name;
    prior.changes.push(...item.changes);
    prior.errors.push(...item.errors);
  }
  return [...rows.values()].sort((a, b) => a.row - b.row);
}

export function previewUnifiedProductRows(
  state: State,
  input: { revision: number; rows: { row: number; cells: string[] }[] },
): ProductSyncPreview {
  const products: WorkbookSource["products"] = [];
  const options: WorkbookSource["options"] = [];
  for (const { row, cells } of input.rows) {
    if (!cells.some(Boolean)) continue;
    const converted = toValidatedRows(row, cells);
    products.push(converted.product);
    options.push(converted.price);
  }
  const preview = previewProductSyncRows(state, {
    revision: input.revision, products, options,
  });
  const rows = consolidateRows(preview.rows);
  return {
    ...preview,
    rows,
    createdProducts: rows.filter((r) => r.status === "ADD").length,
    updatedProducts: rows.filter((r) => r.status === "UPDATE").length,
  };
}

export async function previewUnifiedProductWorkbook(
  state: State, file: File,
): Promise<ProductSyncPreview> {
  if (!/\.xlsx$/i.test(file.name) || file.size <= 0 || file.size > MAX_BYTES) {
    throw Error("20MB 이하의 .xlsx 상품 전체 목록을 선택하세요.");
  }
  const Excel = (await import("exceljs")).default;
  const book = new Excel.Workbook();
  await book.xlsx.load(new Uint8Array(await file.arrayBuffer()) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheet = book.getWorksheet("상품 목록");
  const meta = book.getWorksheet("__반도허브_관리정보");
  const format = meta ? value(meta.getCell("B1")) : "";
  if (!sheet || !meta || ![FORMAT, LEGACY_FORMAT].includes(format)) {
    throw Error("상품 Excel 형식이 다릅니다. 통합 상품 목록을 새로 다운로드하여 사용하세요.");
  }
  const headers = format === FORMAT ? UNIFIED_PRODUCT_HEADERS : LEGACY_HEADERS;
  const revision = Number(value(meta.getCell("B2")));
  if (!Number.isSafeInteger(revision) || revision < 0) throw Error("상품 Excel DB 버전이 잘못되었습니다.");
  for (const [index, header] of headers.entries()) {
    if (value(sheet.getRow(1).getCell(index + 1)) !== header) {
      throw Error("상품 Excel 열 이름 또는 순서가 다릅니다: " + header);
    }
  }
  if (sheet.rowCount > MAX_ROWS + 1) throw Error("상품 Excel은 20,000행까지 지원합니다.");
  const rows: { row: number; cells: string[] }[] = [];
  for (let number = 2; number <= sheet.rowCount; number++) {
    const cells: string[] = [];
    for (let index = 0; index < headers.length; index++) {
      const cell = sheet.getRow(number).getCell(index + 1);
      if ([0, 1, format === FORMAT ? 16 : 17].includes(index) && typeof cell.value === "number") {
        throw Error(number + "행의 ID는 텍스트로 입력해야 합니다.");
      }
      cells.push(value(cell));
    }
    rows.push({ row: number, cells });
  }
  return previewUnifiedProductRows(state, { revision, rows });
}

export const applyUnifiedProductWorkbook = applyProductSyncWorkbook;
