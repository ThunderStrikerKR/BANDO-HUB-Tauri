// Source-guarded 15-SKU color correction for the committed seed.
// By default: audit only, no writes. Explicit --apply modifies only
// src-tauri/resources/state-seed.json, so run it in the integration/data
// ownership session, not while session 1 is editing recognition sources.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const seedPath = resolve(root, "src-tauri/resources/state-seed.json");
const manifestPath = resolve(here, "catalog-color-corrections-15.json");
const apply = process.argv.slice(2).includes("--apply");
if (process.argv.slice(2).some(v => v !== "--apply" && v !== "--check")) {
  throw new Error("Supported flags: --check (default) or --apply");
}
const input = await readFile(seedPath, "utf8");
const state = JSON.parse(input);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schema !== "tsbh-recognition-catalog-color-corrections-v1")
  throw new Error("Unknown manifest schema");
if (!Array.isArray(state.products) || state.products.length !== 360 ||
  !Array.isArray(manifest.corrections) || manifest.corrections.length !== 15)
  throw new Error("Unexpected seed product or correction count");
const seen = new Set();
const summary = [];
for (const c of manifest.corrections) {
  if (seen.has(c.productId)) throw new Error("Duplicate productId "+c.productId);
  seen.add(c.productId);
  const p = state.products.find(x => x.id === c.productId);
  if (!p || p.active === false || p.deletedAt || p.supersededBy ||
    p.name !== c.expectedName || p.defaultColor !== c.expectedDefaultColor ||
    p.variants?.length !== 1 || p.variants[0].id !== c.variantId ||
    p.variants[0].color !== c.expectedVariantColor ||
    p.variants[0].url !== c.registeredSourceUrl) {
    throw new Error("Catalog changed since source review: " + c.productId);
  }
  const word = { Black: "블랙", Silver: "실버", Red: "레드" }[c.color];
  if (!word || !p.name.split("/").slice(1).some(s => s.trim() === word))
    throw new Error("Color lacks evidence in registered product name: "+p.id);
  p.defaultColor=c.color;
  p.variants[0].color=c.color;
  summary.push({ productId:p.id, variantId:c.variantId, name:p.name, color:c.color });
}
const changed=JSON.stringify(state,null,2)+"\n";
const hash=v=>createHash("sha256").update(v).digest("hex").slice(0,16);
const initialHash=hash(input);
if (apply) {
  // --apply changes shared catalog source; coordinate this with the
  // integration/data owner. It never modifies a live SQLite database.
  await writeFile(seedPath,changed,"utf8");
  console.log("APPLIED_CATALOG_COLOR_CORRECTIONS",JSON.stringify({
    count:summary.length,before:initialHash,after:hash(changed)
  }));
} else {
  console.log("DRY_RUN_ONLY_CATALOG_COLOR_CORRECTIONS",JSON.stringify({
    count:summary.length,original:initialHash,proposed:hash(changed)
  }));
}
for (const row of summary) console.log("COLOR_CORRECTION",JSON.stringify(row));
