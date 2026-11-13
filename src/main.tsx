import "./tauri-bridge";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { disableInputHistorySuggestions } from "./shared/disable-input-history";
import "./styles/index.css";
import "./styles/v0809.css";
import "./styles/product-admin-redesign.css";
import "./styles/tauri-stage2-products.css";
import "./styles/table-density.css";
import "./styles/management-layout.css";
// Resolve the native workspace before React paints its first screen.
void (async () => {
  try {
    window.bando!.isTestWorkspace = await window.bando!.workspaceMode!();
  } catch {
    if (window.bando) window.bando.isTestWorkspace = false;
  }
  disableInputHistorySuggestions(document.body);
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
})();
