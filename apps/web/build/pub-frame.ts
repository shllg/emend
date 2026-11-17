import { LIMITS } from "@emend/contract";

type BuildFile = { type: "asset"; fileName: string; source: string | Uint8Array } | { type: "chunk"; fileName: string };

export function pickPubStylesheet(output: readonly BuildFile[]): string {
  const sheets = output.filter((file) => file.type === "asset" && file.fileName.endsWith(".css"));
  const sheet = sheets[0];
  if (sheets.length !== 1 || sheet?.type !== "asset") throw new Error("Expected one pub stylesheet.");
  return typeof sheet.source === "string"
    ? sheet.source
    : new TextDecoder("utf-8", { fatal: true }).decode(sheet.source);
}

export function checkPubStylesheet(css: string): void {
  if (
    new TextEncoder().encode(css).byteLength > LIMITS.pubStylesheetBytes ||
    css.includes("</") ||
    /@import\b|image-set\(/i.test(css) ||
    [...css.matchAll(/url\(/gi)].some((match) => !/^url\(\s*["']?data:/i.test(css.slice(match.index)))
  )
    throw new Error("The pub stylesheet exceeds its byte limit or contains unsafe content or external assets.");
}
