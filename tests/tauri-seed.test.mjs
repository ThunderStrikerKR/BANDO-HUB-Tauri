import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const seed = JSON.parse(readFileSync(new URL('../src-tauri/resources/state-seed.json',import.meta.url),'utf8'));
const catalog = JSON.parse(readFileSync(new URL('../src-tauri/resources/catalog.json',import.meta.url),'utf8'));
test('product catalog retained and IDs unique', () => {
 assert.equal(seed.products.length,303);
 assert.equal(seed.products.length,catalog.products.length);
 assert.equal(new Set(seed.products.map(p=>p.id)).size,seed.products.length);
 const variants=seed.products.flatMap(p=>p.variants);
 assert.equal(variants.length,360);
 assert.equal(new Set(variants.map(v=>v.id)).size,variants.length);
});
test('empty fresh user data', () => {
 for(const name of ['orders','clients','aliases','exports','queue']) assert.deepEqual(seed[name],[]);
 assert.equal(seed.revision,0);
});
test('category hierarchy rooted by catalog', () => {
 const cats=new Map(seed.categories.map(c=>[c.id,c]));
 for(const root of ['catalog-root:BANDOSTAND','catalog-root:BANDOMALL']) assert.equal(cats.get(root)?.parentId,null);
 for(const cat of catalog.categories) {
  const mapped=cats.get(cat.id); assert.ok(mapped,cat.id);
  assert.equal(mapped.parentId,cat.parentId ?? 'catalog-root:BANDOSTAND');
 }
});
test('no demo product in seed', () => {
 assert.ok(seed.products.every(p => p.catalog !== 'DEMO' && p.variants.every(v => v.source !== 'DEMO')));
});
