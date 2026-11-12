import {
  itemFromProduct,
  normalizeCode,
  normalizeColor,
  resolvePrice,
  uid,
  unassignedClient,
} from "./domain.js";
import { broadCategory, categoryKind } from "./matching.js";
import { colorLabel, registeredProducts } from "./product-models.js";
import { brandTerms } from "./product-registry.js";
import { productFamily } from "./product-search.js";
import { productModelNames, productNameEvidence, registeredNameCandidates, scoreStandTop, verifiedScoreStandBases } from "./product-name-match.js";
import { analyzeEvidence, matchingRecipient, rebindEvidence } from "./order-evidence.js";
import type { Client, Item, Recipient, State } from "./types.js";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const quantityWords: Record<string, number> = {
  한: 1,
  하나: 1,
  두: 2,
  둘: 2,
  세: 3,
  셋: 3,
  네: 4,
  넷: 4,
  다섯: 5,
  여섯: 6,
  일곱: 7,
  여덟: 8,
  아홉: 9,
  열: 10,
  일: 1,
  이: 2,
  삼: 3,
  사: 4,
  오: 5,
  육: 6,
  칠: 7,
  팔: 8,
  구: 9,
  십: 10,
};
export function quantities(text: string) {
  const result: { value: number; start: number; end: number; text: string }[] = [];
  const pattern =
    /(\d+|다섯|여섯|일곱|여덟|아홉|하나|둘|셋|넷|한|두|세|네|열|일|이|삼|사|오|육|칠|팔|구|십)\s*(?:개|대|세트|ea|pcs)(?![A-Za-z])|[x×*]\s*(\d+)(?!\d|\s*(?:cm|mm)\b)/gi;
  for (const m of text.matchAll(pattern))
    result.push({
      value: m[2] ? Number(m[2]) : /^\d+$/.test(m[1]) ? Number(m[1]) : quantityWords[m[1]],
      start: m.index!,
      end: m.index! + m[0].length,
      text: m[0],
    });
  return result;
}
const phonePattern =
  /(?<!\d)(0(?:50\d|1[016789]|2|[3-6]\d|70|80))[\s().-]*(\d{3,4})[\s().-]*(\d{4})(?!\d)/g;
const admin =
  /(?<![가-힣])(?:서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:특별자치도|도)?|충청북도|충청남도|전라북도|전북특별자치도|전라남도|경상북도|경상남도|충북|충남|전북|전남|경북|경남|제주(?:특별자치도|도)?|[가-힣]{2,}(?:시|군|구|읍|면|동|리)(?=\s|$|\d)|[가-힣0-9·.]+(?:대로|로|길)\s*\d+(?!\d|개|대|세트|ea|pcs))/;
export function addressInfo(value: string) {
  const road = /[로길]\s*\d+(?:-\d+)?/.test(value),
    lot = /[동리읍면]\s+(?:산\s*)?\d+(?:-\d+)?/.test(value);
  return {
    kind: road ? ("ROAD" as const) : lot ? ("LOT" as const) : ("UNKNOWN" as const),
    complete: road || lot,
  };
}
export function addressParts(value: string): import("./types.js").AddressParts {
  const province = value.match(
    /^(서울특별시|서울|부산광역시|부산|대구광역시|대구|인천광역시|인천|광주광역시|광주|대전광역시|대전|울산광역시|울산|세종특별자치시|세종|경기도|경기|강원특별자치도|강원도|강원|충청북도|충청남도|전북특별자치도|전라북도|전라남도|경상북도|경상남도|제주특별자치도|제주도|제주|충북|충남|전북|전남|경북|경남)(?=\s|$)/,
  )?.[0];
  const rest = province ? value.slice(province.length).trim() : value;
  const city = rest.match(/(?:^|\s)([가-힣]+(?:시|군))(?=\s|$)/)?.[1],
    district = rest.match(/(?:^|\s)([가-힣]+구)(?=\s|$)/)?.[1],
    town = rest.match(/(?:^|\s)([가-힣0-9]+(?:읍|면|동|리))(?=\s|$)/)?.[1];
  const roadMatch = rest.match(/([가-힣A-Za-z0-9·.]+(?:대로|로|길))\s+(\d+(?:-\d+)?)(?!\d|개|대)/),
    lot = town ? rest.match(new RegExp(town + "\\s+(?:산\\s*)?(\\d+(?:-\\d+)?)")) : undefined;
  const building = roadMatch?.[2] ?? lot?.[1];
  const matched = roadMatch ?? lot;
  const detail = matched
    ? rest.slice((matched.index ?? 0) + matched[0].length).trim() || undefined
    : undefined;
  return {
    province,
    city,
    district,
    town,
    road: roadMatch?.[1],
    building,
    detail,
  };
}
function codeRegex(code: string) {
  const normal = normalizeCode(code),
    prefix = normal.startsWith("BD") ? "(?:BD[\\s-]*)?" : "",
    bare = normal.startsWith("BD") ? normal.slice(2) : normal;
  return new RegExp(
    "(?<![A-Za-z0-9-])" + prefix + [...bare].map(escape).join("\\s*") + "(?![A-Za-z0-9-])",
    "i",
  );
}
function logicalLines(raw: string, state: State) {
  const result: { 0: string; index: number }[] = [];
  for (const m of raw.matchAll(/[^\n]+/g)) {
    const line = m[0],
      address = line.match(admin),
      phones = [...line.matchAll(phonePattern)];
    if (!address || address.index === undefined) {
      result.push({ 0: line, index: m.index! });
      continue;
    }
    const known = registeredProducts(state.products)
      .flatMap(p => productModelNames(p).map(name => codeRegex(name).exec(line)))
      .filter((x): x is RegExpExecArray => !!x);
    const unknown = [...line.matchAll(/(?:BD\s*)?\d{3}[A-Za-z0-9-]*/gi)];
    const candidates = [...known, ...unknown]
      .filter(
        (x) =>
          x.index! < address.index! &&
          !phones.some((ph) => x.index! >= ph.index! && x.index! < ph.index! + ph[0].length),
      )
      .sort((a, b) => a.index! - b.index!);
    const model = candidates[0];
    if (!model) {
      result.push({ 0: line, index: m.index! });
      continue;
    }
    const qs = quantities(line).filter(
      (q) => q.start >= model.index! + model[0].length && q.end <= address.index!,
    );
    if (!qs.length && !known.some((x) => x.index === model.index)) {
      result.push({ 0: line, index: m.index! });
      continue;
    }
    let end = qs.at(-1)?.end ?? model.index! + model[0].length;
    const polite = line
      .slice(end)
      .match(
        /^\s*(?:보내\s*주세요|부탁드려요|부탁드립니다|보내줘요|주세요|주문합니다|주문해요|요)[.!~^\s]*/,
      );
    if (polite) end += polite[0].length;
    const start = model.index!;
    result.push({
      0: line.slice(0, start) + " ".repeat(end - start) + line.slice(end),
      index: m.index!,
    });
    result.push({ 0: line.slice(start, end), index: m.index! + start });
  }
  return result;
}
const colorTokens = [
  "rose gold",
  "로즈골드",
  "cosmo black",
  "cosmoblack",
  "코스모블랙",
  "gold",
  "골드",
  "black",
  "블랙",
  "검정",
  "gray",
  "grey",
  "그레이",
  "회색",
  "white",
  "화이트",
  "흰색",
  "brown",
  "브라운",
  "clear",
  "클리어",
  "frost",
  "프로스트",
  "silver",
  "실버",
  "blue",
  "블루",
  "red",
  "레드",
  "핑크",
  "pink",
  "대형",
  "소형",
];
const abbreviationColors: Record<string, string> = {
  B: "Black",
  BK: "Black",
  C: "Chrome",
  W: "White",
  G: "Gray",
  BR: "Brown",
  검정: "Black",
  블랙: "Black",
  크롬: "Chrome",
  화이트: "White",
  그레이: "Gray",
  브라운: "Brown",
};
export function modelColorHint(line: string) {
  const suffix = line.match(
    /(?<![A-Za-z0-9-])(?:BD\s*)?(\d{3}(?:-\d+)?)(?:\s*\(\s*(BK|BR|B|C|W|G|검정|블랙|크롬|화이트|그레이|브라운)\s*\)|\s*(BK|BR|B|C|W|G))(?=$|[\s,.!*×])/i,
  );
  const prefix = line.match(
    /(?<![A-Za-z0-9-])(BK|BR|B|C|W|G)\s+(?:BD\s*)?(\d{3}(?:-\d+)?)(?=$|[\s,.!*×])/i,
  );
  if (suffix)
    return {
      base: suffix[1],
      color:
        abbreviationColors[(suffix[2] ?? suffix[3]).toUpperCase()] ??
        abbreviationColors[suffix[2] ?? suffix[3]],
      term: suffix[0],
    };
  if (prefix)
    return {
      base: prefix[2],
      color: abbreviationColors[prefix[1].toUpperCase()],
      term: prefix[0],
    };
  return undefined;
}
function registeredColorHint(line: string, products: State["products"]) {
  for (const p of products)
    for (const code of productModelNames(p)) {
      const bare = normalizeCode(code).replace(/^BD/, "");
      if (!bare) continue;
      const pattern = new RegExp(
          "(?<![A-Za-z0-9-])(?:BD\\s*)?" +
            [...bare].map(escape).join("\\s*") +
            "\\s*(?:\\(\\s*(BK|BR|B|C|W|G)\\s*\\)|(BK|BR|B|C|W|G))(?=$|[\\s,.!*])",
          "i",
        ),
        m = pattern.exec(line);
      if (m)
        return {
          base: bare,
          color: abbreviationColors[(m[1] ?? m[2]).toUpperCase()],
          term: m[0],
        };
    }
  return undefined;
}
export function recommendModels(value: string, state: State) {
  const term = normalizeCode(value).replace(/^BD/, "");
  if (!term) return [];
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 0; i < a.length; i++) {
      const next = [i + 1];
      for (let j = 0; j < b.length; j++)
        next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])));
      row = next;
    }
    return row[b.length];
  };
  const all = registeredProducts(state.products),
    pool = all.some((p) => !p.variants.some((v) => v.source === "DEMO"))
      ? all.filter((p) => !p.variants.some((v) => v.source === "DEMO"))
      : all;
  return pool
    .map((p) => ({
      p,
      score: Math.min(
        ...[
          ...productModelNames(p),
        ].map((c) => distance(term, normalizeCode(c).replace(/^BD/, ""))),
      ),
    }))
    .filter((x) => x.score <= 2)
    .sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name))
    .slice(0, 3)
    .map((x) => x.p);
}
const person = (s: string) =>
  /^[가-힣]{2,5}(?:님)?$/.test(s) &&
  !/^(?:주소|배송지|배송주소|받는곳|보내는곳|연락처|전화번호|사무실|행정실|반도|반도스탠드|민판|무타공|비타공|한개|두개|세개)$/.test(s) &&
  // A destination institution at the end of an address is not an additional
  // recipient. Keep it inside the address. Explicit standalone institutions
  // are still recognized separately in order-evidence.ts.
  // Single-syllable endings such as 호, 길, 리, 로 can occur in real
  // personal names. Filter complete institutional/boilerplate endings, not
  // surname/given-name syllables or an arbitrary name length alone.
  !/(?:아파트|빌라|센터|상가|학교|교회|성당|병원|학원|월드|도서관|회관|지원청|주세요|감사해요|보내세요)$/.test(s);
function parseLegacy(raw: string, selectedClient: Client | undefined, state: State): Recipient[] {
  const client = selectedClient ?? unassignedClient;
  const result: Recipient[] = [];
  let current: Recipient | undefined;
  const commonItems: Item[] = [];
  const create = () => {
    current = {
      id: uid(),
      name: "",
      address: "",
      phone: "",
      mobile: "",
      note: "",
      items: [],
      sources: [],
      candidates: [],
      confirmedFields: [],
    };
    result.push(current);
    return current;
  };
  const source = (r: Recipient, field: string, value: string, start: number, end: number) => {
    const span = {
      start,
      end,
      field,
      targetId: r.id,
      text: raw.slice(start, end),
    };
    r.sources!.push(span);
    r.candidates!.push({ id: uid(), field, value, label: value, start, end });
  };
  const assign = (
    r: Recipient,
    field: "name" | "address" | "phone" | "mobile",
    value: string,
    start: number,
    end: number,
  ) => {
    source(r, field, value, start, end);
    if (!r[field]) r[field] = value;
    else if (r[field] !== value) r.confirmedFields = r.confirmedFields?.filter((f) => f !== field);
  };
  for (const match of logicalLines(raw, state)) {
    const original = match[0],
      leading = original.length - original.trimStart().length,
      line = original.trim(),
      offset = match.index! + leading;
    if (
      !line ||
      (/^(안녕하세요|안녕하십니까|감사합니다|수고하세요|좋은\s*하루)/.test(line) &&
        !admin.test(line) &&
        !quantities(line).length &&
        !/\d{3}/.test(line))
    )
      continue;
    let remainder = line;
    const explicitName = line.match(
      /^(?:수취인(?:명)?|수하인(?:명)?|수령자|받는\s*(?:분|사람)|성함|이름)\s*[:：]\s*(.*)$/,
    );
    if (explicitName) {
      if (
        current &&
        ((current.name &&
          (current.items.length || current.address || current.mobile || current.phone)) ||
          (!current.name &&
            (current.address || current.mobile || current.phone) &&
            current.items.some((i) => i.quantityConfirmed)))
      )
        create();
      const r = current ?? create(),
        value = explicitName[1].trim(),
        at = line.indexOf(value);
      assign(r, "name", value, offset + at, offset + at + value.length);
      continue;
    }
    if (/^(?:배송\s*)?(?:요청사항|메모|메시지)\s*[:：]/.test(line)) {
      (current ?? create()).note = line.replace(/^.*?[:：]\s*/, "");
      continue;
    }
    const phones = [...line.matchAll(phonePattern)];
    if (
      phones.length &&
      current?.items.length &&
      current.name &&
      current.address &&
      (current.phone || current.mobile) &&
      admin.test(line)
    )
      create();
    for (const ph of phones) {
      const r = current ?? create(),
        value = ph[1] + "-" + ph[2] + "-" + ph[3];
      assign(
        r,
        ph[1].startsWith("01") ? "mobile" : "phone",
        value,
        offset + ph.index!,
        offset + ph.index! + ph[0].length,
      );
      remainder =
        remainder.slice(0, ph.index!) +
        " ".repeat(ph[0].length) +
        remainder.slice(ph.index! + ph[0].length);
    }
    // Keep incomplete contact-only lines out of model recognition. Otherwise a
    // truncated 010-... becomes a second item and steals the following quantity.
    if (!phones.length) {
      const labelled = line.match(
          /^(휴대폰|핸드폰|전화(?:번호)?|연락처)\s*[:：]?\s*(\d[\d\s().-]*)$/,
        ),
        contact = line.match(/^(0(?:50\d|1[016789]|2|[3-6]\d|70|80)[\d\s().-]*)$/),
        contextual =
          !labelled &&
          !contact &&
          current?.name &&
          current?.address &&
          !current.phone &&
          !current.mobile &&
          (current.items.some((i) => i.productId) || commonItems.some((i) => i.productId)) &&
          /^\d[\d\s().-]*$/.test(line) &&
          line.replace(/\D/g, "").length >= 5 &&
          line.replace(/\D/g, "").length <= 12
            ? line
            : undefined,
        value = (labelled?.[2] ?? contact?.[1] ?? contextual)?.trim();
      if (value) {
        const key = normalizeCode(value),
          known =
            !labelled &&
            (registeredProducts(state.products).some((p) =>
              [
                ...productModelNames(p),
              ].some((code) => normalizeCode(code).replace(/^BD/, "") === key),
            ) ||
              state.aliases.some(
                (a) =>
                  (a.clientId === null || a.clientId === client.id) &&
                  normalizeCode(a.text) === key,
              ));
        if (!known) {
          const at = line.indexOf(value),
            mobile = labelled
              ? /휴대폰|핸드폰/.test(labelled[1]) || (labelled[1] === "연락처" && /^01/.test(value))
              : contact
                ? /^01/.test(value)
                : true;
          assign(
            current ?? create(),
            mobile ? "mobile" : "phone",
            value,
            offset + at,
            offset + at + value.length,
          );
          continue;
        }
      }
    }

    const addressPrefix = remainder.match(
      /^(?:주소|배송지(?:\s*주소)?|배송주소|받는곳|수취인주소)\s*[:：]\s*/,
    );
    const found = addressPrefix ? { index: addressPrefix[0].length } : remainder.match(admin);
    if (found && found.index !== undefined) {
      if (
        current?.address &&
        (current.mobile || current.phone) &&
        current.items.some((i) => i.quantityConfirmed)
      )
        create();
      const r = current ?? create();
      // A delivery address is authoritative once recognized. Do not pull
      // name-shaped words from the middle or tail of an address: district,
      // building and institution names belong to the address until an
      // explicit name field or an independent recipient line says otherwise.
      const value = remainder.slice(found.index).trim();
      let before = addressPrefix
        ? ""
        : remainder
            .slice(0, found.index)
            .trim()
            .replace(/[:：,]/g, " ")
            .trim();
      // In a combined one-line order, never treat "반도", "민판" or
      // quantity words as names. After an item quantity, only the final
      // explicit person token before the address can be the recipient.
      const afterQuantity = before.match(
        /(?:\d+|한|두|세|네)\s*(?:개|대|ea|pcs)\s+([가-힣]{2,5})(?:님)?\s*$/i,
      );
      const possibleNames = afterQuantity
        ? [afterQuantity[1]]
        : before.split(/[,/\s]+/).filter(person);
      for (const n of possibleNames.filter(person)) {
        const at = remainder.indexOf(n);
        assign(r, "name", n.replace(/님$/, ""), offset + at, offset + at + n.length);
      }
      const literalAt = remainder.indexOf(value),
        at = literalAt >= 0 ? literalAt : found.index;
      const addressEnd = literalAt >= 0 ? at + value.length : remainder.trimEnd().length;
      assign(r, "address", value, offset + at, offset + addressEnd);
      const info = addressInfo(value);
      r.addressKind = info.kind;
      r.addressParts = addressParts(value);
      r.addressStatus = info.complete ? "COMPLETE" : "INCOMPLETE";
      continue;
    }
    const ps = registeredProducts(state.products);
    const aliases = state.aliases
      .filter(
        (a) =>
          (a.clientId === null || a.clientId === client.id) &&
          !broadCategory(a.text) &&
          [
            a.text,
            ...(/^BD\s*\d/i.test(a.text)
              ? [a.text.replace(/^BD\s*/i, "")]
              : /^\d/.test(a.text)
                ? ["BD " + a.text]
                : []),
          ].some((term) => codeRegex(term).test(line)),
      )
      .sort((a, b) => Number(!!b.clientId) - Number(!!a.clientId) || b.text.length - a.text.length);
    let choices = registeredNameCandidates(ps, line);
    const brandMatches = ps.filter((p) =>
      brandTerms(state, p).some((b) => line.toLowerCase().includes(b.toLowerCase())),
    );
    if (brandMatches.length)
      choices = choices.filter((p) => brandMatches.some((b) => b.id === p.id));
    else if (
      choices.some((p) => p.catalog !== "BANDOMALL") &&
      /^(?:BD\s*)?\d{3}[A-Za-z-]*(?:\s|$)/i.test(line)
    )
      choices = choices.filter((p) => p.catalog !== "BANDOMALL");
    if (choices.some((p) => !p.variants.some((v) => v.source === "DEMO")))
      choices = choices.filter((p) => !p.variants.some((v) => v.source === "DEMO"));
    const knownBrandText =
      state.brands?.some((b) =>
        [b.name, b.korean, ...b.aliases].some(
          (t) => t && line.toLowerCase().includes(t.toLowerCase()),
        ),
      ) ?? false;
    const family = productFamily(line),
      generic = !!family && !choices.length && !aliases.length;
    const qs = quantities(line),
      unknownModel = line.match(/(?:BD\s*)?\d{3}[A-Za-z0-9-]*/i);
    if (!qs.length && choices.length) {
      const tail = line.match(/\s+([1-9]\d*)\s*$/);
      if (tail) {
        const prefix = line.slice(0, tail.index),
          matched = choices
            .flatMap((p) => productModelNames(p))
            .map((code) => codeRegex(code).exec(prefix))
            .find(Boolean);
        if (
          matched &&
          !/\d/.test(
            prefix.slice(0, matched.index) + prefix.slice(matched.index + matched[0].length),
          )
        )
          qs.push({
            value: Number(tail[1]),
            start: line.lastIndexOf(tail[1]),
            end: line.lastIndexOf(tail[1]) + tail[1].length,
            text: tail[1],
          });
      }
    }
    if (
      qs.length === 1 &&
      choices.some(
        (p) =>
          p.sellingUnit === "2개 구성" &&
          !!p.variants[0].option &&
          line.includes(p.variants[0].option!),
      )
    )
      qs.splice(0, 1);

    if (
      !choices.length &&
      !aliases.length &&
      !qs.length &&
      !unknownModel &&
      !generic &&
      !knownBrandText
    ) {
      if (person(remainder.trim())) {
        if (
          current &&
          ((current.name &&
            (current.items.length || current.address || current.mobile || current.phone)) ||
            (!current.name &&
              (current.address || current.mobile || current.phone) &&
              current.items.some((i) => i.quantityConfirmed)))
        )
          create();
        const r = current ?? create(),
          name = remainder.trim().replace(/님$/, "");
        assign(
          r,
          "name",
          name,
          offset + line.indexOf(name),
          offset + line.indexOf(name) + name.length,
        );
      }
      continue;
    }
    if (phones.length && !choices.length && !aliases.length && !qs.length) continue;
    // A quantity-only line can follow recipient details. Bind only to one pending item
    // in this recipient; never guess between multiple products or recipients.
    if (
      !choices.length &&
      !aliases.length &&
      qs.length === 1 &&
      !line.slice(0, qs[0].start).trim() &&
      !line.slice(qs[0].end).trim()
    ) {
      const pending = current?.items.filter((i) => i.quantityConfirmed === false) ?? [];
      if (pending.length === 0 && current && !current.items.length && commonItems.length === 1) {
        const inherited = structuredClone(commonItems[0]);
        inherited.id = uid();
        inherited.quantity = 1;
        inherited.quantityConfirmed = false;
        inherited.sources = inherited.sources
          ?.filter((s) => s.field === "product")
          .map((s) => ({ ...s, targetId: inherited.id }));
        current.items.push(inherited);
        pending.push(inherited);
      }
      if (pending.length === 1) {
        const item = pending[0],
          qty = qs[0];
        item.quantity = qty.value;
        item.quantityConfirmed = true;
        item.issues = item.issues.filter((x) => !x.includes("수량"));
        item.sources ??= [];
        item.sources.push({
          start: offset + qty.start,
          end: offset + qty.end,
          field: "quantity",
          targetId: item.id,
          text: qty.text,
        });
        continue;
      }
    }

    let brandedCategory = false;
    if (!choices.length && !aliases.length && knownBrandText) {
      choices = ps.filter((p) =>
        brandTerms(state, p).some((b) => line.toLowerCase().includes(b.toLowerCase())),
      );
      brandedCategory = true;
    }
    const r = current ?? create();
    let explicit = colorTokens.find((c) => line.toLowerCase().includes(c.toLowerCase()));
    const hint = modelColorHint(line) ?? registeredColorHint(line, ps);
    const bare = (code: string) => normalizeCode(code).replace(/^BD/, "");
    const protectedCode =
      hint &&
      choices.some((p) =>
        productModelNames(p).some(
          (code) => bare(code) === bare(hint.term),
        ),
      );
    if (hint && !protectedCode) {
      explicit = hint.color;
      choices = ps.filter((p) =>
        productModelNames(p).some(
          (code) => bare(code) === bare(hint.base),
        ),
      );
      if (choices.some((p) => !p.variants.some((v) => v.source === "DEMO")))
        choices = choices.filter((p) => !p.variants.some((v) => v.source === "DEMO"));
    }
    if (explicit && ["대형", "소형"].includes(explicit)) explicit = undefined;
    const q = qs.length === 1 ? qs[0].value : qs.length ? null : 1;
    const confirmed = qs.length === 1;
    // A product's full registered name, not a nested sale option, identifies its
    // configuration. Keep "미포함" distinct from the substring "포함".
    const qualifiers = (value: string) =>
      [...new Set((value.replace(/\s+/g, "").toLowerCase()
        .match(/(?:가방|바퀴)(?:미포함|포함|미장착|장착)|[ab]타입|민판|무타공상판|무타공|비타공상판|타공상판|\d+(?:\.\d+)?cm/g) ?? [])
        .map(token => /^(?:민판|무타공)/.test(token) ? "비타공상판" : token))];
    const configurationProof = qualifiers(line);
    const verifiedScoreBases = verifiedScoreStandBases(ps);
    const qualifies = (candidate: State["products"][number]) => {
      const named = qualifiers(candidate.name);
      const top = scoreStandTop(candidate, verifiedScoreBases);
      if (top === "UNPERFORATED") named.push("비타공상판");
      if (top === "PERFORATED") named.push("타공상판");
      return configurationProof.every(token => named.includes(token));
    };
    if (configurationProof.length) {
      // Each option must belong to this candidate, not merely to a sibling.
      choices = choices.filter(qualifies);
    }
    const codeChoices = choices.slice();
    const alias = aliases[0];
    if (!choices.length && alias) {
      const p = ps.find((p) => p.id === alias.productId);
      // A saved alias must never bypass a contradictory top/option proof.
      if (p && qualifies(p)) choices = [p];
    }
    const filtered = explicit
      ? choices.filter((p) =>
          p.variants.some((v) => normalizeColor(v.color) === normalizeColor(explicit!)),
        )
      : choices;
    let p = filtered.length === 1 ? filtered[0] : undefined;
    if (!p && !explicit && alias)
      p = choices.find(candidate => candidate.id === alias.productId);
    const exact = explicit
        ? codeChoices.filter((p) =>
            p.variants.some((v) => normalizeColor(v.color) === normalizeColor(explicit!)),
          )
        : p
          ? codeChoices.filter((x) => x.id === p!.id)
          : codeChoices,
      aliasProducts = aliases
        .map((a) => ps.find((p) => p.id === a.productId))
        .filter((p): p is State["products"][number] => !!p),
      scopeAliases = aliases.filter((a) => !!a.clientId === !!aliases[0]?.clientId),
      conflict =
        (exact.length > 0 && aliasProducts.some((a) => !exact.some((e) => e.id === a.id))) ||
        (!exact.length && new Set(scopeAliases.map((a) => a.productId)).size > 1);
    const categoryMismatch =
      !!p &&
      !!categoryKind(line) &&
      !!categoryKind(p.category + " " + p.subtitle + " " + p.name) &&
      categoryKind(line) !== categoryKind(p.category + " " + p.subtitle + " " + p.name);
    if (conflict) {
      p = undefined;
      choices = [...new Map([...exact, ...aliasProducts].map((p) => [p.id, p])).values()];
    } else if (categoryMismatch) {
      p = undefined;
      choices = exact;
    }
    if (generic && !conflict) {
      // A broad category is insufficient evidence for any specific product.
      p = undefined;
      choices = [];
    }
    const ambiguousOptions = !explicit && !alias && choices.length > 1;
    if (ambiguousOptions) p = undefined;
    if (brandedCategory) p = undefined;
    let item: Item;
    if (p) {
      item = itemFromProduct(p, client, explicit, q);
      if (!explicit && p.saleUnit && !p.requiresOption && p.variants.length === 1) {
        const v = p.variants[0];
        item.variantId = v.id;
        item.color = v.color;
        item.unitPrice = resolvePrice(p, v.id, client);
        item.issues = p.colorStatus === "MISSING" ? ["실제 색상 데이터 확인 필요"] : [];
      }
    } else
      item = {
        id: uid(),
        productId: null,
        variantId: null,
        raw: line,
        name:
          unknownModel?.[0] ??
          (line.replace(/\s*(?:\d+|세|삼)\s*(?:개|대|ea).*/i, "").trim() || "상품 확인 필요"),
        color: explicit ? normalizeColor(explicit) : "",
        quantity: q,
        unitPrice: null,
        origin: "FACTORY",
        defaulted: false,
        recognitionReason: generic
          ? "상품 종류는 인식했지만 모델명은 확정되지 않았습니다. 실제 상품을 선택하세요."
          : "등록된 모델명 또는 별칭과 일치하지 않습니다.",
        issues: ["제품명이 확인되지 않습니다."],
        url: "",
      };
    if (ambiguousOptions)
      item.recognitionReason =
        "여러 독립 상품 후보가 있습니다. 실제 상품과 색상을 확인하세요.";
    else if (!p && choices.length > 1 && !generic)
      item.recognitionReason = "등록된 모델명에 여러 SKU/옵션이 있습니다. 실제 SKU를 확인하세요.";
    item.match = {
      kind: conflict
        ? "CONFLICT"
        : categoryMismatch
          ? "CATEGORY_CONFLICT"
          : generic || brandedCategory || ambiguousOptions || (!p && choices.length > 1)
            ? "CATEGORY"
            : p
              ? exact.length
                ? "NAME"
                : alias?.clientId
                  ? "CLIENT_ALIAS"
                  : "COMMON_ALIAS"
              : "UNKNOWN",
      term: alias?.text ?? unknownModel?.[0] ?? line,
      productIds: choices.map((p) => p.id),
      aliasId: !exact.length ? alias?.id : undefined,
    };
    if (conflict) {
      item.productId = null;
      item.variantId = null;
      item.unitPrice = null;
      item.issues = ["상품 연결 정보가 충돌합니다."];
      item.recognitionReason = "정확한 SKU 후보와 등록된 별칭이 서로 다른 상품을 가리킵니다.";
    }
    if (categoryMismatch) {
      item.productId = null;
      item.variantId = null;
      item.unitPrice = null;
      item.issues = ["상품 종류와 모델이 상충합니다."];
      item.recognitionReason = "모델 코드와 상품 종류의 일치 여부를 직원이 확인해야 합니다.";
    }
    if (p && !p.requiresOption && p.variants.length === 1 &&
        alias?.productId === p.id && alias.variantId) {
      const v = p.variants.find((v) => v.id === alias.variantId);
      if (v) {
        item.variantId = v.id;
        item.color = v.color;
        item.unitPrice = resolvePrice(p, v.id, client);
        item.url = v.url;
      }
    }
    item.raw = line;
    item.quantityConfirmed = confirmed;
    item.productCandidates = choices.slice(0, 20).map((p) => ({
      id: uid(),
      field: "product",
      value: p.id,
      label:
        p.name +
        " " +
        (p.colorStatus === "NOT_REQUIRED" ? "" : colorLabel(p.variants[0]?.color ?? "")),
      start: offset,
      end: offset + line.length,
      productId: p.id,
      variantId: p.variants[0]?.id,
    }));
    const productTerm = (p ?? choices[0])
      ? productNameEvidence(line, p ?? choices[0])
      : unknownModel;
    const productAt = productTerm?.index ?? 0;
    item.sources = [
      {
        start: offset + productAt,
        end: offset + productAt + (productTerm?.[0].length ?? line.length),
        field: "product",
        targetId: item.id,
        text: productTerm?.[0] ?? line,
      },
    ];
    for (const qty of qs)
      item.sources.push({
        start: offset + qty.start,
        end: offset + qty.end,
        field: "quantity",
        targetId: item.id,
        text: qty.text,
      });
    if (!confirmed)
      item.issues.push(
        qs.length ? "한 줄에 여러 상품과 수량 확인 필요" : "수량 1개 잠정 적용 / 거래처 확인 필요",
      );
    if (/대형|소형/.test(line) && p && !p.name.includes(line.match(/대형|소형/)![0]))
      item.issues.push("추가 표현/옵션 검토 필요");
    if (result.length === 1 && !r.name && !r.address && !r.phone && !r.mobile)
      commonItems.push(structuredClone(item));
    r.items.push(item);
  }
  return result.length ? result : [create()];
}

/** Whole-document evidence ownership precedes recipient-local model resolution. */
export function parseEvidence(raw: string, client: Client | undefined, state: State) {
  const result = analyzeEvidence(raw, client, state, parseLegacy, quantities);
  for (const r of result.recipients) {
    if (r.address) {
      const info = addressInfo(r.address);
      r.addressKind = info.kind;
      r.addressParts = addressParts(r.address);
      r.addressStatus = info.complete && !/[#@]/.test(r.address) ? "COMPLETE" : "INCOMPLETE";
    }
  }
  return result;
}
export function parseSmart(raw: string, client: Client | undefined, state: State): Recipient[] {
  return parseEvidence(raw, client, state).recipients;
}

export function reanalyzeWithAliases(order: import("./types.js").Order, state: State) {
  const next = structuredClone(order),
    client = state.clients.find((c) => c.id === order.clientId) ?? order.clientSnapshot;
  if (order.manualClassification) return next;
  const evidence = parseEvidence(order.analysisRaw ?? order.raw, client, state),
    parsed = evidence.recipients;
  next.analysisEvidence = evidence.candidates;
  const usedRecipients = new Set<string>();
  next.recipients = parsed.map((r) => {
    const old = matchingRecipient(r, order.recipients, usedRecipients, parsed);
    if (old) usedRecipients.add(old.id);
    if (!old) return r;
    rebindEvidence(evidence.candidates, "recipientId", r.id, old.id);
    r.id = old.id;
    r.shippingCharges = old.shippingCharges;
    r.freightCode = old.freightCode;
    r.vatDefault = old.vatDefault;
    r.vatOverride = old.vatOverride;
    r.confirmedFields = old.confirmedFields;
    for (const field of old.confirmedFields ?? [])
      if (["name", "address", "phone", "mobile", "note"].includes(field))
        (r as unknown as Record<string, unknown>)[field] = (
          old as unknown as Record<string, unknown>
        )[field];
    if (old.confirmedFields?.includes("address")) {
      r.addressStatus = old.addressStatus;
      r.addressParts = old.addressParts ?? addressParts(old.address);
    }
    for (const span of r.sources ?? []) {
      span.targetId = r.id;
      span.recipientId = r.id;
    }
    const used = new Set<string>();
    for (const item of r.items) {
      const prior = old.items.find((i) => i.raw === item.raw && !used.has(i.id));
      if (!prior) continue;
      used.add(prior.id);
      rebindEvidence(evidence.candidates, "itemId", item.id, prior.id);
      Object.assign(item, mergeParsedItem(item, prior));
      for (const span of item.sources ?? []) {
        span.targetId = item.id;
        span.recipientId = r.id;
      }
    }
    return r;
  });
  return next;
}

/** Preserve an explicit employee decision only while its original evidence is unchanged. */
export function mergeParsedItem(incoming: Item, previous: Item | undefined): Item {
  if (!previous) return incoming;
  const sources = incoming.sources,
    id = previous.id,
    qtyChanged =
      JSON.stringify(
        previous.sources?.filter((s) => s.field === "quantity").map((s) => s.text) ?? [],
      ) !==
      JSON.stringify(
        incoming.sources?.filter((s) => s.field === "quantity").map((s) => s.text) ?? [],
      ),
    quantity = incoming.quantity,
    quantityConfirmed = incoming.quantityConfirmed,
    quantityIssues = incoming.issues.filter((s) => s.includes("수량"));
  let item =
    previous.manuallyConfirmed && previous.raw === incoming.raw
      ? { ...structuredClone(previous), sources, id }
      : { ...incoming, id };
  if (qtyChanged) {
    item = {
      ...item,
      quantity,
      quantityConfirmed,
      issues: [...item.issues.filter((s) => !s.includes("수량")), ...quantityIssues],
    };
    delete item.quantityApproval;
  }
  for (const span of item.sources ?? []) span.targetId = id;
  return item;
}
