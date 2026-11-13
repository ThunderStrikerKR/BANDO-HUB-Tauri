/** Compare plain persisted JSON values regardless of object key order.
 * Array order (including account ordering) remains meaningful.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) &&
      a.length === b.length && a.every((value, i) => sameValue(value, b[i]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}
/** Merge unrelated server updates without erasing local edits; never resolve conflicting edits silently. */
export function rebaseDraft<T extends object>(base: T, draft: T, incoming: T) {
  const merged = structuredClone(incoming),
    conflicts: (keyof T)[] = [];
  for (const key of new Set<keyof T>([
    ...Object.keys(base),
    ...Object.keys(draft),
    ...Object.keys(incoming),
  ] as (keyof T)[])) {
    if (sameValue(draft[key], base[key])) continue;
    if (!sameValue(incoming[key], base[key]) && !sameValue(draft[key], incoming[key])) conflicts.push(key);
    if (key in draft) merged[key] = structuredClone(draft[key]);
    else delete merged[key];
  }
  return { draft: merged, conflicts };
}
