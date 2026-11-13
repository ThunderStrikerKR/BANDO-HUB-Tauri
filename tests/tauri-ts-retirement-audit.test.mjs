import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const root=fileURLToPath(new URL("../",import.meta.url));
const script=fileURLToPath(new URL("../scripts/audit-ts-business-retirement.mjs",import.meta.url));
test("TypeScript business retirement audit reads actual app source import graph",()=>{
  const run=spawnSync(process.execPath,[script,"--json"],{
    cwd:root,encoding:"utf8",timeout:60000,maxBuffer:8*1024*1024,
  });
  assert.equal(run.status,0,run.stderr);
  const output=JSON.parse(run.stdout);
  assert.equal(output.entry,"src/main.tsx");
  assert.ok(output.inspectedSourceFiles>100);
  assert.ok(output.trackedLegacyModules>=25);
  assert.ok(output.reachableLegacyModules>0,
    "Business layer removal cannot be declared complete while live TS imports remain");
  assert.ok(output.inventory.some(row=>
    row.module==="src/automatic-message.ts"&&row.exists&&!row.reachableFromApp),
    "Original automatic-message oracle must be retained but unreachable from the live app");
  assert.ok(output.inventory.some(row=>
    row.module==="src/factory-export.ts"&&row.exists&&row.reachableFromApp),
    "ExcelJS serializer remains a legitimate TS module");
});
test("strict TS retirement audit fails while business implementation is still live",()=>{
  const run=spawnSync(process.execPath,[script,"--strict"],{
    cwd:root,encoding:"utf8",timeout:60000,
  });
  assert.equal(run.status,1);
  assert.match(run.stderr,/BLOCKED: TS business runtime dependencies remain/);
});
