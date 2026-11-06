import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
seed=json.loads((root/'src-tauri/resources/state-seed.json').read_text(encoding='utf-8'))
catalog=json.loads((root/'src-tauri/resources/catalog.json').read_text(encoding='utf-8'))
products=seed['products']
assert len(products)==303
assert seed['orders']==[] and seed['clients']==[] and seed['aliases']==[]
assert len({p['id'] for p in products})==len(products)
ids=[v['id'] for p in products for v in p['variants']]
assert len(ids)==len(set(ids))
assert len(seed['categories'])==len(catalog['categories'])+2
assert len(catalog['products'])==len(products)
assert {p['id'] for p in products}=={p['id'] for p in catalog['products']}
print(f'PASS: {len(products)} products, {len(ids)} variants, {len(seed["categories"])} categories, empty orders/clients/aliases')
