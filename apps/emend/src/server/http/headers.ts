import { createHash } from "node:crypto";
import type { Context } from "hono";
import { BRIDGE_SOURCE } from "../content/bridge.ts";

export const DOWNLOAD_CSP =
  "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; base-uri 'none'; form-action 'none'";
export const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const isApiPath = (path: string) => path === "/api/v1" || path.startsWith("/api/v1/");
export const MERMAID_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:";
const CONTENT_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'self'";
// Hash the exact injected text once. Only successful doc responses allow this script.
export const HTML_DOC_CSP = CONTENT_CSP.replace(
  "script-src 'none'",
  `script-src 'sha256-${createHash("sha256").update(BRIDGE_SOURCE).digest("base64")}'`,
);
export function headersForPath(path: string): Record<string, string> {
  if (path.startsWith("/content/")) {
    return {
      "Content-Security-Policy": CONTENT_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-store",
    };
  }
  return {
    "Content-Security-Policy": path === "/mermaid-frame.html" ? MERMAID_CSP : APP_CSP,
    "X-Frame-Options": path === "/mermaid-frame.html" ? "SAMEORIGIN" : "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    ...(isApiPath(path) ? { "Cache-Control": "no-store" } : {}),
  };
}
export function responseHeaders(c: Context) {
  for (const [name, value] of Object.entries(headersForPath(c.req.path))) c.header(name, value);
}
