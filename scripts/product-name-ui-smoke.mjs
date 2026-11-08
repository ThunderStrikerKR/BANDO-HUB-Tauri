import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright";

// A freshly migrated SQLite state is represented by the curated 360-product
// snapshot. SQLite migration itself is independently exercised in Rust tests.
const state = JSON.parse(readFileSync(
  new URL("../src-tauri/resources/state-seed.json", import.meta.url), "utf8"));
state.settings.factoryReplyDirectory = "";
const sourceName = state.products.find(p => p.siteId === "246")?.originalName;
assert.equal(sourceName,
  "반도스탠드 BD Desk JS-3 Black 검정 (자바라 길이 43cm)");
const server = spawn(process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
  { cwd: new URL("../", import.meta.url), stdio:["ignore","pipe","pipe"] });
let output = "";
server.stdout.on("data", c => output += c.toString());
server.stderr.on("data", c => output += c.toString());
let browser;
try {
  let ready = false;
  for (let n = 0; n < 80; n++) {
    if (server.exitCode !== null) throw Error("Vite exited: " + output);
    try {
      if ((await fetch("http://127.0.0.1:5173/",
        {signal: AbortSignal.timeout(1200)})).ok) {
        ready = true; break;
      }
    } catch {}
    await pause(500);
  }
  assert.ok(ready, "Vite did not start: " + output);
  browser = await chromium.launch({ headless:true });
  const page = await browser.newPage({viewport:{width:1640,height:1040}});
  page.setDefaultTimeout(14000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(({state}) => {
    window.__ciCalls = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      window.__ciCalls.push(command);
      switch(command) {
        case "workspace_mode": return false;
        case "startup_status": return {
          phase:"READY", error:null, attempts:1,
          databaseMs:10, readyMs:20, isTest:false,
        };
        case "startup_metrics": return {
          windowShownMs:null, databaseMs:10, dataMs:null, readyMs:20,
        };
        case "state_load": return structuredClone(state);
        case "dock_status_native": return {
          active:false, mode:"ORIGINAL", ratio:0.8,
        };
        case "dock_windows_native": return [];
        case "dock_region_native": return undefined;
        case "receipt_archive": return [];
        case "state_save": throw Error("Read-only UI test forbids native changes");
        default: throw Error("Unexpected native command: " + command);
      }
    }};
  }, {state});

  await page.goto("http://127.0.0.1:5173/");
  await page.getByRole("navigation",{name:"업무 메뉴"})
    .getByRole("button",{name:"상품 관리"}).click();
  await page.getByRole("textbox",{name:"상품 검색"}).fill("Desk JS-3");
  const table = page.locator("section.product-prices table");
  const rows = table.locator("tbody tr");
  await rows.filter({hasText:"BD Desk JS-3 / 블랙 / 자바라 길이 43cm"})
    .first().waitFor();
  await rows.filter({hasText:"BD Desk JS-3 / 실버 / 자바라 길이 43cm"})
    .first().waitFor();
  const content = await table.innerText();
  assert.ok(!content.includes("반도스탠드 BD Desk JS-3"));
  assert.ok(content.includes("BD Desk JS-3 / 블랙 / 자바라 길이 43cm"));
  assert.ok(content.includes("BD Desk JS-3 / 실버 / 자바라 길이 43cm"));
  await page.getByRole("textbox",{name:"상품 검색"}).fill("Desk TS-");
  for(const [model,length] of [["1","15"],["2","22"],["3","32"]]) {
    await rows.filter({hasText:`BD Desk TS-${model} / Bar 길이 ${length}cm`})
      .first().waitFor();
  }
  let tableText = await table.innerText();
  assert.ok(!tableText.includes("미니형 마이크 스탠드"));
  assert.ok(!tableText.includes("색상 확인 필요"));
  console.log("PASS UI: TS lengths appear in products and no invented color prompt");

  await page.getByRole("textbox",{name:"상품 검색"}).fill("뮤직");
  await rows.filter({hasText:"뮤직 트레이 / 다크 그린"}).first().waitFor();
  await rows.filter({hasText:"뮤직 트레이 / 와인"}).first().waitFor();
  await rows.filter({hasText:"뮤직 트레이 / 그레이"}).first().waitFor();
  tableText = await table.innerText();
  assert.ok(!tableText.includes("뮤직트레이 / 다크그린"));
  assert.ok(!tableText.includes("뮤직트레이 / 와인"));
  assert.ok(!tableText.includes("다크그린, 와인, 그레이 옵션"));
  assert.ok(!tableText.includes("색상 확인 필요"));
  console.log("PASS UI: three separate music-tray colors and no duplicate dark-green/wine listings");

  await page.getByRole("textbox",{name:"상품 검색"}).fill("LED");
  const ledTitles=[
    ["BD LED-2S / Mighty Bright Light","31,000"],
    ["BD LED-3 / Mighty Bright Light","31,000"],
    ["BD LED-2W / Mighty Bright Wonderflex / 보면대등","38,000"],
    ["BD LED-3N / Mighty Bright Nuflex / 보면대등","45,000"],
  ];
  for (const [name,price] of ledTitles) {
    const row=rows.filter({hasText:name}).first();
    await row.waitFor();
    const label=await row.locator(".product-title-line b").innerText();
    assert.equal(label.trim(),name);
    assert.ok((await row.innerText()).includes(price),name);
    assert.ok(!(await row.innerText()).includes("색상 확인 필요"),name);
  }
  const ledText=await table.innerText();
  assert.ok(!ledText.includes("Mighty Bright LED-2W Wonderflex"));
  assert.ok(!ledText.includes("Mighty Bright LED-3N Nuflex"));
  assert.ok(!ledText.includes("BD LED-2s"));
  console.log("PASS UI: four BD LED model-first names, correct retail price and no invented colors");

  assert.deepEqual(errors, []);
  assert.ok(!await page.evaluate(() => window.__ciCalls.includes("state_save")));
  console.log("PASS UI: product manager shows curated names and preserves read-only state");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
