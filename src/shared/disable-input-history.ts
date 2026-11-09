/**
 * Suppress browser-saved input suggestions on app-owned text fields, including
 * inputs subsequently mounted in portals. Deliberate business search results
 * and select dropdown options are separate from the browser's input history.
 */
export function disableInputHistorySuggestions(root: HTMLElement) {
  const selector =
    'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]):not([type="password"]), textarea';
  const apply = (node: ParentNode) => {
    if ((node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) &&
        node.matches(selector)) {
      node.setAttribute("autocomplete", "off");
    }
    for (const field of node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(selector)) {
      field.setAttribute("autocomplete", "off");
    }
  };
  apply(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) apply(node);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
