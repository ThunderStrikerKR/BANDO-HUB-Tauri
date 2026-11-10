import assert from "node:assert/strict";
import test from "node:test";
import { auditCSS } from "../scripts/audit-css-ownership.mjs";

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
