import type { Client, Product, ShippingRule, State } from "../types";
import { sameValue } from "./draft";

type Settings = State["settings"];
const optionalText = (value: string | null | undefined) => value ?? "";

/**
 * A dirty editor means its user-editable business values differ, not that an
 * absent optional JSON property became an empty controlled input or that a
 * generated record version changed while the editor was opening.
 * These projections are intentionally form-specific: null prices and zero
 * prices must never become equivalent.
 */
export function sameFreightEditor(a: ShippingRule, b: ShippingRule): boolean {
  const visible = (rule: ShippingRule) => ({
    // Exclude only the generated revision metadata. Keep all current and
    // future business rule attributes in the comparison.
    ...Object.fromEntries(
      Object.entries(rule).filter(([key]) => key !== "version" && key !== "at"),
    ),
    maxBundle: rule.maxBundle ?? null,
    maxConfirmed: rule.maxConfirmed ?? false,
    perItem: rule.perItem ?? null,
    notes: optionalText(rule.notes),
    fees: Object.fromEntries(
      Object.entries(rule.fees ?? {})
        .filter(([, value]) => value !== null && value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en", { numeric: true })),
    ),
  });
  return sameValue(visible(a), visible(b));
}

export function sameClientEditor(a: Client, b: Client): boolean {
  const visible = (client: Client) => ({
    ...client,
    displayName: optionalText(client.displayName),
    contact: optionalText(client.contact),
    address: optionalText(client.address),
    phone: optionalText(client.phone),
    mobile: optionalText(client.mobile),
    // Legacy search identifiers share one visible text field.
    shortNames: [client.shortNames, client.identifiers].filter(Boolean).join(", "),
    identifiers: "",
  });
  return sameValue(visible(a), visible(b));
}

export function sameProductEditor(a: Product, b: Product): boolean {
  const visible = (product: Product) => ({
    ...product,
    subtitle: optionalText(product.subtitle),
    shippingGroupId: optionalText(product.shippingGroupId),
    variants: product.variants.map((variant) => ({
      ...variant,
      url: optionalText(variant.url),
    })),
  });
  return sameValue(visible(a), visible(b));
}

export function visibleSettings(settings: Settings): Settings {
  return {
    ...settings,
    senderName: settings.senderName || "반도스탠드",
    senderAddress: optionalText(settings.senderAddress),
    senderPostcode: optionalText(settings.senderPostcode),
    senderPhone: optionalText(settings.senderPhone),
    senderMobile: optionalText(settings.senderMobile),
    operatorName: optionalText(settings.operatorName),
    excelDirectory: optionalText(settings.excelDirectory),
    factoryReplyDirectory: optionalText(settings.factoryReplyDirectory),
    defaultAccountId: optionalText(settings.defaultAccountId),
    brandAccounts: {
      BANDOSTAND: optionalText(settings.brandAccounts?.BANDOSTAND),
      BANDOMALL: optionalText(settings.brandAccounts?.BANDOMALL),
    },
  };
}
export function sameSettingsEditor(a: Settings, b: Settings): boolean {
  return sameValue(visibleSettings(a), visibleSettings(b));
}
