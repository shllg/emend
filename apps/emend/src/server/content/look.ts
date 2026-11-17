import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { regularFile } from "../http/pages.ts";

export const FALLBACK_PUB_CSS = "@layer emend{:root{color-scheme:light dark;background:Canvas;color:CanvasText}}";
const stylesheets = new Map<string, Promise<string>>();

/** The installed web build is trusted only after confinement, size and raw-text checks. */
export function pubStylesheet(webRoot: string): Promise<string> {
  let css = stylesheets.get(webRoot);
  if (!css) {
    css = (async () => {
      const root = await realpath(webRoot);
      const file = await regularFile(root, join(root, "pub-frame.css"), 1024 * 1024);
      if (!file) return FALLBACK_PUB_CSS;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      return text.includes("<") ? FALLBACK_PUB_CSS : text;
    })().catch(() => FALLBACK_PUB_CSS);
    stylesheets.set(webRoot, css);
  }
  return css;
}
