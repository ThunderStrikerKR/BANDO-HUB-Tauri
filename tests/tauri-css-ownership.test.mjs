import assert from "node:assert/strict";
import test from "node:test";
import { auditCSS } from "../scripts/audit-css-ownership.mjs";
import { readFileSync } from "node:fs";

test("CSS ownership audit includes every imported stylesheet in actual cascade order", () => {
  const report = auditCSS();
  assert.equal(report.files.length, 26);
  assert.equal(report.files[0], "tokens.css");
  assert.equal(report.files.at(-1), "management-layout.css");
  assert.equal(new Set(report.files).size, report.files.length);
  assert.ok(report.declarations.length > 1500,
    "Audit missed nested or imported CSS declarations");
  const summary = {
    styles: report.files.length, declarations: report.declarations.length,
    repeated: report.repeated.length, crossFile: report.crossFile.length,
    differingValues: report.conflicts.length, crossFileDifferingValues: report.crossFileConflicts.length,
    differingSpecificity: report.scopedOverlaps.length,
  };
  console.log("CSS_AUDIT_TOTAL", JSON.stringify(summary));
  const priority = report.crossFileConflicts
    .filter(([key]) => /card|field|app-header|management|shipping|empty|button|input|table/.test(key))
    .sort((a,b) => b[1].length - a[1].length)
    .slice(0, 24).map(([key, records]) => ({
      key, definitions: records.map(r => r.path + ":" + r.line + "=" + r.value),
    }));
  console.log("CSS_AUDIT_PRIORITY", JSON.stringify(priority));
  const scoped = report.scopedOverlaps
    .filter(([key]) => /field|card|management|table|button|input|empty/.test(key))
    .slice(0, 14).map(([key, records]) => ({
      key, definitions: records.map(r => r.selector + " @ " + r.path + ":" + r.line + "=" + r.value),
    }));
  console.log("CSS_AUDIT_SCOPED", JSON.stringify(scoped));
});

test("shared management table and empty-state layout have explicit style owners", () => {
  const report = auditCSS();
  const owner = (selector, property, context = "base") =>
    report.declarations.filter((record) =>
      record.context === context && record.selector === selector && record.property === property);
  assert.deepEqual(
    [...new Set(owner(".empty-state-compact", "min-height").map((r) => r.path))],
    ["components.css"],
  );
  assert.ok(owner(".app-v03 .management-container table.management-data-table", "table-layout")
    .every((r) => r.path === "management-layout.css"));
  assert.ok(owner(".app-v03 .management-container table.management-data-table tbody td", "padding")
    .every((r) => r.path === "management-layout.css"));
});

test("core layout tokens are not overridden from competing legacy files", () => {
  const report = auditCSS();
  const declarations = (selector, property, context = "base") =>
    report.declarations.filter((record) =>
      record.selector === selector && record.property === property && record.context === context);
  const filesFor = (selector, property) =>
    [...new Set(declarations(selector, property).map((r) => r.path))];
  assert.deepEqual(filesFor(".app-header", "background"), ["theme.css"]);
  assert.deepEqual(filesFor(".app-header", "height"), ["theme.css"]);
  assert.deepEqual(filesFor(".app-header", "border-bottom"), ["theme.css"]);
  assert.deepEqual(filesFor(".shipping-stats", "gap"), ["shipping.css"]);
  assert.deepEqual(filesFor(".shipping-stats", "margin-bottom"), ["shipping.css"]);
  assert.deepEqual(filesFor(".shipping-table-scroll", "max-height"), ["theme.css"]);
  const tokenCss = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  const components = readFileSync(new URL("../src/styles/components.css", import.meta.url), "utf8");
  assert.match(tokenCss, /--field-label-size:/);
  assert.match(components, /font-size: var\(--field-label-size\)/);
  assert.deepEqual(filesFor(".field > .field-label", "font-size"), ["components.css"]);
});
