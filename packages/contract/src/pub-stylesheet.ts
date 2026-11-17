import { LIMITS } from "./limits.ts";

export function pubStylesheetSafe(css: string): boolean {
  return (
    new TextEncoder().encode(css).byteLength <= LIMITS.pubStylesheetBytes &&
    !css.includes("</") &&
    !css.includes("\\") &&
    !/@import|image-set\(|src\(/i.test(css) &&
    [...css.matchAll(/url\(/gi)].every((match) => /^url\([\t\n\f\r ]*["']?data:/i.test(css.slice(match.index)))
  );
}
