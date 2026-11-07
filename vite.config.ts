import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const version: string = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
let buildId = "확인 불가";
try {
  buildId = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim() || buildId;
} catch {
  // A source export without .git still builds; no fabricated commit ID.
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  define: {
    __BANDO_VERSION__: JSON.stringify(version),
    __BANDO_BUILD_ID__: JSON.stringify(buildId),
  },
});
