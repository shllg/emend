import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS, pubStylesheetSafe } from "@recense/contract";
import { regularFile } from "../http/pages.ts";

// emend-file is the layer of pages that `emend look` styled before the rename; the real sheet declares it too.
export const FALLBACK_PUB_CSS =
  "@layer recense-file,emend-file,recense;@layer recense{:root{color-scheme:light dark;background:Canvas;color:CanvasText}:root[data-theme=light]{color-scheme:light}:root[data-theme=dark]{color-scheme:dark}}";
const stylesheets = new Map<string, Promise<string>>();

/** The installed web build is trusted only after confinement, size and raw-text checks. */
export async function readPubStylesheet(webRoot: string): Promise<string> {
  const root = await realpath(webRoot);
  const file = await regularFile(root, join(root, "pub-frame.css"), LIMITS.pubStylesheetBytes);
  if (!file) throw new Error("Missing or oversized pub stylesheet");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  if (!pubStylesheetSafe(text)) throw new Error("Unsafe pub stylesheet");
  return text;
}

export function pubStylesheet(webRoot: string): Promise<string> {
  let css = stylesheets.get(webRoot);
  if (!css) {
    css = readPubStylesheet(webRoot).catch(() => {
      stylesheets.delete(webRoot);
      return FALLBACK_PUB_CSS;
    });
    stylesheets.set(webRoot, css);
  }
  return css;
}
