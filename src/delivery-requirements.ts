import { validContact } from "./contact.js";
import type { Recipient } from "./types.js";
export function validDeliveryAddress(value: string) {
  return (
    !!value.trim() &&
    !/[#@]/.test(value) &&
    /(?:대로|로|길)\s*\d+|[동리읍면]\s+(?:산\s*)?\d+|사서함\s*\d+/.test(value)
  );
}
export function deliveryRequirements(row: Recipient, allowLegacyAddressConfirmation = false) {
  return {
    name: !!row.name.trim(),
    address:
      !!row.address.trim() &&
      ((allowLegacyAddressConfirmation && row.addressStatus === "CONFIRMED") ||
        (row.addressStatus !== "INCOMPLETE" && validDeliveryAddress(row.address))),
    contact: [row.phone, row.mobile].some(validContact),
    product: row.items.length > 0 && row.items.every((i) => !!i.productId && !!i.variantId),
    quantity:
      row.items.length > 0 &&
      row.items.every(
        (i) =>
          Number.isSafeInteger(i.quantity) &&
          (i.quantity ?? 0) > 0 &&
          i.quantityConfirmed !== false,
      ),
  };
}
