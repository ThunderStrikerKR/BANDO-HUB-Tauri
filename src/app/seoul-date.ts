/** Date formatting only, used to initialize report screen filters.
 * This module intentionally does not import settlement or order algorithms.
 */
export function seoulDate(value: string | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(parsed);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return [part("year"), part("month"), part("day")].join("-");
}
