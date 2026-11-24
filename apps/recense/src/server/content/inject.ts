import { htmlLookInsertAt } from "@recense/core";
import { BRIDGE_SOURCE } from "./bridge.ts";

/** Preserve the leading doctype so adding the stylesheet never forces quirks mode. */
export function injectLook(html: string, css: string, theme?: "light" | "dark"): string {
  const at = htmlLookInsertAt(html);
  const start = theme === "light" ? '<html data-theme="light">' : theme === "dark" ? '<html data-theme="dark">' : "";
  return `${html.slice(0, at)}${start}<style>${css}</style>${html.slice(at)}`;
}

export function injectBridge(html: string): string {
  const script = `<script>${BRIDGE_SOURCE}</script>`;
  // A </body> after the real close in a script string, comment or attribute takes the bridge, so that doc has none.
  let at = -1;
  for (const match of html.matchAll(/<\/body>/gi)) at = match.index;
  return at < 0 ? html + script : html.slice(0, at) + script + html.slice(at);
}
