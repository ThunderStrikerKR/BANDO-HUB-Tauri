import type { Alias, Product, State } from "./types.js";
import { productModelNames } from "./product-name-match.js";
export const modelKey = (text: string) =>
  text.normalize("NFKC").toUpperCase().replace(/\s/g, "").replace(/^BD/, "");
export const internalModel = (text: string) =>
  text.replace(/^\[가상\]\s*/, "").replace(/^BD(?=\s|\d)\s*/i, "");
export const customerModel = (text: string) =>
  /^(?:\[가상\]\s*)?BD(?=\s|\d)|^\d/.test(text) ? "BD " + internalModel(text) : text;
export function categoryKind(text: string) {
  const key = text.replace(/\s/g, "").toLowerCase();
  return /키보드스탠드|건반스탠드|키보드/.test(key)
    ? "키보드"
    : /마이크스탠드|마이크/.test(key)
      ? "마이크"
      : /보면대|악보대/.test(key)
        ? "보면대"
        : undefined;
}
export function broadCategory(text: string) {
  return /^(반도\s*)?(보면대|악보대|마이크\s*스탠드|키보드\s*스탠드|건반\s*스탠드)$/i.test(
    text.trim(),
  );
}
export const sameProduct = (a: Product, b: Product) => a.id === b.id;
export function aliasProblems(a: Alias, all: Alias[], products: Product[]) {
  const target = products.find((p) => p.id === a.productId),
    key = modelKey(a.text),
    problems: string[] = [];
  if (!a.text.trim() || !target || target.deletedAt)
    problems.push("별칭과 연결할 상품을 입력하세요.");

  if (
    all.some(
      (x) =>
        x.id !== a.id &&
        x.clientId === a.clientId &&
        modelKey(x.text) === key &&
        (x.productId !== a.productId || x.variantId !== a.variantId),
    )
  )
    problems.push("같은 적용 범위의 별칭이 충돌합니다.");
  if (
    products.some(
      (p) =>
        !p.deletedAt &&
        !p.supersededBy &&
        [p.name, ...productModelNames(p)].some((name) => modelKey(name) === key) &&
        target &&
        !sameProduct(p, target),
    )
  )
    problems.push("다른 등록 상품명 또는 모델 표기와 충돌하는 별칭입니다.");
  const suffix = key.match(/^(\d{3}(?:-\d+)?)(BK|BR|B|C|W|G)$/);
  if (suffix && !products.some((p) => !p.deletedAt &&
    productModelNames(p).some(name=>modelKey(name)===key))) {
    const colors: Record<string, string> = {
        BK: "black",
        B: "black",
        BR: "brown",
        C: "chrome",
        W: "white",
        G: "gray",
      },
      labels: Record<string, string> = {
        블랙: "black",
        검정: "black",
        브라운: "brown",
        크롬: "chrome",
        화이트: "white",
        그레이: "gray",
        회색: "gray",
      },
      bases = products.filter((p) => !p.deletedAt &&
        productModelNames(p).some(name => modelKey(name) === suffix[1])),
      variant = target?.variants.find((v) => v.id === a.variantId);
    if (
      bases.length &&
      (!target ||
        !bases.some(base => sameProduct(base,target)) ||
        (variant && (labels[variant.color] ?? variant.color.toLowerCase()) !== colors[suffix[2]]))
    )
      problems.push("상품명의 색상 또는 구성 표기와 충돌하는 별칭입니다.");
  }
  if (a.variantId && !target?.variants.some((v) => v.id === a.variantId))
    problems.push("별칭 색상 / 옵션 연결을 확인하세요.");
  return problems;
}
export function saveAlias(state: State, record: Alias) {
  const next = structuredClone(state),
    same = next.aliases.find(
      (a) => a.clientId === record.clientId && modelKey(a.text) === modelKey(record.text),
    ),
    byId = next.aliases.find((a) => a.id === record.id);
  if (same && byId && same.id !== byId.id) throw Error("같은 적용 범위의 별칭이 이미 있습니다.");
  if (same && !byId && (same.productId !== record.productId || same.variantId !== record.variantId))
    throw Error("기존 별칭과 연결 상품이 충돌합니다. 기존 연결을 확인하세요.");
  const proposed = { ...record, id: byId?.id ?? same?.id ?? record.id };
  const errors = aliasProblems(proposed, next.aliases, next.products);
  if (errors.length) throw Error(errors.join("\n"));
  const existing = byId ?? same;
  if (existing) Object.assign(existing, proposed);
  else next.aliases.push(proposed);
  return next;
}
