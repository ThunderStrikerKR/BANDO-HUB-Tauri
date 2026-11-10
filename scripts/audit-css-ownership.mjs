import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(resolve(root, name), "utf8");

function splitSelectors(input) {
  const result = [];
  let part = "", depth = 0, quote = "";
  for (const ch of input) {
    if (quote) { part += ch; if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; part += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      if (part.trim()) result.push(part.trim().replace(/\s+/g, " "));
      part = ""; continue;
    }
    part += ch;
  }
  if (part.trim()) result.push(part.trim().replace(/\s+/g, " "));
  return result;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
}

function parseStyle(path, order) {
  const content = stripComments(read("src/styles/" + path));
  const declarations = [], stack = [];
  let cursor = 0, quote = "";
  for (let i = 0; i < content.length; i++) {
    const ch = content[i], prev = content[i - 1];
    if (quote) {
      if (ch === quote && prev !== "\\") quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "{") {
      stack.push({prelude: content.slice(cursor, i).trim(), at: i});
      cursor = i + 1;
    } else if (ch === "}") {
      const block = stack.pop();
      if (!block) continue;
      if (block.prelude && !block.prelude.startsWith("@")) {
        const inside = content.slice(block.at + 1, i);
        const contexts = stack.filter((entry) => entry.prelude.startsWith("@"))
          .map((entry) => entry.prelude.replace(/\s+/g, " "));
        if (!inside.includes("{") && !contexts.some((item) => /@(?:-webkit-)?keyframes\b/.test(item))) {
          const line = content.slice(0, block.at).split("\n").length;
          for (const raw of inside.split(";")) {
            const separator = raw.indexOf(":");
            if (separator < 1) continue;
            const property = raw.slice(0, separator).trim().toLowerCase();
            const value = raw.slice(separator + 1).trim().replace(/\s+/g, " ");
            if (!/^(--[a-z\d-]+|[a-z-]+)$/.test(property) || !value) continue;
            for (const selector of splitSelectors(block.prelude)) {
              declarations.push({path, order, line, context: contexts.join(" / ") || "base",
                selector, property, value});
            }
          }
        }
      }
      cursor = i + 1;
    }
  }
  return declarations;
}

export function collectStyleSources() {
  const index = read("src/styles/index.css"), main = read("src/main.tsx");
  const nested = [...index.matchAll(/@import\s+["']\.\/([^"']+\.css)["']/g)]
    .map((match) => match[1]);
  const direct = [...main.matchAll(/import\s+["']\.\/styles\/([^"']+\.css)["']/g)]
    .map((match) => match[1]).filter((file) => file !== "index.css");
  return [...nested, ...direct];
}

export function auditCSS() {
  const files = collectStyleSources();
  const declarations = files.flatMap((file, index) => parseStyle(file, index));
  const grouped = new Map();
  for (const declaration of declarations) {
    const key = [declaration.context, declaration.selector, declaration.property].join(" | ");
    const values = grouped.get(key) || [];
    values.push(declaration);
    grouped.set(key, values);
  }
  const repeated = [...grouped.entries()].filter(([, records]) => records.length > 1);
  const crossFile = repeated.filter(([, records]) => new Set(records.map((record) => record.path)).size > 1);
  const conflicts = repeated.filter(([, records]) => new Set(records.map((record) => record.value)).size > 1);
  const crossFileConflicts = conflicts.filter(([, records]) => new Set(records.map((record) => record.path)).size > 1);

  // Same-element candidates that differ only by the app/management scope.
  // These require computed-style review; unlike exact selectors, their
  // different specificity means a later file does not necessarily win.
  const stripScope = (selector) => selector
    .replace(/^\\.app-v03\\s+\\.management-container\\s+/, "")
    .replace(/^\\.app-v03\\s+/, "")
    .replace(/^\\.management-container\\s+/, "");
  const scoped = new Map();
  for (const record of declarations) {
    const normalized = stripScope(record.selector);
    const key = [record.context, normalized, record.property].join(" | ");
    const values = scoped.get(key) || [];
    values.push(record);
    scoped.set(key, values);
  }
  const scopedOverlaps = [...scoped.entries()].filter(([, records]) =>
    new Set(records.map((record) => record.selector)).size > 1 &&
    new Set(records.map((record) => record.value)).size > 1);
  return {files, declarations, repeated, crossFile, conflicts, crossFileConflicts, scopedOverlaps};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = auditCSS();
  const summary = {
    loadedStyleFiles: report.files.length,
    declarationCount: report.declarations.length,
    repeatedExactPropertyKeys: report.repeated.length,
    crossFileRepeatedKeys: report.crossFile.length,
    valueConflicts: report.conflicts.length,
    crossFileValueConflicts: report.crossFileConflicts.length,
    differentSpecificityCandidates: report.scopedOverlaps.length,
  };
  const hot = report.crossFileConflicts.map(([key, entries]) => ({
    key, definitions: entries.map((e) => `${e.path}:${e.line} = ${e.value}`),
  })).sort((a, b) => b.definitions.length - a.definitions.length);
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify({summary, crossFileConflicts: hot,
      scopedOverlaps: report.scopedOverlaps}, null, 2) + "\n");
  } else {
    console.log("CSS audit", JSON.stringify(summary));
    for (const row of hot.slice(0, 40)) console.log(row.key + "\n  " + row.definitions.join("\n  "));
  }
}
