/**
 * Supplemental production frontend asset audit.
 * A negative string scan is not proof that business algorithms are absent:
 * authoritative verification also requires source-call graph and Rust IPC checks.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.cwd(), "dist");
if (!existsSync(root)) throw new Error("Vite dist is missing; build first.");
function walk(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const full = join(path, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const names = walk(root).sort();
const js = names.filter((p) => /\.(?:js|mjs|html)$/.test(p));
const maps = names.filter((p) => p.endsWith(".map"));
const sources = names.filter((p) => /\.(?:ts|tsx|jsx)$/.test(p));
const fingerprints = [
  ["factory-export", "공장 이관이 완료된 배송 건인지 확인하세요."],
  ["store-export", "매장 이관이 완료된 배송 건인지 확인하세요."],
  ["factory-option-check", "공장 출고 상품과 가격 기록의 식별자가 다릅니다."],
  ["settlement", "입금 승인 기록 ID가 중복되었습니다."],
  ["message-template", "지원하지 않는 자동 메시지 유형입니다:"],
];
const contents = js.map((p) => [p, readFileSync(p, "utf8")]);
const hits = fingerprints.map(([name, needle]) => ({
  name, inFrontend: contents.filter(([, text]) => text.includes(needle))
    .map(([p]) => relative(root, p).replaceAll("\\", "/")),
}));
const manifest = {
  role: "supplemental_asset_scan_not_cryptographic_proof_of_algorithm_removal",
  files: js.map(([p]) => p),
  javascriptAssets: contents.map(([path, bytes]) => ({
    file: relative(root, path).replaceAll("\\", "/"),
    size: Buffer.byteLength(bytes, "utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })),
  sourceMaps: maps.map((p) => relative(root, p).replaceAll("\\", "/")),
  rawSourceFiles: sources.map((p) => relative(root, p).replaceAll("\\", "/")),
  fingerprints: hits,
};
delete manifest.files;
writeFileSync(join(root, "rust-core-bundle-audit.json"),
  JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({
  jsAssets: js.length, sourceMaps: maps.length, rawSourceFiles: sources.length,
  legacyFingerprints: hits.filter((hit) => hit.inFrontend.length).map((hit) => hit.name),
}, null, 2));
if (maps.length || sources.length) {
  throw new Error("Unsafe source maps or raw developer source files in packaged frontend.");
}
if (process.argv.includes("--strict") && hits.some((hit) => hit.inFrontend.length)) {
  throw new Error("Business-core fingerprints still exist in the production JavaScript.");
}
