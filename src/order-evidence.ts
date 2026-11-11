import type { Client, Item, Recipient, State } from "./types.js";

export interface OrderEvidence {
  id: string;
  text: string;
  start: number;
  end: number;
  line: number;
  paragraph: number;
  kind: "name" | "address" | "phone" | "mobile" | "product" | "quantity" | "note";
  value: string;
  reason: string;
  recipientId?: string;
  itemId?: string;
}
export function rebindEvidence(
  candidates: OrderEvidence[],
  field: "recipientId" | "itemId",
  from: string,
  to: string,
) {
  for (const candidate of candidates) if (candidate[field] === from) candidate[field] = to;
}
type Recognize = (raw: string, client: Client | undefined, state: State) => Recipient[];
type ProductEvidence = {
  candidate: OrderEvidence;
  item: Item;
  quantity?: OrderEvidence;
  common: boolean;
  each: boolean;
};

/** Recognition is local; ownership is decided only after the whole document has been inspected. */
export function analyzeEvidence(
  raw: string,
  client: Client | undefined,
  state: State,
  recognize: Recognize,
  extractQuantities: (
    text: string,
  ) => { start: number; end: number; value: number; text: string }[],
) {
  const candidates: OrderEvidence[] = [],
    products: ProductEvidence[] = [];
  const senderOffset = raw.search(/^\s*(?:보내는\s*(?:분|사람)|송하인(?:명)?)\s*[:：]/m);
  const physical = [...raw.matchAll(/[^\r\n]+/g)].filter((match) => match[0].trim());
  let paragraph = 0,
    previousEnd = 0,
    lineIndex = 0;
  let noteContinuation: OrderEvidence | undefined;
  for (const match of physical) {
    if (senderOffset >= 0 && match.index! >= senderOffset) continue;
    const gap = raw.slice(previousEnd, match.index!);
    lineIndex += (gap.match(/\n/g) ?? []).length;
    if (/\n\s*\n/.test(gap)) paragraph++;
    previousEnd = match.index! + match[0].length;
    if (
      /^\s*(?:\d{1,3}(?:,\d{3})+(?:원)?(?:\s*(?:[+]\s*부가세|입니다.*))?|배송료|운임까지.*|\*+.*연락처.*\d+.*개.*|\*+.*발송부탁.*)\s*$/.test(
        match[0],
      )
    )
      continue;
    if (
      /^\s*(?:[\d,]+\s*원(?:\s*입니다.*)?|(?:합계|총액|계좌번호|입금\s*계좌)\s*[:：]?.*|[가-힣]{2,10}은행\s*[:：]?\s*[\d-]+)\s*$/.test(
        match[0],
      )
    )
      continue;
    const local = recognize(match[0], client, state);

    const add = (
      kind: OrderEvidence["kind"],
      start: number,
      end: number,
      value: string,
      reason: string,
    ) => {
      const from = match.index! + start,
        to = match.index! + end,
        id = `${kind}:${from}:${to}`;
      const old = candidates.find((c) => c.id === id);
      if (old) return old;
      const candidate = {
        id,
        text: raw.slice(from, to),
        start: from,
        end: to,
        line: lineIndex,
        paragraph,
        kind,
        value,
        reason,
      };
      candidates.push(candidate);
      return candidate;
    };
    const organization = match[0]
      .trim()
      .match(/^[가-힣A-Za-z0-9 ()]{2,30}(?:학교|교회|성당|병원|학원|월드|목사)$/);
    if (organization && !local.some((r) => r.items.length || r.address)) {
      const value = organization[0].replace(/\s+목사$/, "");
      add(
        "name",
        match[0].indexOf(organization[0]),
        match[0].indexOf(organization[0]) + organization[0].length,
        value,
        "수취 기관 또는 직함을 포함한 이름",
      );
      continue;
    }
    const parenthetical = match[0].match(
      /\(([가-힣]{2,5})\)\s*(?:\(\d{5}\))?\s*(?=서울|경기|인천|부산|강원|충청|전라|경상|제주)/,
    );
    if (parenthetical) {
      const start = match[0].indexOf(parenthetical[1]);
      add(
        "name",
        start,
        start + parenthetical[1].length,
        parenthetical[1],
        "배송주소 앞 괄호 안 수취인 이름",
      );
    }
    const named = match[0].match(
      /(?:수취인명|수령자)\s*[:：]?\s*([가-힣]{2,10})(?=\s*(?:연락처|전화|휴대))/,
    );
    if (named) {
      const start = match[0].indexOf(named[1]);
      add("name", start, start + named[1].length, named[1], "명시적 수취인 이름");
    }
    const multiName = match[0].trim().match(/^[가-힣]{2,5}\s+[가-힣]{2,5}님$/);
    if (multiName && !local.some((r) => r.items.length || r.address)) {
      const value = multiName[0].replace(/님$/, "");
      add(
        "name",
        match[0].indexOf(multiName[0]),
        match[0].indexOf(multiName[0]) + multiName[0].length,
        value,
        "수취인 복수 표기 이름",
      );
      continue;
    }
    const noteLabel = match[0].match(
      /^\s*\(?(?:배송\s*)?(?:메세지|메시지|요청(?:사항)?|메모)(?:\s*[:：]\s*|\s+)(.*)$/,
    );
    if (noteLabel) {
      const value = match[0].trim().startsWith("(")
          ? noteLabel[1].replace(/\)\s*$/, "")
          : noteLabel[1],
        start = value ? match[0].lastIndexOf(value) : match[0].length;
      noteContinuation = add("note", start, match[0].length, value, "배송 요청사항 표제어");
      continue;
    }
    if (noteContinuation) {
      const isField =
        local.some((r) => r.items.length || r.name || r.address || r.mobile || r.phone) ||
        /^(?:수취인|수하인|주소|배송지|연락처|휴대폰|전화)\s*[:：]/.test(match[0]);
      if (!isField && paragraph === noteContinuation.paragraph) {
        noteContinuation.end = match.index! + match[0].length;
        noteContinuation.text = raw.slice(noteContinuation.start, noteContinuation.end);
        noteContinuation.value = [noteContinuation.value, match[0].trim()]
          .filter(Boolean)
          .join("\n");
        continue;
      }
      noteContinuation = undefined;
    }
    const previousAddress = candidates.filter((c) => c.kind === "address").at(-1);
    if (
      previousAddress &&
      previousAddress.paragraph === paragraph &&
      /^\s{2,}\S/.test(match[0]) &&
      !local.some((r) => r.items.length || r.name || r.address || r.phone || r.mobile) &&
      /\d+\s*(?:층|호)/.test(match[0])
    ) {
      const value = match[0].trim();
      add(
        "address",
        match[0].indexOf(value),
        match[0].indexOf(value) + value.length,
        value,
        "들여쓰기된 상세주소 연속 행",
      );
      continue;
    }
    const localProducts = local.flatMap((r) =>
      r.items.flatMap((i) => i.sources?.filter((s) => s.field === "product") ?? []),
    );
    if (localProducts.length && !local.some((r) => r.name || r.address)) {
      const removed = [
        ...localProducts,
        ...extractQuantities(match[0]).map((q) => ({ start: q.start, end: q.end })),
      ].sort((a, b) => b.start - a.start);
      let remainder = match[0];
      for (const span of removed)
        remainder =
          remainder.slice(0, span.start) +
          " ".repeat(span.end - span.start) +
          remainder.slice(span.end);
      const name = remainder
        .replace(
          /(?:블랙|검정|크롬|화이트|흰색|실버|그레이|회색|브라운|black|chrome|white|silver|gray|grey|brown)/gi,
          " ",
        )
        .trim();
      if (
        /^[가-힣]{2,5}(?:님)?$/.test(name) &&
        !/보면대|스탠드|마이크|주세요|감사|안녕|배송/.test(name)
      ) {
        const start = match[0].indexOf(name);
        add(
          "name",
          start,
          start + name.length,
          name.replace(/님$/, ""),
          "상품 / 수량과 같은 행에서 분리한 이름",
        );
      }
    }
    const inlineContact = match[0].match(/^([가-힣]{2,5})(?:님)?\s+(0[\d\s().-]{3,})$/);
    if (inlineContact && !/보면대|스탠드|마이크|키보드/.test(inlineContact[1])) {
      const name = inlineContact[1],
        value = inlineContact[2].trim(),
        start = match[0].indexOf(value);
      add("name", 0, name.length, name, "이름과 연락처 모양이 같은 행에 있음");
      add(
        /^02|^0[3-8]/.test(value) ? "phone" : "mobile",
        start,
        start + value.length,
        value.replace(
          /^(0(?:50\d|1[016789]|2|[3-6]\d|70|80))[\s().-]*(\d{3,4})[\s().-]*(\d{4})$/,
          "$1-$2-$3",
        ),
        "같은 행의 연락처 원문 보존; 유효성은 별도 검증",
      );
      continue;
    }
    const contactOnly = match[0]
      .trim()
      .match(/^(?:(휴대폰|핸드폰|전화(?:번호)?|연락처)\s*[:：]?\s*)?(\d[\d\s().-]*)$/);
    const contactValue = contactOnly?.[2].trim();
    const knownNumericModel =
      contactValue &&
      state.products.some((p) =>
        [p.code, ...(p.modelCodes ?? [])].some(
          (code) =>
            code.replace(/^BD\s*/i, "").replace(/\s/g, "") === contactValue.replace(/\s/g, ""),
        ),
      );
    if (
      contactValue &&
      !knownNumericModel &&
      (contactOnly?.[1] ||
        /^0(?:50\d|1[016789]|2|[3-6]\d|70|80)/.test(contactValue) ||
        contactValue.replace(/\D/g, "").length >= 5)
    ) {
      const field =
        /^02|^0[3-8]/.test(contactValue) || /전화/.test(contactOnly?.[1] ?? "")
          ? "phone"
          : "mobile";
      const start = match[0].indexOf(contactValue);
      const recognized = local.flatMap((r) => r.sources ?? []).find((s) => s.field === field);
      const normalized = recognized
        ? local.find((r) => r.sources?.includes(recognized))?.[field]
        : undefined;
      add(
        field,
        start,
        start + contactValue.length,
        normalized || contactValue,
        "연락처 모양의 원문 보존; 유효성은 별도 검증",
      );
      continue;
    }
    for (const q of extractQuantities(match[0]))
      add("quantity", q.start, q.end, String(q.value), "원문 전체 수량 후보 독립 추출");
    const phoneMatches = [
      ...match[0].matchAll(
        /(?<!\d)(0(?:50\d|1[016789]|2|[3-6]\d|70|80))[\s().-]*(\d{3,4})[\s().-]*(\d{4})(?!\d)/g,
      ),
    ];
    for (const phone of phoneMatches) {
      add(
        phone[1].startsWith("01") ? "mobile" : "phone",
        phone.index!,
        phone.index! + phone[0].length,
        `${phone[1]}-${phone[2]}-${phone[3]}`,
        "전화번호 구간 독립 추출",
      );
      for (const [text, offset] of [
        [match[0].slice(0, phone.index!), 0],
        [match[0].slice(phone.index! + phone[0].length), phone.index! + phone[0].length],
      ] as [string, number][]) {
        const name = text.trim();
        if (
          /^[가-힣]{2,5}(?:님)?$/.test(name) &&
          !/(주소|전화|연락처|휴대폰|핸드폰|보내주세요|감사합니다)/.test(name)
        ) {
          const start = offset + text.indexOf(name);
          add(
            "name",
            start,
            start + name.length,
            name.replace(/님$/, ""),
            "전화번호와 같은 행의 이름 / 강한 배송 건 경계",
          );
        }
      }
    }
    for (const row of local) {
      for (const candidate of row.candidates ?? []) {
        if (candidate.field === "name")
          add(
            candidate.field as OrderEvidence["kind"],
            candidate.start,
            candidate.end,
            candidate.value,
            "같은 행의 대안 후보; 직원 확인 필요",
          );
      }
      for (const span of row.sources ?? []) {
        if (!["name", "address", "phone", "mobile", "note"].includes(span.field)) continue;
        const field = span.field as "name" | "address" | "phone" | "mobile" | "note";
        add(field, span.start, span.end, row[field], "해당 원문 행에서 독립 추출");
      }
      for (const item of row.items) {
        const p = item.sources?.find((s) => s.field === "product"),
          q = item.sources?.find((s) => s.field === "quantity");
        const quantity = q
          ? add(
              "quantity",
              q.start,
              q.end,
              String(item.quantity ?? ""),
              "같은 상품 행 또는 독립 수량 구간",
            )
          : undefined;
        if (
          item.match?.kind === "QUANTITY" ||
          (!p && quantity) ||
          (q && match[0].trim() === q.text.trim())
        )
          continue;
        if (!p || /^\s*\d+\s*(?:개|대)\s*(?:발송|보내|출고)/.test(match[0])) continue;
        const candidate = add(
          "product",
          p.start,
          p.end,
          item.raw,
          "상품 코드 / 별칭 / 옵션 인식 결과; 귀속은 별도 판정",
        );
        if (products.some((x) => x.candidate.id === candidate.id)) continue;
        products.push({
          candidate,
          item: structuredClone(item),
          quantity,
          common: /공통|모두|전부|전원|각\s*수취인|같은\s*상품/.test(match[0]),
          each: /(?:각각?|수취인마다|한\s*분당).*(?:\d+|한|두|세)\s*(?:개|대)|씩/.test(match[0]),
        });
      }
    }
  }
  candidates.sort((a, b) => a.start - b.start || a.end - b.end);
  const names = candidates.filter((c) => c.kind === "name");
  const addresses = candidates.filter((c) => c.kind === "address");
  const anchors = names.filter(
    (name, index) => names.findIndex((other) => other.line === name.line) === index,
  );
  for (const address of addresses) {
    if (address.reason.includes("상세주소 연속 행")) continue;
    if (names.some((name) => name.line === address.line)) continue;
    const preceding = names.filter((name) => name.start < address.start).at(-1);
    const seen = addresses.some(
      (other) => other.start < address.start && (!preceding || other.start > preceding.start),
    );
    const following = names.find((n) => n.start > address.end);
    const nextAddress = addresses.find((a) => a.start > address.start);
    if (
      !preceding &&
      following &&
      (!nextAddress || following.start < nextAddress.start) &&
      !candidates.some(
        (c) =>
          ["phone", "mobile", "quantity", "product"].includes(c.kind) &&
          c.start > address.end &&
          c.start < following.start,
      )
    )
      continue;
    const earlier = addresses.filter((a) => a.end <= address.start).at(-1);
    if (
      earlier &&
      earlier.paragraph === address.paragraph &&
      !/[로길동리]\s*\d/.test(earlier.value) &&
      !names.some((n) => n.start > earlier.end && n.start < address.start) &&
      !candidates.some(
        (c) =>
          ["phone", "mobile", "product"].includes(c.kind) &&
          c.start > earlier.end &&
          c.start < address.start,
      )
    )
      continue;
    if (!preceding || seen) anchors.push(address);
  }
  anchors.sort((a, b) => a.start - b.start);
  const rows: Recipient[] = anchors.map((anchor) => ({
    id: crypto.randomUUID(),
    name: anchor.kind === "name" ? anchor.value : "",
    address: "",
    phone: "",
    mobile: "",
    note: "",
    items: [],
    sources: [],
    candidates: [],
    evidence: { anchorId: anchor.id, start: anchor.start, end: anchor.end },
  }));
  if (!rows.length && raw.trim())
    rows.push({
      id: crypto.randomUUID(),
      name: "",
      address: "",
      phone: "",
      mobile: "",
      note: "",
      items: [],
      sources: [],
      candidates: [],
    });
  const source = (row: Recipient, c: OrderEvidence, field = c.kind, targetId = row.id) => {
    c.recipientId = row.id;
    c.reason += " / 배송 건 원문 경계와 연결";
    row.sources!.push({
      start: c.start,
      end: c.end,
      field,
      targetId,
      text: c.text,
      recipientId: row.id,
    });
    row.candidates!.push({
      id: c.id,
      start: c.start,
      end: c.end,
      field,
      value: c.value,
      label: c.value,
    });
  };
  const owner = (c: OrderEvidence) => {
    const same = anchors.findIndex((a) => a.line === c.line);
    if (same >= 0) return rows[same];
    const previous =
      anchors
        .map((a, i) => (a.start <= c.start ? i : -1))
        .filter((i) => i >= 0)
        .at(-1) ?? -1;
    if (previous < 0) return rows[0];
    return rows[previous];
  };
  for (const c of candidates.filter((c) => !["product", "quantity"].includes(c.kind))) {
    const row = owner(c);
    if (!row) continue;
    const field = c.kind as "name" | "address" | "phone" | "mobile" | "note";
    if (["phone", "mobile"].includes(field) && row[field] && row[field] !== c.value) {
      const other = field === "phone" ? "mobile" : "phone";
      if (!row[other]) {
        row[other] = c.value;
        source(row, c, other);
        continue;
      }
    }
    if (!row[field]) row[field] = c.value;
    else if (field === "address" && !row.address.includes(c.value)) row.address += " " + c.value;
    source(row, c);
  }
  const leading =
    !!anchors.length && products.some((p) => !p.common && p.candidate.start < anchors[0].start);
  const attach = (row: Recipient, p: ProductEvidence, q?: OrderEvidence) => {
    const item = structuredClone(p.item);
    item.id = crypto.randomUUID();
    item.quantity = q ? Number(q.value) : null;
    item.quantityConfirmed = !!q;
    delete item.quantityApproval;
    item.issues = item.issues.filter((s) => !s.includes("수량") || s.includes("여러 상품"));
    item.sources = [
      {
        start: p.candidate.start,
        end: p.candidate.end,
        targetId: item.id,
        recipientId: row.id,
        field: "product",
        text: p.candidate.text,
      },
    ];
    if (q)
      item.sources.push({
        start: q.start,
        end: q.end,
        targetId: item.id,
        recipientId: row.id,
        field: "quantity",
        text: q.text,
      });
    if (p.common)
      item.match = {
        kind: "COMMON_INHERIT",
        term: p.candidate.text,
        productIds: item.productId ? [item.productId] : [],
      };
    row.items.push(item);
    p.candidate.recipientId ??= row.id;
    p.candidate.itemId ??= item.id;
    if (q) {
      q.recipientId = row.id;
      q.itemId = item.id;
    }
  };
  for (const p of products.filter((p) => !p.common)) {
    let row: Recipient | undefined;
    const same = anchors.findIndex((a) => a.line === p.candidate.line);
    if (same >= 0) row = rows[same];
    else if (leading) {
      const next = anchors.findIndex((a) => a.start > p.candidate.start);
      row = next >= 0 ? rows[next] : rows.at(-1);
    } else row = owner(p.candidate);
    if (row) attach(row, p, p.item.quantityConfirmed !== false ? p.quantity : undefined);
  }
  // A bare model is local to the first named delivery. Only an explicit common instruction may be reused.
  for (const p of products.filter((p) => p.common)) {
    for (const row of rows) {
      if (row.items.length) continue;
      const quantity = candidates.find(
        (q) =>
          q.kind === "quantity" && !q.itemId && owner(q)?.id === row.id && q.id !== p.quantity?.id,
      );
      attach(row, p, quantity ?? (p.each ? p.quantity : undefined));
    }
  }
  for (const q of candidates.filter((c) => c.kind === "quantity" && !c.itemId)) {
    // Ambiguous quantities on a product line cannot become confirmed through the standalone-quantity path.
    if (products.some((p) => p.candidate.line === q.line)) continue;
    const row = owner(q);
    if (!row) continue;
    const pending = row.items.filter((i) => i.quantity === null);
    const quantities = candidates.filter(
      (c) =>
        c.kind === "quantity" &&
        !c.itemId &&
        owner(c)?.id === row.id &&
        !products.some((p) => p.candidate.line === c.line),
    );
    if (pending.length === 1 && quantities.length === 1) {
      const i = pending[0];
      i.quantity = Number(q.value);
      i.quantityConfirmed = true;
      i.sources!.push({
        start: q.start,
        end: q.end,
        targetId: i.id,
        recipientId: row.id,
        field: "quantity",
        text: q.text,
      });
      q.recipientId = row.id;
      q.itemId = i.id;
    }
  }
  // Do not lose unlabelled contact evidence, including invalid short numbers, after a named/addressed block.
  for (const row of rows) {
    const address = row.sources?.find((s) => s.field === "address");
    if (address) row.addressStatus = undefined;
  }
  for (const candidate of candidates.filter(
    (c) =>
      !c.recipientId &&
      ["product", "quantity"].includes(c.kind) &&
      !products.some((p) => p.common && p.candidate.id === c.id),
  )) {
    const row = owner(candidate) ?? rows[0];
    if (row) {
      row.unassignedEvidence ??= [];
      row.unassignedEvidence.push(structuredClone(candidate));
    }
  }
  return {
    recipients: rows,
    candidates,
    unassigned: candidates.filter((c) => !c.recipientId).map((c) => c.id),
  };
}

export function matchingRecipient(
  incoming: Recipient,
  previous: Recipient[],
  used = new Set<string>(),
  incomingRows = [incoming],
) {
  const eligible = previous.filter((r) => !used.has(r.id));
  const names = (row: Recipient) => [
    ...new Set(row.sources?.filter((s) => s.field === "name").map((s) => s.text.trim()) ?? []),
  ];
  const sameIdentity = (row: Recipient) => {
    const a = names(incoming),
      b = names(row);
    return a.length === 1 && b.length === 1
      ? a[0] === b[0]
      : !a.length &&
          !b.length &&
          incoming.address === row.address &&
          incoming.mobile === row.mobile &&
          incoming.phone === row.phone;
  };
  const exact = eligible.filter(
    (r) =>
      incoming.evidence?.anchorId &&
      r.evidence?.anchorId === incoming.evidence.anchorId &&
      sameIdentity(r),
  );
  if (exact.length === 1) return exact[0];
  const name = incoming.sources?.find((s) => s.field === "name");
  const bySource = eligible.filter(
    (r) =>
      name &&
      r.sources?.some(
        (s) => s.field === "name" && s.start === name.start && s.text === name.text,
      ) &&
      new Set(r.sources?.filter((s) => s.field === "name").map((s) => s.text)).size === 1,
  );
  if (bySource.length === 1) return bySource[0];
  const candidates = eligible.filter(sameIdentity);
  return candidates.length === 1 && incomingRows.filter(sameIdentity).length === 1
    ? candidates[0]
    : undefined;
}
