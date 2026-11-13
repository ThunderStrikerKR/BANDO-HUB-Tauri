/**
 * Read-only source-graph audit for removing legacy TS business algorithms.
 *
 * npm run audit:ts-business
 * npm run audit:ts-business -- --json
 * npm run audit:ts-business -- --strict
 *
 * Strict intentionally fails until every tracked legacy business module is
 * unreachable from the app entrypoint. Never use "unused" as proof of safety
 * without dynamic imports, persistence compatibility and test-oracle review.
 */
import ts from "typescript";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const src=join(root,"src");
const liveEntry=join(src,"main.tsx");
const targets=[
  "domain.ts","workflow.ts","shipping.ts","parser.ts","matching.ts",
  "order-evidence.ts","validation.ts","issue-actions.ts","corrections.ts",
  "working-raw.ts","orders/retail.ts","orders/manual-classification.ts",
  "orders/reception.ts","replies.ts","automatic-message.ts",
  "hub-messages.ts","message-model.ts","automatic-message-templates.ts",
  "customer-questions.ts","factory-replies.ts","factory-reply-workbook.ts",
  "factory-reply-auto.ts","factory-export.ts","store-export.ts",
  "app/order-history.ts","app/settlement-report.ts","client-workbook.ts",
  "product-sync-workbook.ts","product-unified-workbook.ts",
  "product-registration-xlsx.ts","orders/passive-pricing.ts",
];
function discover(path) {
  return readdirSync(path,{withFileTypes:true}).flatMap(entry=>{
    const file=join(path,entry.name);
    if(entry.isDirectory())return discover(file);
    return /\.(?:ts|tsx)$/.test(entry.name)&&!entry.name.endsWith(".d.ts")?[file]:[];
  });
}
const all=discover(src);
const known=new Set(all);
function resolveSpecifier(from,spec) {
  if(!spec.startsWith("."))return null;
  const base=resolve(dirname(from),spec);
  const short=base.replace(/\.(?:js|jsx|ts|tsx)$/,"");
  for(const candidate of [base,short+".ts",short+".tsx",join(short,"index.ts"),join(short,"index.tsx")])
    if(known.has(candidate))return candidate;
  return null;
}
function sourceImports(file) {
  const text=readFileSync(file,"utf8");
  const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,
    extname(file)===".tsx"?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const deps=new Set();
  function visit(node) {
    let module;
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier
        &&ts.isStringLiteral(node.moduleSpecifier)){
      module=node.moduleSpecifier.text;
    }else if(ts.isCallExpression(node)&&node.arguments.length===1
        &&ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind===ts.SyntaxKind.ImportKeyword ||
         ts.isIdentifier(node.expression)&&node.expression.text==="require")){
      module=node.arguments[0].text;
    }
    if(module){
      const imported=resolveSpecifier(file,module);
      if(imported)deps.add(imported);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  return [...deps];
}
const graph=new Map(all.map(file=>[file,sourceImports(file)]));
const reachable=new Set();
const stack=[liveEntry];
while(stack.length){
  const current=stack.pop();
  if(reachable.has(current))continue;
  reachable.add(current);
  stack.push(...(graph.get(current)??[]));
}
const rows=targets.map(file=>{
  const absolute=join(src,file);
  const importers=[...graph.entries()].filter(([,deps])=>deps.includes(absolute))
    .map(([from])=>relative(root,from).replaceAll("\\","/"));
  return {
    module:"src/"+file,
    exists:existsSync(absolute),
    reachableFromApp:reachable.has(absolute),
    directRuntimeImporters:importers.filter(x=>reachable.has(join(root,x))),
    directAllImporters:importers,
    // Legacy code may still be deliberately retained for differential tests.
    classification:reachable.has(absolute)?"LIVE_TS_BUSINESS_DEPENDENCY":"ORACLE_OR_REVIEW_CANDIDATE",
  };
});
const report={
  version:1,entry:"src/main.tsx",
  inspectedSourceFiles:all.length,liveReachableSourceFiles:reachable.size,
  trackedLegacyModules:rows.length,
  reachableLegacyModules:rows.filter(row=>row.reachableFromApp).length,
  inventory:rows
};
if(process.argv.includes("--json"))console.log(JSON.stringify(report,null,2));
else{
  console.log("TSBH TypeScript retirement inventory");
  console.log("Entry",report.entry,"| examined",all.length,"source files");
  console.log("Live legacy modules:",report.reachableLegacyModules,"/",rows.length);
  for(const row of rows)console.log(
    row.reachableFromApp?"LIVE  ":"REVIEW ",
    row.module,"| live importers:",row.directRuntimeImporters.length);
  console.log("Read docs/rust-migration/03-ts-retirement-checklist.md before deletions.");
}
if(process.argv.includes("--strict")&&report.reachableLegacyModules>0){
  console.error("BLOCKED: TS business runtime dependencies remain.");
  process.exitCode=1;
}
