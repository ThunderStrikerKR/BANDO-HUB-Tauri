import { useState } from "react";
import { uid, won } from "./domain";
import { colorLabel, productKey, registeredProducts } from "./product-models";
import type { NoticeSink } from "./shared/notices";
import { useAsyncTask } from "./shared/useAsyncTask";
import type { ImportPreview, State } from "./types";
import { Field, clone } from "./ui";
export function ProductImports({
  state,
  onSave,
  onNotice,
}: {
  state: State;
  onSave: (s: State) => Promise<void>;
  onNotice: NoticeSink;
}) {
  const { busy, run } = useAsyncTask(onNotice);
  const [url, setUrl] = useState(""),
    [preview, setPreview] = useState<ImportPreview>();
  return (
    <section className="card">
      <h3>홈페이지 URL로 가져오기</h3>
      <Field label="공식 상세페이지 URL">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://bandostand.com/product/…"
        />
      </Field>
      <button
        disabled={busy || !url.trim()}
        onClick={() =>
          void run(async () => setPreview(await window.bando!.previewImport(url.trim())))
        }
      >
        모델 / 색상 / 판매가 미리보기
      </button>
      {preview && (
        <>
          <p className="muted">{preview.warnings.join(" / ")}</p>
          {[preview.product, ...(preview.related ?? [])].map((p) => (
            <div key={p.id}>
              <b>{p.name}</b>
              {p.variants.map((v) => (
                <p key={v.id}>
                  {colorLabel(v.color)} / {won(v.retail)}
                </p>
              ))}
            </div>
          ))}
          <button
            disabled={busy}
            className="primary"
            onClick={() =>
              void run(async () => {
                const next = clone(state);
                for (const incoming of [preview.product, ...(preview.related ?? [])]) {
                  const key = productKey(incoming);
                  if (
                    next.deletedProductKeys?.includes(key) ||
                    next.products.some(
                      (p) =>
                        p.deletedAt &&
                        (productKey(p) === key ||
                          p.variants.some((v) => incoming.variants.some((i) => i.id === v.id))),
                    )
                  )
                    throw Error("삭제된 상품입니다. 재가져오기로 복원하지 않습니다.");
                  const old =
                    registeredProducts(next.products).find((p) => productKey(p) === key) ||
                    registeredProducts(next.products).find((p) =>
                      p.variants.some((v) => incoming.variants.some((i) => i.id === v.id)),
                    );
                  if (!old) {
                    const p = clone(incoming);
                    if (next.products.some((x) => x.id === p.id)) p.id = uid();
                    next.products.push(p);
                    continue;
                  }
                  for (const v of incoming.variants) {
                    const prior = old.variants.find(
                      (x) =>
                        x.id === v.id ||
                        (x.siteOptionId === v.siteOptionId &&
                          x.siteProductId === v.siteProductId &&
                          x.color === v.color &&
                          x.option === v.option),
                    );
                    if (prior)
                      Object.assign(prior, {
                        retail: v.retail,
                        officialRetail: v.officialRetail,
                        url: v.url,
                        source: v.source,
                        collectedAt: v.collectedAt,
                      });
                    else old.variants.push(v);
                  }
                }
                await onSave(next);
                setPreview(undefined);
                onNotice(
                  "승인한 모델과 소매가를 반영했습니다. 입력된 도매가 / 반도매가 / 특수 단가는 유지합니다.",
                  "success",
                );
              })
            }
          >
            내용 확인 후 반영
          </button>
        </>
      )}
    </section>
  );
}
