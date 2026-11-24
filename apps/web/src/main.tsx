import { configureBrowserValidation } from "@recense/contract/browser";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { appUpdate } from "./lib/app-update.ts";
import { moveLegacyStorage } from "./lib/legacy-storage.ts";
import { rememberPairingSecret } from "./lib/pairing-secret.ts";
import { initializeTheme } from "./lib/theme.ts";
import "./styles.css";

moveLegacyStorage();
initializeTheme();
configureBrowserValidation();
function capturePairingSecret() {
  if (!/^\/pair\/?$/i.test(location.pathname) || !location.hash) return;
  const secret = location.hash.slice(1);
  history.replaceState(null, "", "/pair");
  rememberPairingSecret(secret);
}
window.addEventListener("hashchange", capturePairingSecret);
window.addEventListener("popstate", capturePairingSecret);
capturePairingSecret();

const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");

const { App } = await import("./App.tsx");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

appUpdate.start();
