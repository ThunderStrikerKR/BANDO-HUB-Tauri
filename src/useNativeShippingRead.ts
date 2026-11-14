/** Read-only Rust freight projections. No TypeScript rule fallback when pending.
 * The presentation may filter/search, but all rate selection and current-rule
 * decisions come from rules.shipping_read.
 */
import { useEffect, useState } from "react";
import { businessCoreCall } from "./tauri-bridge";
import type { ShippingGroup, ShippingRule, State } from "./types";

type FreightProductProjection = {
  productId: string;
  group: ShippingGroup | null;
  rule: ShippingRule | null;
  editableRule: ShippingRule | null;
};
type FreightGroupProjection = { id: string; editableRule: ShippingRule };
type FreightCombinationProjection = { id: string; current: boolean };
type FreightRead = {
  effective: FreightProductProjection[];
  groups: FreightGroupProjection[];
  combinations: FreightCombinationProjection[];
};
export function useNativeShippingRead(state: State) {
  const [snapshot, setSnapshot] = useState<{ state: State; data: FreightRead }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    void businessCoreCall<FreightRead>("rules", "shipping_read", { state })
      .then((data) => {
        if (active) setSnapshot({ state, data });
      }).catch((cause) => {
        if (active) {
          setSnapshot(undefined);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => { active = false; };
  }, [state]);
  const data = snapshot?.state === state ? snapshot.data : undefined;
  return {
    error,
    ready: !!data,
    product: (id: string) => data?.effective.find((entry) => entry.productId === id),
    group: (id: string) => data?.groups.find((entry) => entry.id === id),
    combination: (id: string) => data?.combinations.find((entry) => entry.id === id),
  };
}
