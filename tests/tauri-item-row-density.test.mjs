import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read=(path)=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("product and freight item rows share compact cell and control dimensions",()=>{
  const styles=read("src/styles/table-density.css");
  for(const name of ["product-prices","shipping-product-list"]){
    assert.match(styles,new RegExp("\\."+name.replace(/-/g,"\\-")));
  }
  assert.match(styles,/height: 35px/);
  assert.match(styles,/padding-top: 3px/);
  assert.match(styles,/padding-bottom: 3px/);
  assert.match(styles,/min-height: 28px/);
  assert.match(styles,/input\[data-price-cell\]/);
  assert.match(styles,/\.price-cell small:empty/);
});
test("dense table styles are loaded after generic and product styles",()=>{
  const main=read("src/main.tsx");
  assert.ok(main.indexOf('import "./styles/table-density.css"') >
            main.indexOf('import "./styles/tauri-stage2-products.css"'));
  assert.match(read("src/ProductFreightPanel.tsx"),
    /className="shipping-card shipping-product-list"/);
  assert.match(read("src/PriceCell.tsx"),/\{error \|\| status\}/);
});
