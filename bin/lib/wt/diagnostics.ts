import { stripVTControlCharacters } from "node:util";
import {
  checkTextSpans,
  diagnosticBlockReason,
  loadPrivateTerms,
  type PrivateTerms,
} from "../../../scripts/check-public.ts";
import type { Repo } from "./repo.ts";

const EMPTY: PrivateTerms = { terms: [], allowed: [], notes: [] };

/** Local Git errors retain their content, trim display-only trailing whitespace and never load terms. */
export function localDiagnostic(stderr: string): string {
  return stripVTControlCharacters(stderr)
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (character) => (character === "\n" || character === "\t" ? character : ""))
    .trimEnd();
}

/** Scan at most 64 KiB before limiting output; a hit withholds every line it spans. */
export function pushDiagnostic(stderr: string, terms: PrivateTerms = EMPTY, secretsOnly = false): string {
  // Bound conversion as well as scanning, and discard an incomplete UTF-8 character at the cap.
  const prefix = Buffer.from(stderr.slice(0, 64 * 1024)).subarray(0, 64 * 1024);
  const text = localDiagnostic(new TextDecoder().decode(prefix, { stream: true }));
  const reason = diagnosticBlockReason(text);
  if (reason) return `[diagnostic withheld: ${reason}]`;
  const lines = text.split("\n");
  const hidden = new Map<number, string>();
  const withhold = (spans: ReturnType<typeof checkTextSpans>) => {
    let at = 0;
    let until = 0;
    let label = "";
    let offset = 0;
    for (const [index, line] of lines.entries()) {
      while (at < spans.length && (spans[at]?.start ?? Infinity) <= offset + line.length) {
        const span = spans[at++];
        if (span && span.end > until) {
          label = span.label;
          until = span.end;
        }
      }
      if (until > offset && !hidden.has(index)) hidden.set(index, label);
      offset += line.length + 1;
    }
  };
  const spans = checkTextSpans(text, terms);
  withhold(secretsOnly ? spans.filter((span) => span.label === "secret shape") : spans);
  // Terminal wrapping can split a token itself. Also scan a joined view for secret shapes,
  // retaining offsets so both sides of the wrap are withheld, never just the first line.
  if (lines.length > 1) {
    const offsets: number[] = [];
    for (let at = 0; at < text.length; at++) if (text[at] !== "\n") offsets.push(at);
    withhold(
      checkTextSpans(lines.join(""), EMPTY)
        .filter((span) => span.label === "secret shape")
        .map((span) => ({ ...span, start: offsets[span.start] ?? 0, end: (offsets[span.end - 1] ?? 0) + 1 })),
    );
  }
  return lines
    .slice(0, 20)
    .map((line, index) => (hidden.has(index) ? `[line withheld: ${hidden.get(index)}]` : line))
    .join("\n")
    .slice(0, 2000)
    .trimEnd();
}

export function repoDiagnostic(repo: Repo, stderr: string): string {
  if (!stderr) return "";
  let terms: PrivateTerms;
  try {
    terms = loadPrivateTerms(repo.mainRoot, process.env, { root: repo.mainRoot, requireTerms: true });
  } catch {
    return pushDiagnostic(stderr, EMPTY, true);
  }
  return pushDiagnostic(stderr, terms);
}
