import type { Client } from "./types.js";
export function explicitSender(raw: string, base: Client): Client | undefined {
  const marker = raw.match(/^\s*(?:보내는\s*(?:분|사람)|송하인(?:명)?)\s*[:：]/m);
  if (!marker) return;
  const text = raw.slice(marker.index),
    name =
      text
        .match(/^(?:\s*)(?:보내는\s*(?:분|사람)|송하인(?:명)?)\s*[:：]\s*([^\r\n]+)/)?.[1]
        ?.trim() ?? "";
  const phone = text.match(
    /(?<!\d)(0(?:50\d|1[016789]|2|[3-6]\d|70|80))[\s().-]*(\d{3,4})[\s().-]*(\d{4})(?!\d)/,
  );
  const address =
    text
      .match(/(?:보내는곳|송하인주소|주소)\s*[:：]\s*([\s\S]*)/)?.[1]
      .trim()
      .replace(/\s*\r?\n\s*/g, " ") ?? "";
  return {
    ...base,
    name,
    displayName: name,
    address,
    phone: phone ? phone[0] : "",
    mobile: "",
    postcode: "",
  };
}
