import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (file) => readFileSync(fileURLToPath(new URL("../src/" + file, import.meta.url)), "utf8");

test("each inline price can be saved or cancelled by mouse without losing its draft on blur", () => {
  const cell = source("PriceCell.tsx");
  assert.match(cell, /className="price-cell-actions"/);
  assert.match(cell, /type="button"[\s\S]*?aria-label=\{label \+ " 저장"\}[\s\S]*?onClick=\{\(\) => void save\(\)\}/);
  assert.match(cell, /type="button"[\s\S]*?aria-label=\{label \+ " 취소"\}[\s\S]*?onClick=\{cancel\}/);
  assert.match(cell, /if \(e\.key === "Enter"\)[\s\S]*?void save\(\)/);
  assert.match(cell, /if \(e\.key === "Escape"\)[\s\S]*?cancel\(\)/);
  const blur = cell.slice(cell.indexOf("onBlur={() => {"), cell.indexOf("onKeyDown={(e) => {"));
  assert.ok(blur.length > 0 && blur.length < 1000);
  assert.doesNotMatch(blur, /setDraft\(|setEditing\(false\)|void save\(\)|await onSave\(/);
  assert.match(blur, /if \(pending\) setStatus\("미저장/);
});

test("inline price changes are persisted by expected-value protected native setPrice, not a TS table mutation", () => {
  const cell = source("PriceCell.tsx");
  const manager = source("ProductManager.tsx");
  assert.match(cell, /await onSave\(n, expected\.current\)/);
  assert.match(cell, /catch \(e\) \{[\s\S]*?setError\(readableError\(e\)\)/);
  assert.match(cell, /setEditing\(false\);[\s\S]*?catch \(e\)/);
  assert.match(manager, /await window\.bando!\.setPrice\(p\.id, v\.id, tier, n, expected\)/);
  assert.match(manager, /await onRefresh\(committed\)/);
  assert.doesNotMatch(manager, /const \{ next \} = .*priceHistory/);
});

test("price-table draft stays visible until Save/Cancel and remains guarded on filtering or page exit", () => {
  const cell = source("PriceCell.tsx");
  const manager = source("ProductManager.tsx");
  const css = source("styles/table-density.css");
  assert.match(cell, /value=\{editing \? draft : value === null \? "" : value\.toLocaleString/);
  assert.match(cell, /data-price-pending=\{pending\}/);
  assert.match(cell, /if \(lastReportedPending\.current === pending\) return/);
  assert.match(cell, /pendingRef\.current\?\.\(pending\)/);
  assert.match(manager, /hasChanges: \(\) => editDirty \|\| hasPendingPrices/);
  assert.match(manager, /const checkPriceDrafts = \(\) => \{/);
  assert.match(manager, /const togglePriceMode = \(\) => \{[\s\S]*?if \(!priceMode \|\| checkPriceDrafts\(\)\)/);
  assert.match(manager, /onChange=\{\(value\) => \{ if \(checkPriceDrafts\(\)\) setSearch\(value\); \}\}/);
  assert.match(css, /\.price-cell-actions\s*\{[\s\S]*?position:\s*absolute/);
  assert.match(css, /\.price-cell\.pending/);
});
