import { explicitSender } from "./explicit-sender.js";
import type { Client, Order, Settings, State } from "./types.js";
export const companyClient = (settings: Settings): Client => ({
  postcode: settings.senderPostcode || "",
  id: "",
  name: settings.senderName?.trim() || "반도스탠드",
  displayName: settings.senderName?.trim() || "반도스탠드",
  address: settings.senderAddress || "",
  phone: settings.senderPhone || "",
  mobile: settings.senderMobile || "",
  contact: "",
  tier: "retail",
  payment: "POSTPAID",
  shippingFeeExcluded: false,
  active: true,
  identifiers: "",
  overrides: {},
});
export function senderFor(order: Order, state: State) {
  return (
    order.senderSnapshot ??
    (order.orderType === "DEALER" || order.orderType === "RETAIL"
      ? companyClient(state.settings)
      : (explicitSender(
          order.analysisRaw ?? order.raw,
          order.clientSnapshot ??
            state.clients.find((c) => c.id === order.clientId) ??
            companyClient(state.settings),
        ) ??
        order.clientSnapshot ??
        state.clients.find((c) => c.id === order.clientId)!))
  );
}
export function orderParty(order: Order, state: State) {
  return order.orderType === "RETAIL"
    ? (order.clientSnapshot ?? companyParty(state.settings))
    : (state.clients.find((c) => c.id === order.clientId) ?? order.clientSnapshot);
}

export const companyParty = (settings: Settings): Client => ({
  ...companyClient(settings),
  name: "반도스탠드",
  displayName: "반도스탠드",
});

export function companySenderMissing(settings: Settings) {
  return [
    !(settings.senderAddress || "").trim() ? "설정의 반도스탠드 주소를 등록하세요." : "",
    !(settings.senderPhone || settings.senderMobile || "").trim()
      ? "설정의 반도스탠드 연락처를 등록하세요."
      : "",
  ].filter(Boolean);
}
