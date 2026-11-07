import { companyParty } from "./order-types.js";
import { z } from "zod";
import { aliasProblems } from "./matching.js";
import { parseSmart } from "./parser.js";
import { colorLabel, registeredProducts } from "./product-models.js";
import type { Alias, Client, Item, Order, Product, Recipient, Settings, State } from "./types.js";
import { blocking, orderIssues } from "./validation.js";
export const unassignedClient: Client = {
  id: "",
  name: "",
  contact: "",
  identifiers: "",
  active: true,
  tier: "wholesale",
  shippingFeeExcluded: false,
  payment: "PREPAID",
  overrides: {},
};
export const uid = () => crypto.randomUUID();
export const normalizeCode = (s: string) => s.toUpperCase().replace(/\s/g, "");
const colorMap: Record<string, string> = {
  gold: "Gold",
  골드: "Gold",
  "rose gold": "Rose Gold",
  로즈골드: "Rose Gold",
  "cosmo black": "Cosmo Black",
  cosmoblack: "Cosmo Black",
  코스모블랙: "Cosmo Black",
  chrome: "Chrome",
  크롬: "Chrome",
  black: "Black",
  블랙: "Black",
  검정: "Black",
  검정색: "Black",
  gray: "Gray",
  grey: "Gray",
  그레이: "Gray",
  회색: "Gray",
  white: "White",
  화이트: "White",
  흰색: "White",
  silver: "Silver",
  실버: "Silver",
  red: "Red",
  빨강: "Red",
  blue: "Blue",
  파랑: "Blue",
  brown: "Brown",
  브라운: "Brown",
  clear: "Clear",
  클리어: "Clear",
  frost: "Frost",
  프로스트: "Frost",
};
export const normalizeColor = (s: string) => colorMap[s.trim().toLowerCase()] ?? s.trim();
export const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const priceSchema = money.nullable();
const variantSchema = z.object({
  id: z.string().min(1),
  color: z.string().min(1),
  wholesale: priceSchema,
  semi: priceSchema,
  retail: priceSchema,
  url: z.string(),
  source: z.enum(["DEMO", "MANUAL", "OFFICIAL"]),
  collectedAt: z.string().optional(),
});
export const productSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  category: z.string(),
  origin: z.enum(["STORE", "FACTORY"]),
  defaultColor: z.string().min(1),
  active: z.boolean(),
  // Each business product has exactly one price record; website configurations are separate products.
  variants: z.array(variantSchema).length(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export function validateProduct(p: Product, products: Product[]) {
  productSchema.parse(p);
  if (
    products.some(
      (x) =>
        x.id !== p.id &&
        normalizeCode(x.code) === normalizeCode(p.code) &&
        p.variants.some((v) => v.source === "DEMO") ===
          x.variants.some((v) => v.source === "DEMO") &&
        p.name.trim().toLowerCase() === x.name.trim().toLowerCase() &&
        (!p.siteId || !x.siteId || p.siteId === x.siteId),
    )
  )
    throw Error("같은 상품코드가 이미 있습니다.");
  if (!p.variants.some((v) => normalizeColor(v.color) === normalizeColor(p.defaultColor)))
    throw Error("상품 색상이 가격 기록과 일치하지 않습니다.");
  for (const v of p.variants)
    if (v.url && !validProductUrl(v.url))
      throw Error("상품 링크는 확인된 반도스탠드 / 반도몰 상세페이지 URL을 입력하세요.");
}
export function validProductUrl(value: string) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      ["bandostand.com", "www.bandostand.com", "bandomall.co.kr", "www.bandomall.co.kr"].includes(
        u.hostname,
      ) &&
      u.pathname.startsWith("/product/")
    );
  } catch {
    return false;
  }
}
export function validateAlias(a: Alias, all: Alias[], products: Product[]) {
  const problems = aliasProblems(a, all, products);
  if (problems.length) throw Error(problems.join("\n"));
  if (
    all.some(
      (x) =>
        x.id !== a.id &&
        x.clientId === a.clientId &&
        normalizeCode(x.text) === normalizeCode(a.text),
    )
  )
    throw Error("같은 적용 범위에 이미 등록된 별칭입니다.");
}
export function resolvePrice(p: Product, variantId: string, client: Client) {
  if (!client.id) return null;
  const v = p.variants.find((v) => v.id === variantId);
  const value =
    client.tier === "special"
      ? (client.overrides?.[variantId] ??
        v?.legacyIds?.map((id) => client.overrides?.[id]).find((p) => p !== undefined) ??
        v?.wholesale ??
        null)
      : (v?.[client.tier] ?? null);
  return value === 0 ? null : value;
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function codePattern(s: string) {
  return new RegExp(
    "(?<![A-Za-z0-9-])" + [...normalizeCode(s)].map(escape).join("\\s*") + "(?![A-Za-z0-9-])",
    "i",
  );
}
export function optionCodes(text: string) {
  const explicit = [...text.matchAll(/\bBD\s*(\d[A-Za-z0-9-]*)/gi)].map((m) => "BD " + m[1]);
  const numeric = text.match(/^(\d{3}[A-Za-z0-9-]*)(?![A-Za-z0-9-])/);
  return explicit.length ? explicit : numeric ? ["BD " + numeric[1]] : [];
}
export function itemFromProduct(
  p: Product,
  client: Client,
  color?: string,
  quantity: number | null = 1,
  selectedVariantId?: string,
): Item {
  const explicit = selectedVariantId
    ? p.variants.find((variant) => variant.id === selectedVariantId)
    : undefined;
  const c = normalizeColor(explicit?.color ?? color ?? p.defaultColor);
  const eligible = p.variants.filter((variant) => normalizeColor(variant.color) === c);
  // Color alone does not distinguish same-color options such as a bag
  // included/excluded, wheels included/excluded or perforated top.
  const v = selectedVariantId ? explicit :
    ((p.variants.length === 1 && !p.requiresOption) ||
    (p.variants.length > 1 && !!color && !p.requiresOption && eligible.length === 1)
      ? eligible[0] : undefined);
  // Preserve the curated business-facing product label for every order line.
  // Distinct products can share a model code (e.g. instrument/fixture variants).
  const basicName = (p.name || p.code).replace(/^반도스탠드\s*/i, "").trim();
  const detail = p.variants.length > 1 ? (v?.option ?? "").trim() : "";
  const productName = [basicName, ...(detail ? [detail] : [])].join(" / ");
  const configurationIncomplete = !!v && ["가방", "바퀴"].some((kind) => {
    const pattern = new RegExp(kind + "\\s*(?:미포함|포함|미장착|장착|없음|있음)");
    return p.variants.some((variant) => pattern.test(variant.option ?? "")) &&
      !pattern.test(v.option ?? "");
  });
  return {
    id: uid(),
    productId: p.id,
    variantId: v?.id ?? null,
    raw: p.code,
    name: p.variants.some((variant) => variant.source === "DEMO") &&
      !productName.startsWith("[가상] ")
      ? "[가상] " + productName : productName,
    color: c,
    quantity,
    unitPrice: v ? resolvePrice(p, v.id, client) : null,
    origin: p.origin,
    defaulted: !color,
    issues: v
      ? (p.colorStatus === "MISSING" ||
          (!p.saleUnit && ["색상 미표기", "", undefined].includes(p.defaultColor))) &&
        !color
        ? ["기본 색상 확인 필요"]
        : (configurationIncomplete ? ["가방 또는 바퀴 포함 / 미포함 정보 확인 필요"] : [])
      : ["등록되지 않은 색상 / 옵션 확인"],
    url: v?.url ?? "",
    catalog: p.catalog,
  };
}
export function parseLegacy(raw: string, client: Client, state: State): Recipient[] {
  const recipients: Recipient[] = [];
  let current: Recipient | undefined;
  const create = () => {
    current = {
      id: uid(),
      name: "",
      address: "",
      phone: "",
      mobile: "",
      note: "",
      items: [],
    };
    recipients.push(current);
    return current;
  };
  const patterns = (p: Product) =>
    [p.code, ...(p.modelCodes ?? [])]
      .flatMap((code) => {
        const values = [code];
        if (/^BD\s*[- ]?\s*\d{3}/i.test(code)) values.push(code.replace(/^BD\s*[- ]?\s*/i, ""));
        return values;
      })
      .sort((a, b) => b.length - a.length);
  for (const original of raw.replace(/\r/g, "").split("\n")) {
    const line = original.trim();
    if (!line) continue;
    if (/^(안녕하세요|안녕하십니까|감사합니다|감사해요|수고하세요|좋은\s*하루)/.test(line))
      continue;
    const name = line.match(
      /^(?:수취인(?:명)?|수하인(?:명)?|받는\s*(?:분|사람)|성함|이름)\s*[:：]\s*(.*)$/,
    );
    if (name) {
      if (current?.name) create();
      (current ?? create()).name = name[1].trim();
      continue;
    }
    const address = line.match(/^(?:주소|배송지|수취인주소)\s*[:：]\s*(.*)$/);
    if (address) {
      (current ?? create()).address = address[1];
      continue;
    }
    if (/^(?:배송\s*)?(?:요청사항|메모|메시지)\s*[:：]/.test(line)) {
      (current ?? create()).note = line.replace(/^.*?[:：]\s*/, "");
      continue;
    }
    const phones = [...line.matchAll(/0\d{1,2}[- .]?\d{3,4}[- .]?\d{4}/g)].map((x) =>
      x[0].replace(/[ .]/g, "-"),
    );
    if (phones.length) {
      const r = current ?? create();
      for (const ph of phones) {
        if (/^01/.test(ph)) r.mobile = ph;
        else r.phone = ph;
      }
      continue;
    }
    if (
      /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주)/.test(line) &&
      /[로길동읍면리]/.test(line)
    ) {
      const r = current ?? create();
      r.address += (r.address ? " " : "") + line;
      continue;
    }
    let candidates = registeredProducts(state.products).filter((p) =>
      patterns(p).some((code) => codePattern(code).test(line)),
    );
    if (candidates.some((p) => !p.variants.some((v) => v.source === "DEMO")))
      candidates = candidates.filter((p) => !p.variants.some((v) => v.source === "DEMO"));
    const matches = state.aliases
      .filter(
        (a) => (a.clientId === null || a.clientId === client.id) && codePattern(a.text).test(line),
      )
      .sort((a, b) => Number(!!b.clientId) - Number(!!a.clientId) || b.text.length - a.text.length);
    const alias = matches[0],
      aliasProduct = alias
        ? registeredProducts(state.products).find((p) => p.id === alias.productId)
        : undefined;
    // A bare Korean name is a recipient only after excluding known product expressions.
    if (!candidates.length && !aliasProduct && /^[가-힣]{2,5}(?:\s*님)?$/.test(line)) {
      if (current?.name) create();
      (current ?? create()).name = line.replace(/\s*님$/, "");
      continue;
    }
    const quantities = [...line.matchAll(/(\d+)\s*(?:개|대|세트|ea|pcs)(?![A-Za-z])/gi)];
    if (!candidates.length && !aliasProduct && !quantities.length) continue;
    const r = current ?? create();
    const quantity = quantities.length === 1 ? Number(quantities[0][1]) : null;
    // Two different pages with the same code are ambiguous; do not choose a color or model arbitrarily.
    const unique = [...new Map(candidates.map((p) => [p.id, p])).values()];
    let p = unique.length === 1 ? unique[0] : aliasProduct;
    const explicitColor = Object.keys(colorMap).find((word) =>
      new RegExp("(?<![A-Za-z가-힣])" + escape(word) + "(?![A-Za-z가-힣])", "i").test(line),
    );
    if (unique.length > 1 && explicitColor) {
      const filtered = unique.filter((p) =>
        p.variants.some((v) => normalizeColor(v.color) === normalizeColor(explicitColor)),
      );
      if (filtered.length === 1) p = filtered[0];
    }
    if (!p) {
      r.items.push({
        id: uid(),
        productId: null,
        variantId: null,
        raw: line,
        name: line.replace(/\s*\d+\s*(?:개|대|세트).*/, "").trim(),
        color: explicitColor ? normalizeColor(explicitColor) : "",
        quantity,
        unitPrice: null,
        origin: "FACTORY",
        defaulted: false,
        issues: [
          quantities.length > 1
            ? "한 줄에 여러 상품이 있습니다. 상품별로 분리해 주세요."
            : unique.length > 1
              ? "여러 모델 / 색상 후보 중 상품 확인 필요"
              : "상품 연결 필요",
        ],
        url: "",
      });
      continue;
    }
    const matchedCode = patterns(p).find((code) => codePattern(code).test(line));
    let tail = matchedCode ? line.replace(codePattern(matchedCode), "") : line;
    tail = tail
      .replace(/\d+\s*(?:개|대|세트|ea|pcs)/gi, "")
      .replace(
        /(?:보내\s*주세요|보내줘요|주문합니다|주문해요|부탁드립니다|부탁드려요|주세요|주문|발송|입니다|이에요)[.!~^^\s]*/g,
        "",
      );
    const variantWord = p.variants.find(
      (v) =>
        v.color !== "색상 미표기" &&
        v.color !== "단일" &&
        tail.toLowerCase().includes(v.color.toLowerCase()),
    );
    const unknownColor = tail.match(/(?:색상|컬러|옵션)\s*[:：]?\s*([^,;]+)/)?.[1]?.trim();
    const unknownWord = tail.match(
      /(?:빨간색|노랑|옐로우|빨강|레드|파랑|블루|흰색|화이트|회색|그레이|실버|골드|핑크|분홍|브라운|갈색)/,
    )?.[0];
    const it = itemFromProduct(
      p,
      client,
      explicitColor ?? variantWord?.color ?? unknownColor ?? unknownWord,
      quantity,
    );
    it.raw = line;
    if (alias?.variantId && !explicitColor && !variantWord && !unknownColor && !unknownWord) {
      const v = p.variants.find((v) => v.id === alias.variantId);
      if (v) {
        it.variantId = v.id;
        it.color = v.color;
        it.unitPrice = resolvePrice(p, v.id, client);
        it.url = v.url;
        it.issues = [];
      }
    }
    const exactOptions = p.variants.filter((v) =>
      optionCodes(v.option ?? "").some(
        (code) =>
          codePattern(code).test(line) || codePattern(code.replace(/^BD\s*/, "")).test(line),
      ),
    );
    if (exactOptions.length === 1) {
      const v = exactOptions[0];
      it.variantId = v.id;
      it.color = v.color;
      it.unitPrice = resolvePrice(p, v.id, client);
      it.url = v.url;
      it.name = optionCodes(v.option ?? "")[0] ?? p.code;
      it.issues = [];
      it.defaulted = false;
    }
    if (!quantity) it.issues.push("수량 확인 필요");
    if (quantities.length > 1)
      it.issues.push("한 줄에 여러 상품이 있습니다. 상품별로 분리해 주세요.");
    if (unique.length === 1 && aliasProduct && aliasProduct.id !== p.id)
      it.issues.push("별칭이 정식 상품코드와 충돌합니다. 정식 코드 우선 적용.");
    let residual = tail
      .replace(/(?:색상|컬러|옵션)\s*[:：]?/g, "")
      .replace(
        new RegExp(
          escape(explicitColor ?? variantWord?.color ?? unknownColor ?? unknownWord ?? "__NONE__"),
          "ig",
        ),
        "",
      );
    for (const a of matches.filter((a) => a.productId === p.id))
      residual = residual.replace(new RegExp(escape(a.text), "ig"), "");
    residual = residual.replace(/[\s,;:*×x/()\-]/g, "");
    if (residual) it.issues.push("추가 표현 / 옵션 검토: " + residual);
    r.items.push(it);
  }
  return recipients.length
    ? recipients
    : [
        {
          id: uid(),
          name: "",
          address: "",
          phone: "",
          mobile: "",
          note: "",
          items: [],
        },
      ];
}
export function repriceOrder(order: Order, client: Client, state: State): Order {
  const o = structuredClone(order);
  for (const r of o.recipients)
    for (const i of r.items) {
      const p = state.products.find((p) => p.id === i.productId);
      if (p && i.variantId) {
        i.unitPrice = resolvePrice(p, i.variantId, client);
        if (i.modelProposal?.required)
          i.url = p.variants.find((v) => v.id === i.variantId)?.url ?? i.url;
      }
    }
  return o;
}
export function orderClient(o: Order, state: State) {
  if (o.orderType === "RETAIL") return o.clientSnapshot ?? companyParty(state.settings);
  return o.pricesLocked && o.clientSnapshot
    ? o.clientSnapshot
    : (state.clients.find((c) => c.id === o.clientId) ?? o.clientSnapshot);
}
export function clientCandidates(text: string, clients: Client[]) {
  const query = text.toLowerCase().replace(/\s/g, "");
  if (!query) return [];
  return clients.filter(
    (c) =>
      !c.deletedAt &&
      [c.name, c.displayName, c.phone, c.mobile, c.address, c.shortNames, c.identifiers].some(
        (v) => v && v.toLowerCase().replace(/\s/g, "").includes(query),
      ),
  );
}
export function suggestClient(raw: string, clients: Client[]) {
  return clients.filter(
    (c) =>
      !c.deletedAt &&
      [c.name, c.displayName ?? ""].some((n) => n.trim().length >= 2 && raw.includes(n.trim())),
  );
}
export function recommendAccount(o: Order, s: Settings, products: Product[] = [], client?: Client) {
  if (o.accountMode === "MANUAL") return s.accounts.find((a) => a.id === o.accountId);
  if (o.orderType !== "RETAIL") {
    const preferred = client?.preferredAccountId ?? o.clientSnapshot?.preferredAccountId;
    const account = s.accounts.find((a) => a.id === preferred);
    if (account) return account;
  }
  const items = o.recipients.flatMap((r) => r.items);
  const onlyMall =
    items.length > 0 &&
    items.every(
      (i) => (i.catalog ?? products.find((p) => p.id === i.productId)?.catalog) === "BANDOMALL",
    );
  const id = onlyMall
    ? s.brandAccounts?.BANDOMALL
    : s.brandAccounts?.BANDOSTAND || s.defaultAccountId;
  return s.accounts.find((a) => a.id === id);
}
export function roundVat(base: number) {
  return Math.round(base * 0.1);
}
export function totals(o: Order, c: Client) {
  c = o.pricesLocked && o.clientSnapshot ? o.clientSnapshot : c;
  const items = o.recipients.flatMap((r) => r.items);
  const valid =
    items.length > 0 &&
    items.every(
      (i) =>
        i.productId &&
        i.variantId &&
        money.safeParse(i.unitPrice).success &&
        Number.isInteger(i.quantity) &&
        (i.quantity ?? 0) > 0,
    );
  const candidate = valid ? items.reduce((s, i) => s + i.unitPrice! * i.quantity!, 0) : null;
  const subtotal = candidate !== null && Number.isSafeInteger(candidate) ? candidate : null;
  const shipping = c.shippingFeeExcluded || o.freightCode === "020" ? 0 : o.shippingFee;
  const complete = subtotal !== null && money.safeParse(shipping).success;
  const vat =
    o.pricesLocked && o.vatAmount !== null
      ? o.vatAmount
      : !o.applyVat
        ? 0
        : complete
          ? roundVat(subtotal! + shipping!)
          : null;
  const total = complete ? subtotal! + shipping! + vat! : null;
  if (total !== null && !Number.isSafeInteger(total))
    return { subtotal: null, shipping, vat: null, total: null };
  return { subtotal, shipping, vat, total };
}
export function reviewIssues(o: Order) {
  return [
    ...new Set(
      orderIssues(o)
        .filter((i) => blocking(i, 1))
        .map(
          (i) =>
            (i.itemId
              ? (o.recipients.flatMap((r) => r.items).find((x) => x.id === i.itemId)?.name ??
                "상품")
              : "수취인 " + (o.recipients.findIndex((r) => r.id === i.recipientId) + 1)) +
            ": " +
            i.title,
        ),
    ),
  ];
}
export const won = (n: number | null) =>
  n === null ? "확인 필요" : n.toLocaleString("ko-KR") + "원";
export function messages(
  o: Order,
  c: Client,
  s: Settings,
  links: { payment: boolean; options: boolean },
  products: Product[] = [],
) {
  c = o.pricesLocked && o.clientSnapshot ? o.clientSnapshot : c;
  const t = totals(o, c),
    items = o.recipients.flatMap((r) => r.items),
    a = recommendAccount(o, s, products, c);
  const label = (i: Item) => {
    const p = products.find((p) => p.id === i.productId);
    return (
      i.name +
      (p?.colorStatus === "NOT_REQUIRED" || !i.color || ["단일", "색상 미표기"].includes(i.color)
        ? ""
        : " (" + colorLabel(i.color) + ")")
    );
  };
  const urls = (on: boolean) =>
    on
      ? [
          ...new Set(
            items
              .filter((i) => i.url && validProductUrl(i.url))
              .map((i) => label(i) + "\n" + i.url),
          ),
        ].join("\n")
      : "";
  const paymentIssues = [
    ...new Set([
      ...(!c.id ? ["거래처 선택 필요"] : []),
      ...reviewIssues(o),
      ...(items.some((i) => !i.productId || !i.variantId) ? ["제품명이 확인되지 않습니다."] : []),
      ...(c.id && items.some((i) => i.unitPrice === null) ? ["판매가 확인 필요"] : []),
      ...(t.shipping === null ? ["운임 확인 필요"] : []),
      ...(!a?.bank.trim() || !a.number.trim() || !a.holder.trim() ? ["입금 계좌 등록 필요"] : []),
    ]),
  ];
  const amountLines = items.map(
    (i) =>
      `${label(i)} * ${i.quantity ?? "?"}개${i.quantityConfirmed === false ? " (수량 미확정)" : ""} : ${i.unitPrice !== null && i.quantity !== null ? won(i.unitPrice * i.quantity) : i.quantity === null ? "수량 확인 필요" : !c.id ? "거래처 선택 후 단가 적용" : "판매가 확인 필요"}`,
  );
  const payment = [
    "안녕하세요.",
    "",
    ...(paymentIssues.length ? ["[작성 중 / 확인 후 복사 가능]", ""] : []),
    ...amountLines,
    "",
    `운임 : ${won(t.shipping)}`,
    ...(o.applyVat ? [`부가세 : ${won(t.vat)}`] : []),
    "",
    ...(t.total === null ? ["합계 : 금액 확인 필요"] : [`합계 : ${won(t.total)} 입니다.`]),
    "",
    a?.bank && a.number && a.holder
      ? `${a.bank} ${a.number} ${a.holder} 입니다.`
      : "[입금 계좌 등록 필요]",
    urls(links.payment),
  ].join("\n");
  const questions = items.flatMap((i) => [
    ...(i.quantityConfirmed === false ? [`${i.name} 수량을 확인 부탁드립니다.`] : []),
    ...(!i.productId ? [`${i.name}: 정확한 모델명을 확인해 주세요.`] : []),
    ...(i.issues.some((x) => x.includes("색상")) ? [`${i.name}: 실제 색상을 확인해 주세요.`] : []),
  ]);
  const options = [
    "안녕하세요.",
    "",
    "주문하신 내역 확인 부탁드립니다.",
    "",
    ...items.map((i) => `${label(i)} * ${i.quantity ?? "?"}개`),
    "",
    ...questions,
    ...(items.some((i) => i.defaulted && normalizeColor(i.color) === "Black")
      ? [
          "별도 색상 지정이 없는 상품은 기본 색상인 검정으로 출고됩니다. 다른 색상을 원하시면 말씀해 주세요.",
        ]
      : []),
    "",
    "주문 내용 확인 후 회신 부탁드립니다.",
    urls(links.options),
  ].join("\n");
  return { payment, options, paymentIssues };
}
export function canQueue(o: Order, c: Client, s: Settings) {
  const issues = reviewIssues(o);
  if (o.status === "EXPORTED")
    issues.push("이미 공장에 전달한 주문입니다. 수정 / 재확인 후 추가하세요.");
  if (totals(o, c).total === null) issues.push("청구 금액 / 운임 미확정");
  if (!o.notified) issues.push("안내 완료 처리 필요");
  if (c.payment === "PREPAID" && !o.paid) issues.push("실제 입금 확인 필요");
  if (c.payment === "POSTPAID" && !o.postpaidApproved) issues.push("후불 출고 승인 필요");
  if (!o.recipients.some((r) => r.items.some((i) => i.origin === "FACTORY")))
    issues.push("공장 출고 상품 없음");
  if (!(c.displayName || c.name) || !c.address || (!c.phone && !c.mobile))
    issues.push("거래처 송장 상호 / 주소 / 전화번호 등록 필요");
  return issues;
}
export const statusNames = {
  RECEIVED: "주문 접수",
  REVIEW: "정보 확인 필요",
  STATEMENT: "명세서 작성 완료",
  NOTIFIED: "안내 완료",
  WAITING: "입금 대기",
  APPROVED: "입금 확인 / 후불 승인",
  QUEUED: "공장 전달 대기",
  EXPORTED: "공장 전달 완료",
};

export const parseOrder = parseSmart;
