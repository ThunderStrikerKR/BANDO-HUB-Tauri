import { descendants } from "./category-tree.js";
import { colorLabel } from "./product-models.js";
import type { Category, Product, State } from "./types.js";
export interface Brand {
  id: string;
  name: string;
  korean: string;
  aliases: string[];
  evidenceUrl: string;
}
export interface SourceLink {
  id: string;
  site: string;
  productNo: string;
  optionId: string;
  option: string;
  url: string;
  productId: string;
  reason: string;
  verifiedAt: string;
  externalId?: string;
}
export interface RegistrationRow {
  row: number;
  values: Record<string, string>;
  status: "READY" | "ERROR" | "DUPLICATE" | "HOLD";
  errors: string[];
  duplicateIds: string[];
  identity: string;
  product?: Product;
}
export interface RegistrationBatch {
  id: string;
  fingerprint: string;
  at: string;
  actor: string;
  rows: RegistrationRow[];
  createdIds: string[];
}
export const registryKey = (s: string) =>
  s.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
export function validateBrands(state: State, before: State) {
  for (const brand of state.brands ?? []) {
    if (JSON.stringify(before.brands?.find((b) => b.id === brand.id)) === JSON.stringify(brand))
      continue;
    const terms = [brand.name, brand.korean, ...brand.aliases].filter(Boolean).map(registryKey);
    if (
      !brand.name.trim() ||
      (state.brands ?? []).some(
        (other) =>
          other.id !== brand.id &&
          [other.name, other.korean, ...other.aliases]
            .filter(Boolean)
            .some((term) => terms.includes(registryKey(term))),
      )
    )
      throw Error("동일 브랜드명/한글명/검색 별칭이 이미 있습니다. 기존 브랜드를 정정하세요.");
  }
}
export function initialClassification(existing: Category[] = []) {
  const next = structuredClone(existing);
  for (const name of [
    "기타(전기)",
    "기타(어쿠스틱)",
    "기타(클래식)",
    "베이스",
    "우쿨렐레",
    "보면대",
    "마이크 스탠드",
    "스피커 스탠드",
    "키보드 스탠드",
    "스탠드 악세사리",
    "케이블·변환젠더",
    "공구·관리용품",
    "튜너·메트로놈",
  ])
    if (!next.some((c) => !c.parentId && c.name === name))
      next.push({ id: "major:" + name, name, parentId: null });
  for (const name of ["보면대", "마이크 스탠드", "스피커 스탠드", "키보드 스탠드"]) {
    const root = next.find((c) => !c.parentId && c.name === name)!,
      accessory = next.find((c) => !c.parentId && c.name === "스탠드 악세사리")!;
    for (const [parentId, child] of [
      [root.id, "악세사리"],
      [accessory.id, name],
    ])
      if (!next.some((c) => c.parentId === parentId && c.name === child))
        next.push({ id: parentId + "/" + child, name: child, parentId });
  }
  for (const [major, minor] of [
    ["기타(전기)", "카포"],
    ["기타(어쿠스틱)", "카포"],
    ["기타(전기)", "피크"],
    ["기타(전기)", "스트랩 부품"],
    ["공구·관리용품", "스트링 커터"],
    ["케이블·변환젠더", "악기 케이블"],
    ["튜너·메트로놈", "튜너"],
  ]) {
    const parent = next.find((c) => !c.parentId && c.name === major);
    if (parent && !next.some((c) => c.parentId === parent.id && c.name === minor))
      next.push({
        id: parent.id + "/" + minor,
        name: minor,
        parentId: parent.id,
      });
  }
  return next;
}
/** Query reverse stand accessory paths without duplicating products. Links are explicit. */
export function categoryIds(state: State, major: string, minor = "") {
  const cats = state.categories ?? [],
    selected = minor
      ? cats.filter((c) => c.id === minor)
      : cats.filter((c) => c.id === major || c.parentId === major),
    ids = new Set([...selected.map((c) => c.id), ...descendants(cats, minor || major)]);
  for (const c of selected) {
    const parent = cats.find((p) => p.id === c.parentId);
    if (c.name === "악세사리" && parent) {
      for (const reverse of cats.filter(
        (x) =>
          x.name === parent.name &&
          cats.some((p) => p.id === x.parentId && p.name === "스탠드 악세사리"),
      ))
        ids.add(reverse.id);
    }
    if (parent?.name === "스탠드 악세사리")
      for (const reverse of cats.filter(
        (x) => x.name === "악세사리" && cats.some((p) => p.id === x.parentId && p.name === c.name),
      ))
        ids.add(reverse.id);
  }
  return ids;
}
export function classifiedProducts(state: State, major = "", minor = "", brand = "") {
  const ids = categoryIds(state, major, minor);
  return state.products.filter(
    (p) =>
      !p.deletedAt &&
      !p.supersededBy &&
      (!brand || p.brandId === brand) &&
      (!major || (p.categories ?? []).some((c) => ids.has(c))),
  );
}
export function brandTerms(state: State, p: Product) {
  const b = state.brands?.find((b) => b.id === p.brandId);
  return b ? [b.name, b.korean, ...b.aliases].filter(Boolean) : [];
}
export function registryIdentity(values: Record<string, string>) {
  return [
    values["브랜드"],
    values["제조사 모델코드"] || values["최종 등록명"],
    colorLabel(values["색상"] ?? ""),
    values["규격"],
    values["판매 단위"],
  ]
    .map(registryKey)
    .join("|");
}

/** Initial reviewed dictionary, not inferred from uploaded rows. No links to old products are assigned. */
export const initialBrands: Brand[] = [
  {
    id: "brand-shubb",
    name: "Shubb",
    korean: "셔브",
    aliases: ["셔브 Shubb"],
    evidenceUrl: "https://shubb.com/products/shubb-steel-string-guitar-capo",
  },
  {
    id: "brand-gotoh",
    name: "GOTOH",
    korean: "고또",
    aliases: ["고또 Gotoh"],
    evidenceUrl: "https://g-gotoh.com/product/sg381/",
  },
  {
    id: "brand-clayton",
    name: "Clayton",
    korean: "클레이튼",
    aliases: ["Clayton 클레이튼"],
    evidenceUrl: "https://bandomall.co.kr/product/detail.html?product_no=3449",
  },
  {
    id: "brand-schaller",
    name: "Schaller",
    korean: "쉘러",
    aliases: ["쉘러 Schaller"],
    evidenceUrl: "https://bandomall.co.kr/product/detail.html?product_no=9327",
  },
  {
    id: "brand-orca",
    name: "ORCA",
    korean: "오르카",
    aliases: ["오르카 ORCA", "ORCA 오르카"],
    evidenceUrl: "https://bandomall.co.kr/product/detail.html?product_no=9621",
  },
];
