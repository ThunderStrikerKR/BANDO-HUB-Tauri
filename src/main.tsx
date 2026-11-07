import "./tauri-bridge";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/index.css";
import "./styles/v0809.css";
import "./styles/product-admin-redesign.css";
import "./styles/tauri-stage2-products.css";
// Resolve the native workspace before React paints its first screen.
void (async () => {
  try {
    window.bando!.isTestWorkspace = await window.bando!.workspaceMode!();
  } catch {
    if (window.bando) window.bando.isTestWorkspace = false;
  }
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
})();
