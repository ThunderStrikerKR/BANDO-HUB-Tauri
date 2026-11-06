const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Merge unrelated server updates without erasing local edits; never resolve conflicting edits silently. */
export function rebaseDraft<T extends object>(base: T, draft: T, incoming: T) {
  const merged = structuredClone(incoming),
    conflicts: (keyof T)[] = [];
  for (const key of new Set<keyof T>([
    ...Object.keys(base),
    ...Object.keys(draft),
    ...Object.keys(incoming),
  ] as (keyof T)[])) {
    if (same(draft[key], base[key])) continue;
    if (!same(incoming[key], base[key]) && !same(draft[key], incoming[key])) conflicts.push(key);
    if (key in draft) merged[key] = structuredClone(draft[key]);
    else delete merged[key];
  }
  return { draft: merged, conflicts };
}
