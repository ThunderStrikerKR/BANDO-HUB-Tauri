/** Preserve the actual reason while removing Electron transport wrappers from staff-facing notices. */
export function readableError(value: unknown) {
  let text = value instanceof Error ? value.message : String(value);
  for (let n = 0; n < 3; n++)
    text = text
      .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/, "")
      .replace(/^Error:\s*/, "");
  return text;
}
