import { useEffect, useMemo, useState } from "react";
import { businessCoreCall } from "./tauri-bridge";
import type { Client, Product, State } from "./types";

/** No TS business fallback; superseded IPC calls cannot overwrite a newer
 * search term, filter or loaded state.
 */
export function useNativeCatalogQuery<T>(
  state: object,
  operation: string,
  args: Record<string, unknown>,
  keys: readonly unknown[],
  empty: T,
): {value: T; pending: boolean; error: string} {
  const key = JSON.stringify([operation, ...keys]);
  const [result, setResult] = useState<{
    state: object; key: string; value: T; error: string;
  }>();
  useEffect(() => {
    let active = true;
    void businessCoreCall<T>("catalog_clients", operation, {
      state, ...args,
    }).then((value) => {
      if (active) setResult({state, key, value, error: ""});
    }).catch((error) => {
      if (active) setResult({
        state, key, value: empty,
        error: "Rust " + operation + " 조회 실패: " + String(error),
      });
    });
    return () => { active = false; };
    // args is captured when the JSON-stable key or state changes. Callers
    // must include every business argument in keys.
  }, [state, operation, key]);
  return result?.state === state && result.key === key
    ? {value: result.value, pending: false, error: result.error}
    : {value: empty, pending: true, error: ""};
}

const NO_IDS: string[] = [];
export function useNativeClients(
  clients: Client[],
  query: string,
  raw = "",
): {results: Client[]; suggested: Client[]; pending: boolean; error: string} {
  const input = useMemo(() => ({clients}), [clients]);
  const {value,pending,error} = useNativeCatalogQuery<{
    ids: string[]; suggestedIds: string[];
  }>(input,"client_candidates",{query,raw},[query,raw],{
    ids:NO_IDS,suggestedIds:NO_IDS,
  });
  const mapping=useMemo(()=>new Map(clients.map(c=>[c.id,c])),[clients]);
  return {
    results: value.ids.flatMap(id=>mapping.has(id)?[mapping.get(id)!]:[]),
    suggested: value.suggestedIds.flatMap(id=>mapping.has(id)?[mapping.get(id)!]:[]),
    pending,error,
  };
}
export function useNativeProductIds(
  state: State,
  operation: string,
  args: Record<string, unknown>,
  keys: readonly unknown[],
): { products: Product[]; pending: boolean; error: string } {
  const {value,pending,error}=useNativeCatalogQuery<string[]>(
    state,operation,args,keys,NO_IDS,
  );
  const mapping=useMemo(()=>new Map(state.products.map(p=>[p.id,p])),[state.products]);
  const products=useMemo(()=>value.flatMap(id=>mapping.has(id)?[mapping.get(id)!]:[]),
    [value,mapping]);
  return {products,pending,error};
}
