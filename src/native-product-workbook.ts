/** Tauri adapter for unified product/price XLSX previews.
 * ExcelJS performs only file parsing and fixed column projection; Rust owns
 * all candidate mutations, duplicate decisions, status and price audit rows.
 */
import {readUnifiedProductWorkbookRows} from "./product-unified-workbook";
import {businessCoreCall} from "./tauri-bridge";
import type {ProductSyncPreview,WorkbookSource} from "./product-sync-workbook";
import type {State} from "./types";

export async function previewNativeUnifiedProductWorkbook(
  state: State, file: File,
): Promise<ProductSyncPreview> {
  const input=await readUnifiedProductWorkbookRows(file);
  const products: WorkbookSource["products"]=[];
  const options: WorkbookSource["options"]=[];
  for(const {row,cells:values} of input.rows) {
    if(!values.some(Boolean)) continue;
    const c=values.length===20
      ? [...values.slice(0,8),"",...values.slice(8)] : values;
    products.push({
      row,cells:[c[0],c[1],c[2],c[3],c[8],c[9],c[10],
        c[11],c[12],c[13],c[14],c[4],c[15],c[16]]
    });
    options.push({
      row,cells:[c[0],c[1],c[17],c[4],c[18],c[5],c[6],
        c[7],c[19],c[20]]
    });
  }
  const source:WorkbookSource={revision:input.revision,products,options};
  return businessCoreCall<ProductSyncPreview>("catalog_clients", "preview_product_sync_rows", {
    state,source,unified:true,
    productIds:products.map(()=>crypto.randomUUID()),
    optionIds:options.map(()=>crypto.randomUUID()),
    now:new Date().toISOString(),
  });
}
