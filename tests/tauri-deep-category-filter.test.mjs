import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const cache = new Map();
function load(name) {
  const path = name.endsWith(".ts") ? name : name + ".ts";
  if (cache.has(path)) return cache.get(path).exports;
  const module = { exports: {} };
  cache.set(path, module);
  const code = ts.transpileModule(read("src/" + path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = (id) => {
    if (!id.startsWith(".")) throw Error("Unexpected runtime dependency: " + id);
    return load(posix.normalize(posix.join(posix.dirname(path), id)).replace(/\.js$/, ".ts"));
  };
  vm.runInNewContext(code, { module, exports: module.exports, require: localRequire }, { filename: path });
  return module.exports;
}

const ROOT = "catalog-root:BANDOSTAND";
const OTHER = "catalog-root:BANDOMALL";
const categories = [
  { id: "stand", name: "스탠드", parentId: ROOT },
  { id: "mic", name: "마이크", parentId: "stand" },
  { id: "desktop", name: "탁상", parentId: "mic" },
  { id: "tbar", name: "T자형", parentId: "desktop" },
  { id: "small", name: "소형", parentId: "tbar" },
  { id: "silver", name: "실버", parentId: "small" },
  { id: "black", name: "블랙", parentId: "small" },
  { id: "large", name: "대형", parentId: "tbar" },
  { id: "other", name: "다른 상품", parentId: OTHER },
];
const products = [
  { id: "s", categories: ["silver"], brandId: "bd" },
  { id: "b", categories: ["black"], brandId: "bd" },
  { id: "l", categories: ["large"], brandId: "other" },
  { id: "o", categories: ["other"], brandId: "other" },
];
const state = { categories, products, brands: [] };

test("cascading category filter exposes a dropdown for every saved depth without a fixed 2-level cap", () => {
  const { categoryFilterLevels } = load("category-filter-levels");
  const levels = categoryFilterLevels(categories, "silver");
  assert.equal(levels.length, 7);
  assert.equal(levels[0].selectedId, ROOT);
  assert.equal(levels[1].selectedId, "stand");
  assert.equal(levels[2].selectedId, "mic");
  assert.equal(levels[3].selectedId, "desktop");
  assert.equal(levels[4].selectedId, "tbar");
  assert.equal(levels[5].selectedId, "small");
  assert.equal(levels[6].selectedId, "silver");
  assert.equal(levels[6].children.length, 2);
  const parent = categoryFilterLevels(categories, "small");
  assert.equal(parent.at(-1).parentId, "small");
  assert.equal(parent.at(-1).selectedId, "");
  assert.equal(parent.at(-1).children.length, 2);
  const root = categoryFilterLevels(categories, "");
  assert.equal(root.length, 1);
  assert.ok(root[0].children.some((node) => node.id === ROOT));
  assert.ok(root[0].children.some((node) => node.id === OTHER));
});

test("parent categories match every descendant while a deeply selected leaf excludes siblings", () => {
  const { classifiedProducts } = load("product-registry");
  const ids = (category, brand = "") =>
    classifiedProducts(state, category, "", brand).map((p) => p.id).sort().join(",");
  assert.equal(ids(""), "b,l,o,s");
  assert.equal(ids(ROOT), "b,l,s");
  assert.equal(ids("stand"), "b,l,s");
  assert.equal(ids("tbar"), "b,l,s");
  assert.equal(ids("small"), "b,s");
  assert.equal(ids("silver"), "s");
  assert.equal(ids("small", "bd"), "b,s");
  assert.equal(ids("small", "other"), "");
  assert.equal(ids(OTHER), "o");
});

test("deleted or unknown selection cannot fabricate a category path and product-sync tab is gone", () => {
  const { categoryFilterLevels } = load("category-filter-levels");
  const levels = categoryFilterLevels(categories, "missing-category");
  assert.equal(levels.length, 1);
  assert.equal(levels[0].selectedId, "");
  const component = read("src/ProductManager.tsx");
  const filter = read("src/Classification.tsx");
  assert.doesNotMatch(component, /"상품 동기화"/);
  assert.doesNotMatch(component, /<CatalogPanel\b/);
  assert.match(component, /<ProductSyncWorkbookTools\b/);
  assert.match(component, /category=\{category\}/);
  assert.match(filter, /levels\.map\(\(level\)/);
  assert.match(filter, /onChange\(event\.target\.value \|\| level\.parentId \|\| "", brand\)/);
});
