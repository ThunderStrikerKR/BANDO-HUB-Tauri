import type ExcelJS from "exceljs";
import type { Client, State } from "./types";

export const CLIENT_HEADERS = [
  "__거래처ID", "거래처명", "송장 표시 상호", "주소", "우편번호",
  "전화번호", "휴대폰", "담당자", "연락처 메모", "가격등급", "결제방식",
  "운임 청구 제외", "부가세 기본 적용", "거래 상태",
  "거래처 별칭", "검색 식별자", "주 사용 계좌 ID", "보관 상태",
] as const;
export type ClientRowStatus = "ADD" | "UPDATE" | "UNCHANGED" | "HOLD" | "ERROR";
export interface ClientWorkbookRow {
  row: number;
  id: string;
  name: string;
  status: ClientRowStatus;
  changes: string[];
  errors: string[];
  client?: Client;
}
export interface ClientWorkbookPreview {
  revision: number;
  rows: ClientWorkbookRow[];
  missing: number;
}
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 20000;
const EMPTY = "[비우기]";
const tierText: Record<Client["tier"], string> = {
  wholesale: "도매", semi: "반도매", retail: "소매", special: "특수",
};
const paymentText = { PREPAID: "선입금", POSTPAID: "후불" } as const;
const normalize = (value: string) => value.replace(/\s+/g, "").toLocaleLowerCase();
const phoneKey = (value: string) => value.replace(/\D/g, "");

function workbookText(cell: ExcelJS.Cell): string {
  if (cell.isMerged || cell.type === 6 /* Formula */ ||
    (typeof cell.value === "object" && cell.value !== null && "formula" in cell.value)) {
    throw Error("수식이나 병합된 셀은 사용할 수 없습니다.");
  }
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("text" in value) return String(value.text ?? "").trim();
    if ("richText" in value) return value.richText.map((part) => part.text).join("").trim();
    throw Error("Excel 셀은 문자나 숫자로 입력하세요.");
  }
  return String(value).trim();
}
function optionalString(raw: string, before: string | undefined, isNew: boolean): string {
  if (raw === EMPTY) return "";
  if (raw === "" && !isNew) return before ?? "";
  return raw;
}
function tier(raw: string, before: Client["tier"], isNew: boolean): Client["tier"] {
  if (!raw) return before;
  const found = (Object.entries(tierText) as [Client["tier"], string][])
    .find(([key, value]) => raw === key || raw === value);
  if (!found) throw Error("가격등급은 도매, 반도매, 소매, 특수 중 선택하세요.");
  return found[0];
}
function payment(raw: string, before: Client["payment"]): Client["payment"] {
  if (!raw) return before;
  if (raw === "선입금" || raw === "PREPAID") return "PREPAID";
  if (raw === "후불" || raw === "POSTPAID") return "POSTPAID";
  throw Error("결제방식은 선입금 또는 후불이어야 합니다.");
}
function flag(raw: string, before: boolean): boolean {
  if (!raw) return before;
  if (["예", "Y", "TRUE", "true", "1", "적용", "거래중"].includes(raw)) return true;
  if (["아니오", "N", "FALSE", "false", "0", "미적용", "거래중지"].includes(raw)) return false;
  throw Error("예 또는 아니오로 입력하세요.");
}
const newClient = (): Client => ({
  id: crypto.randomUUID(), name: "", displayName: "", address: "", postcode: "",
  phone: "", mobile: "", person: "", contact: "", identifiers: "", shortNames: "",
  tier: "wholesale", payment: "PREPAID", shippingFeeExcluded: false,
  defaultApplyVat: false, active: true, overrides: {},
});
const rowValues = (client: Client): string[] => [
  client.id, client.name, client.displayName ?? "", client.address ?? "", client.postcode ?? "",
  client.phone ?? "", client.mobile ?? "", client.person ?? "", client.contact,
  tierText[client.tier], paymentText[client.payment],
  client.shippingFeeExcluded ? "예" : "아니오",
  client.defaultApplyVat === undefined ? "" : client.defaultApplyVat ? "예" : "아니오",
  client.active ? "거래중" : "거래중지",
  client.shortNames ?? "", client.identifiers, client.preferredAccountId ?? "",
  client.deletedAt ? "보관" : "사용",
];

export async function exportClientWorkbook(state: State): Promise<number[]> {
  const Excel = (await import("exceljs")).default;
  const workbook = new Excel.Workbook();
  const sheet = workbook.addWorksheet("거래처 목록");
  sheet.addRow([...CLIENT_HEADERS]);
  for (const client of state.clients) sheet.addRow(rowValues(client));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: "R1" };
  sheet.columns.forEach((column, index) => {
    column.width = [38, 30, 30, 44, 14, 19, 19, 19, 24, 16, 16, 16, 18, 16, 32, 32, 39, 14][index];
    column.numFmt = "@";
  });
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF303030" } };
  const guide = workbook.addWorksheet("작성 안내");
  [
    ["구분", "사용 기준"],
    ["기본 작업", "현재 거래처 전체를 내려받아 수정한 뒤 업로드합니다. 누락된 행은 삭제하지 않습니다."],
    ["기존 거래처 수정", "__거래처ID를 변경하지 마세요. ID가 일치하는 행만 기존 거래처를 수정합니다."],
    ["신규 거래처 추가", "__거래처ID를 비우고 새 행을 작성합니다. 동일 상호나 전화번호가 있으면 검토 대상입니다."],
    ["공란", "기존 거래처의 공란은 기존 값을 유지합니다. 새 거래처의 필수 항목은 반드시 입력하세요."],
    ["값 지우기", "선택 항목을 지울 때만 [비우기]를 입력합니다."],
    ["상태 변경", "거래 상태는 거래중 또는 거래중지. Excel에서 행을 지워도 거래처를 삭제하지 않습니다."],
    ["가격 및 결제", "가격등급: 도매, 반도매, 소매, 특수 / 결제방식: 선입금, 후불"],
    ["설정 여부", "운임 청구 제외, 부가세 기본 적용은 예 또는 아니오로 입력합니다."],
    ["주 사용 계좌", "계좌 ID는 입금 계좌 안내 시트에서 복사합니다. 없는 ID는 저장할 수 없습니다."],
    ["보관 상태", "보관된 거래처의 정보를 Excel로 수정하거나 재활성화하지 않습니다."],
    ["특수 단가 및 변경 이력", "특수 단가 시트는 참고용입니다. 기존 품목별 특수 가격과 변경 이력은 업로드 시 유지합니다."],
    ["오류와 중복", "중복 ID, 이름/전화번호 충돌, 형식 오류가 있으면 변경 승인 전체를 막습니다."],
    ["안전장치", "업로드 미리보기 검토 및 확인을 마친 후 DB를 백업하고 기존 데이터에 변경사항만 반영합니다."],
    ["Excel 수식", "데이터 셀의 수식과 병합은 허용하지 않습니다."],
  ].forEach((values) => guide.addRow(values));
  guide.getColumn(1).width = 28;
  guide.getColumn(2).width = 108;
  const accounts = workbook.addWorksheet("입금 계좌 안내");
  accounts.addRow(["계좌 ID", "은행", "계좌주"]);
  for (const account of state.settings.accounts) {
    accounts.addRow([account.id, account.bank, account.holder]);
  }
  accounts.columns = [{ width: 40 }, { width: 22 }, { width: 28 }];
  const exceptions = workbook.addWorksheet("특수 단가 참고");
  exceptions.addRow(["거래처 ID", "거래처명", "상품 옵션 ID", "특수 단가 (원)"]);
  for (const client of state.clients) {
    for (const [variantId, amount] of Object.entries(client.overrides ?? {})) {
      exceptions.addRow([client.id, client.name, variantId, amount]);
    }
  }
  exceptions.columns = [{ width: 40 }, { width: 34 }, { width: 42 }, { width: 18 }];
  const meta = workbook.addWorksheet("__반도허브_관리정보");
  meta.addRow(["종류", "BANDO-HUB-CLIENTS-V1"]);
  meta.addRow(["DB버전", state.revision ?? 0]);
  meta.state = "veryHidden";
  const buffer = await workbook.xlsx.writeBuffer();
  return Array.from(new Uint8Array(buffer as ArrayBuffer));
}

function createCandidate(original: Client | undefined, cells: string[]): Client {
  const isNew = !original;
  const next = original ? structuredClone(original) : newClient();
  const put = (key: "name" | "displayName" | "address" | "postcode" | "phone" |
    "mobile" | "person" | "contact" | "shortNames" | "identifiers" | "preferredAccountId", index: number) => {
    const raw = cells[index] ?? "";
    if (!raw && !isNew) return;
    const value = optionalString(raw, next[key], isNew);
    if (value.length > (key === "address" ? 350 : 250)) throw Error(CLIENT_HEADERS[index] + ": 입력값이 너무 깁니다.");
    next[key] = value;
  };
  put("name", 1);
  put("displayName", 2);
  put("address", 3);
  put("postcode", 4);
  put("phone", 5);
  put("mobile", 6);
  put("person", 7);
  put("contact", 8);
  next.tier = tier(cells[9] ?? "", next.tier, isNew);
  next.payment = payment(cells[10] ?? "", next.payment);
  next.shippingFeeExcluded = flag(cells[11] ?? "", next.shippingFeeExcluded);
  if ((cells[12] ?? "") || isNew) {
    next.defaultApplyVat = flag(cells[12] ?? "", next.defaultApplyVat ?? false);
  }
  if ((cells[13] ?? "") === "보관") throw Error("Excel에서 거래처를 삭제하거나 보관 상태로 전환할 수 없습니다.");
  next.active = flag(cells[13] ?? "", next.active);
  put("shortNames", 14);
  put("identifiers", 15);
  put("preferredAccountId", 16);
  if ((cells[17] ?? "") === "보관" && !original?.deletedAt) {
    throw Error("보관 상태 값은 변경할 수 없습니다.");
  }
  if (original?.deletedAt && JSON.stringify(next) !== JSON.stringify(original)) {
    throw Error("보관된 거래처는 Excel에서 수정할 수 없습니다.");
  }
  return next;
}

function changedFields(before: Client, after: Client): string[] {
  const keys: (keyof Client)[] = [
    "name", "displayName", "address", "postcode", "phone", "mobile", "person", "contact",
    "tier", "payment", "shippingFeeExcluded", "defaultApplyVat", "active",
    "shortNames", "identifiers", "preferredAccountId",
  ];
  return keys.filter((key) => JSON.stringify(before[key] ?? "") !== JSON.stringify(after[key] ?? ""))
    .map((key) => String(key) + ": " + String(before[key] ?? "") + " → " + String(after[key] ?? ""));
}
function collision(candidate: Client, others: Client[]): string[] {
  const name = normalize(candidate.name);
  const phone = phoneKey(candidate.phone || candidate.mobile || "");
  const conflicts: string[] = [];
  for (const previous of others) {
    if (previous.id === candidate.id || previous.deletedAt) continue;
    const sameName = !!name && normalize(previous.name) === name;
    const priorPhone = phoneKey(previous.phone || previous.mobile || "");
    const samePhone = !!phone && !!priorPhone && phone === priorPhone;
    if (sameName || samePhone) conflicts.push(previous.name);
  }
  return [...new Set(conflicts)];
}

export function previewClientRows(
  state: State, sourceRevision: number, input: { row: number; cells: string[] }[],
): ClientWorkbookPreview {
  const revision = state.revision ?? 0;
  if (revision !== sourceRevision) {
    throw Error("Excel을 내려받은 이후 데이터가 바뀌었습니다. 현재 거래처 목록을 다시 내려받아 주세요.");
  }
  if (input.length > MAX_ROWS) throw Error("한 번에 처리할 거래처는 최대 20,000행입니다.");
  const ids = new Set<string>();
  const rows: ClientWorkbookRow[] = [];
  const seenNew: Client[] = [];
  for (const { row, cells } of input) {
    if (cells.every((value) => !value.trim())) continue;
    const id = (cells[0] ?? "").trim();
    const errors: string[] = [];
    let status: ClientRowStatus = "ERROR";
    let candidate: Client | undefined;
    let changes: string[] = [];
    const original = id ? state.clients.find((client) => client.id === id) : undefined;
    try {
      if (id && ids.has(id)) throw Error("동일한 거래처 ID가 Excel에 두 번 있습니다.");
      if (id && !original) throw Error("등록되지 않은 거래처 ID입니다. 기존 ID는 수정하면 안 됩니다.");
      if (id) ids.add(id);
      candidate = createCandidate(original, cells);
      if (!candidate.name.trim() || !candidate.address?.trim() ||
        !(candidate.phone?.trim() || candidate.mobile?.trim())) {
        throw Error("거래처명, 주소, 전화번호 또는 휴대폰은 필수입니다.");
      }
      if (candidate.preferredAccountId &&
        !state.settings.accounts.some((account) => account.id === candidate?.preferredAccountId)) {
        throw Error("등록되지 않은 입금 계좌 ID입니다.");
      }
      if (original?.deletedAt) {
        status = "UNCHANGED";
      } else {
        changes = original ? changedFields(original, candidate) : ["신규 거래처 등록"];
        status = original ? (changes.length ? "UPDATE" : "UNCHANGED") : "ADD";
        if (status !== "UNCHANGED") {
          const conflicts = collision(candidate, [...state.clients, ...seenNew]);
          if (conflicts.length) {
            errors.push("동일한 상호 또는 전화번호가 있습니다: " + conflicts.join(", "));
            status = "HOLD";
          }
        }
      }
      if (!original) seenNew.push(candidate);
    } catch (error) {
      errors.push(String(error instanceof Error ? error.message : error));
      status = "ERROR";
    }
    rows.push({ row, id: id || candidate?.id || "", name: candidate?.name || cells[1] || "",
      status, changes, errors, client: candidate });
  }
  // Duplicate unmodified IDs are detected above. Rows with missing IDs are new,
  // but they may also collide with edited existing rows within the same workbook.
  const proposed = rows.filter((row) => row.status === "ADD" || row.status === "UPDATE");
  for (const row of proposed) {
    if (!row.client) continue;
    const peers = proposed.filter((other) => other !== row).flatMap((other) => other.client ? [other.client] : []);
    const conflicts = collision(row.client, peers);
    if (conflicts.length) {
      row.status = "HOLD";
      row.errors.push("Excel 안에 중복 거래처 후보가 있습니다: " + conflicts.join(", "));
    }
  }
  const listed = new Set(rows.filter((row) => row.id && state.clients.some((c) => c.id === row.id))
    .map((row) => row.id));
  return { revision, rows, missing: state.clients.filter((c) => !listed.has(c.id)).length };
}

export async function previewClientWorkbook(state: State, file: File): Promise<ClientWorkbookPreview> {
  if (!/\.xlsx$/i.test(file.name) || file.size > MAX_BYTES) {
    throw Error("20MB 이하의 .xlsx 거래처 파일을 선택하세요.");
  }
  const Excel = (await import("exceljs")).default;
  const workbook = new Excel.Workbook();
  const bytes = new Uint8Array(await file.arrayBuffer());
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const data = workbook.getWorksheet("거래처 목록");
  const meta = workbook.getWorksheet("__반도허브_관리정보");
  if (!data || !meta || workbookText(meta.getCell("B1")) !== "BANDO-HUB-CLIENTS-V1") {
    throw Error("반도허브에서 내려받은 거래처 전체 목록 Excel만 업로드할 수 있습니다.");
  }
  const sourceRevision = Number(workbookText(meta.getCell("B2")));
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) throw Error("원본 DB 버전이 올바르지 않습니다.");
  for (const [index, header] of CLIENT_HEADERS.entries()) {
    if (workbookText(data.getRow(1).getCell(index + 1)) !== header) {
      throw Error("거래처 Excel 열 이름이나 순서가 달라졌습니다: " + header);
    }
  }
  if (data.rowCount > MAX_ROWS + 1) throw Error("거래처 Excel은 최대 20,000행까지만 업로드할 수 있습니다.");
  const cells: { row: number; cells: string[] }[] = [];
  for (let i = 2; i <= data.rowCount; i++) {
    const values: string[] = [];
    try {
      for (let col = 1; col <= CLIENT_HEADERS.length; col++) values.push(workbookText(data.getRow(i).getCell(col)));
      cells.push({ row: i, cells: values });
    } catch (error) {
      // An unsafe row must block the entire import, never get silently skipped.
      throw Error(i + "행: " + String(error instanceof Error ? error.message : error));
    }
  }
  return previewClientRows(state, sourceRevision, cells);
}

export function applyClientWorkbook(state: State, preview: ClientWorkbookPreview): {
  next: State; created: number; updated: number;
} {
  if ((state.revision ?? 0) !== preview.revision) {
    throw Error("검토 후 거래처 데이터가 변경되었습니다. Excel을 다시 검증하세요.");
  }
  if (preview.rows.some((row) => row.status === "ERROR" || row.status === "HOLD")) {
    throw Error("중복 또는 오류 항목이 남아 있어 Excel 변경사항을 저장할 수 없습니다.");
  }
  const next = structuredClone(state);
  let created = 0;
  let updated = 0;
  for (const row of preview.rows) {
    if (!row.client || (row.status !== "ADD" && row.status !== "UPDATE")) continue;
    if (row.status === "ADD") {
      if (next.clients.some((client) => client.id === row.client?.id)) throw Error("거래처 ID 충돌입니다.");
      next.clients.push(structuredClone(row.client));
      created++;
    } else {
      const index = next.clients.findIndex((client) => client.id === row.client?.id);
      if (index < 0 || next.clients[index].deletedAt) throw Error("기존 거래처 정보를 확인할 수 없습니다.");
      // Existing price overrides, deletedAt and change history were carried
      // forward when the preview candidate was built.
      next.clients[index] = structuredClone(row.client);
      updated++;
    }
  }
  return { next, created, updated };
}
