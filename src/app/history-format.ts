/** Presentation-only formatting for native Rust history/settlement results.
 * This small module keeps the report screens from importing TS business rules.
 * Monetary decisions, validation, and all persisted amounts come from Rust.
 */
export const won = (value: number | null): string =>
  value === null ? "확인 필요" : value.toLocaleString("ko-KR") + "원";

/** Label-only normalization; never used for catalog identification or pricing. */
export const internalModel = (name: string): string =>
  name.replace(/^\[가상\]\s*/, "").replace(/^BD(?=\s|\d)\s*/i, "");
