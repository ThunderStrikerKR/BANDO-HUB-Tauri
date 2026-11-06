import type { Product } from "./types.js";

// Official option IDs and values from product pages 134–138. Product 138 lists right, then left.
const models = {
  "134": {
    model: "BD Z",
    options: {
      P00000FD000L: ["바퀴 추가 안함", "바퀴 미포함"],
      P00000FD000M: ["바퀴 추가", "바퀴 포함"],
    },
  },
  "135": {
    model: "BD Z-S",
    options: {
      P00000FE000F: ["바퀴 추가 안함", "바퀴 미포함"],
      P00000FE000G: ["바퀴 추가", "바퀴 포함"],
    },
  },
  "136": {
    model: "BD Z-2",
    options: {
      P00000FF000F: ["바퀴 추가 안함", "바퀴 미포함"],
      P00000FF000G: ["바퀴 추가", "바퀴 포함"],
    },
  },
  "137": {
    model: "BD Z-3",
    options: {
      P00000FG000F: ["37x29cm", "상판 37 × 29 cm"],
      P00000FG000G: ["42x34cm(추가금)", "상판 42 × 34 cm"],
    },
  },
  "138": {
    model: "BD Z-4",
    options: {
      P00000FH000F: ["37 x 29cm-37 x 29cm", "오른쪽 37 × 29 cm / 왼쪽 37 × 29 cm"],
      P00000FH000G: ["37 x 29cm-42 x 34cm", "오른쪽 37 × 29 cm / 왼쪽 42 × 34 cm"],
      P00000FH000H: ["42 x 34cm-37 x 29cm", "오른쪽 42 × 34 cm / 왼쪽 37 × 29 cm"],
      P00000FH000I: ["42 x 34cm-42 x 34cm", "오른쪽 42 × 34 cm / 왼쪽 42 × 34 cm"],
    },
  },
} satisfies Record<string, { model: string; options: Record<string, [string, string]> }>;

export function zProductDisplay(product: Product) {
  const site = product.siteId;
  if (
    !site ||
    !Object.hasOwn(models, site) ||
    product.catalog !== "BANDOSTAND" ||
    product.deletedAt ||
    product.supersededBy ||
    product.variants.length !== 1
  )
    return;
  const variant = product.variants[0];
  const { model, options } = models[site as keyof typeof models];
  const id = variant.siteOptionId;
  if (
    variant.source !== "OFFICIAL" ||
    variant.siteProductId !== site ||
    !id ||
    !Object.hasOwn(options, id)
  )
    return;
  const [raw, label] = (options as Record<string, [string, string]>)[id];
  if (variant.option?.replace(/\s+/g, " ").trim() !== raw) return;
  const original = `반도스탠드 ${model}`;
  if (product.originalName !== original) return;
  const oldDisplay = `${original} — ${variant.option.trim()}`;
  const name = `${model} (${label})`;
  const subtitle =
    site === "138"
      ? "키보드 스탠드 / 좌우 상판 조합"
      : site === "137"
        ? "키보드 스탠드 / 상판 규격"
        : "키보드 스탠드 / 바퀴 옵션";
  // Apply only to default or v0.8.09-generated labels, never to staff-edited labels.
  if (
    ![model, original, oldDisplay, name].includes(product.name) ||
    !["", variant.option.trim(), subtitle].includes(product.subtitle ?? "")
  )
    return;
  return { name, subtitle };
}
