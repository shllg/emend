import { stripVTControlCharacters } from "node:util";
import {
  checkTextSpans,
  decodedEscapeView,
  diagnosticBlockReason,
  loadPrivateTerms,
  type PrivateTerms,
  PublicCheckError,
  ScanBudget,
} from "../../../scripts/check-public.ts";
import { gitRuntime } from "./proc.ts";
import type { Repo } from "./repo.ts";

const EMPTY: PrivateTerms = { terms: [], allowed: [], notes: [] };

/** Mask only an anchored object ID, retaining offsets and any preceding credential material. */
function maskObjectIds(text: string): string {
  return text.replace(/[A-Za-z0-9+/=_:"'-]{34,}/g, (run) => {
    let begin = 0,
      end = run.length;
    while (begin < end && (run[begin] === '"' || run[begin] === "'")) begin++;
    while (end > begin && (run[end - 1] === '"' || run[end - 1] === "'")) end--;
    const value = run.slice(begin, end);
    // A leading colon can remain after maskBranches removes a readable refspec source.
    const bare =
      /^:?([a-f0-9]{40}|[a-f0-9]{64})(?=:|$)/.exec(value) ?? /^\+([a-f0-9]{40}|[a-f0-9]{64})(?=:)/.exec(value);
    const hex =
      bare?.[1] ??
      /(?:^|\/)objects\/[a-f0-9]{2}\/([a-f0-9]{38}|[a-f0-9]{62})$/.exec(value)?.[1] ??
      /(?:^|\/)pack-([a-f0-9]{40}|[a-f0-9]{64})$/.exec(value)?.[1] ??
      /^refs\/(?:.*\/)?([a-f0-9]{40}|[a-f0-9]{64})$/.exec(value)?.[1];
    if (!hex) return run;
    const at = begin + (bare ? bare[0].length : value.length) - hex.length;
    return run.slice(0, at) + " ".repeat(hex.length) + run.slice(at + hex.length);
  });
}

/** Complete repository refs cannot fuse with the next diagnostic line into a token. */
function maskBranches(text: string): string {
  // A lower-case secret inside an emend-<n>-<slug> branch prints, within the accidental-leak scope.
  return text.replace(/[A-Za-z0-9+/=_-]+/g, (value) =>
    /^(?:(?:refs\/heads|refs\/remotes\/origin|origin)\/)?emend-(?:task-)?[0-9]+-[a-z0-9-]+$/.test(value)
      ? " ".repeat(value.length)
      : value,
  );
}

/** Old or unknown Git versions may fetch implicitly despite the environment pin. */
export function gitLocalDiagnostic(repo: Repo, stderr: string, cwd = repo.mainRoot): string {
  return gitRuntime.supportsNoLazyFetch(cwd) ? localDiagnostic(stderr) : repoDiagnostic(repo, stderr);
}

/** Local Git errors retain their content, trim display-only trailing whitespace and never load terms. */
export function localDiagnostic(stderr: string): string {
  return stderr
    .split("\n")
    .map((line) =>
      stripVTControlCharacters(line).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (character) =>
        character === "\t" ? character : "",
      ),
    )
    .join("\n")
    .trimEnd();
}

/** Count quoted values without treating an escaped quote as their end. */
function credentialAssignmentStart(text: string, budget: ScanBudget): number {
  budget.spend(text.length);
  // Tokenize names once; nested optional prefix groups backtrack exponentially on non-labels.
  const labels = /(?<![a-z0-9_/-])-{0,2}([a-z0-9]+(?:[-_][a-z0-9]+)*)["'`]?[ \t]*[:=][ \t]*/gi;
  const credential =
    /(?:api[-_]?key|access[-_]?key|private[-_]?key|secret(?:[-_]?key)?|token|password|passwd|credentials?)(?:[-_]?(?:key|base|value|v?[0-9]+))?$/i;
  for (let match = labels.exec(text); match; match = labels.exec(text)) {
    if (match[1]?.toLowerCase() === "not-token" || !credential.test(match[1] ?? "")) continue;
    let at = labels.lastIndex;
    const quote = /["'`]/.test(text[at] ?? "") ? text[at++] : undefined;
    let length = 0;
    let resume: number | undefined;
    while (at < text.length) {
      const character = text[at++];
      if (!quote && resume === undefined && /[;&,|)\]"'`]/.test(character ?? "")) resume = at - 1;
      if (quote ? character === quote : /[\s"'`]/.test(character ?? "")) break;
      if (quote && character === "\\" && at < text.length) at++;
      // Sixteen characters suffice; later labels never cause repeated long suffix scans.
      if (++length >= 16) return match.index;
    }
    labels.lastIndex = resume ?? at;
  }
  return Infinity;
}

/** Error text may wrap credentials arbitrarily: suppress every later line conservatively. */
export function pushDiagnostic(stderr: string, terms: PrivateTerms = EMPTY): string {
  if (stderr.length > 64 * 1024 || Buffer.byteLength(stderr) > 64 * 1024)
    return "[diagnostic withheld: longer than 64 KiB]";
  const window = localDiagnostic(stderr);
  const lines = window.split("\n");
  const offsets: number[] = [];
  const spacedOffsets: number[] = [];
  const credentialLines: string[] = [];
  const keywordLines: string[] = [];
  let sourceAt = 0;
  const joined = lines
    .map((line, index) => {
      const decoration = /^\s*(?:remote:\s*)?/i.exec(line)?.[0].length ?? 0;
      if (index) spacedOffsets.push(sourceAt - 1);
      for (let at = decoration; at < line.length; at++) {
        offsets.push(sourceAt + at);
        spacedOffsets.push(sourceAt + at);
      }
      sourceAt += line.length + 1;
      const content = line.slice(decoration);
      // Preserve complete object IDs before removing line boundaries: a following hint
      // must not turn a hex ID into a longer non-hex credential candidate.
      const branchesMasked = maskBranches(content);
      credentialLines.push(maskObjectIds(branchesMasked));
      // A hex object shape can still be a bearer value, so keywords see its original bytes.
      keywordLines.push(branchesMasked);
      return content;
    })
    .join("");
  const reason = diagnosticBlockReason(window) ?? diagnosticBlockReason(joined);
  if (reason) return `[diagnostic withheld: ${reason}]`;
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
  const spans = checkTextSpans(window, terms);
  if (spans.some((span) => span.label === "combining-mark run")) return "[diagnostic withheld: combining-mark run]";
  withhold(spans);
  // Terminal wrapping can split a token itself. Also scan a joined view for every rule,
  // retaining offsets so both sides of the wrap are withheld, never just the first line.
  if (lines.length > 1) {
    const joinedSpans = checkTextSpans(joined, terms, true);
    if (joinedSpans.some((span) => span.label === "combining-mark run"))
      return "[diagnostic withheld: combining-mark run]";
    withhold(
      joinedSpans
        // A variable-length token can continue across any line boundary its alphabet permits.
        // Fixed-length rules already stop at their complete length in the joined view.
        .map((span) => ({
          ...span,
          start: offsets[span.start] ?? 0,
          end: (offsets[span.end - 1] ?? 0) + 1,
        })),
    );
  }
  const keywordBudget = new ScanBudget();
  const keywordStart = (text: string): number => {
    // A decoded Authorization keyword withholds the whole line, intentionally broader than the Bearer value rule.
    const pattern =
      /(?:authorization["']?[ \t]*[:=]|bearer(?:[ \t]+|[ \t]*[:=][ \t]*)["']?[A-Za-z0-9._~+/-]{8,}=*|(?<![a-z0-9])data:)/i;
    let sourceAt = (at: number): number => at;
    let start = Infinity;
    try {
      for (;;) {
        const match = pattern.exec(text);
        if (match) start = Math.min(start, sourceAt(match.index));
        const assignment = credentialAssignmentStart(text, keywordBudget);
        if (assignment < Infinity) start = Math.min(start, sourceAt(assignment));
        const decoded = decodedEscapeView(text, keywordBudget);
        if (!decoded) return start;
        const previous = sourceAt;
        sourceAt = (at) => previous(decoded.start(at));
        text = decoded.text;
      }
    } catch (error) {
      if (error instanceof PublicCheckError) return 0;
      throw error;
    }
  };
  const credentialStart = (text: string): number => {
    text = maskBranches(text);
    const prefix = /(?<![a-z0-9])(?:gh[pousr]_|github_pat_|glpat-|npm_|pypi-|xox[a-z]-|sk-|eyJ|-----BEGIN)/i;
    const awsPrefix = /(?<![A-Za-z0-9])(?:AKIA|ASIA)/;
    let start = Math.min(
      prefix.exec(text)?.index ?? Infinity,
      awsPrefix.exec(text)?.index ?? Infinity,
      keywordStart(text),
    );
    // Quoted assignments connect a label and value even with formatting spaces.
    // Other unquoted labels leave separated Git object IDs readable.
    for (const match of text.matchAll(
      /(?<![A-Za-z0-9_/-])["']?[A-Za-z0-9_/-]+["']?[ \t]*[:=][ \t]*["']([a-f0-9]{32,})["']/gi,
    ))
      if (/[a-f]/i.test(match[1] ?? "") && /[0-9]/.test(match[1] ?? "")) start = Math.min(start, match.index);
    // Include a one-character label and separator before a 32-character hex credential.
    for (const run of maskObjectIds(text).matchAll(/[A-Za-z0-9+/=_:"'-]{34,}/g)) {
      const value = run[0];
      const pieces = value.split(/[-_/=+:"']/).filter(Boolean);
      const rest = pieces.join("");
      // A 40-character base64 value can have 38 characters after its two slashes are removed.
      const mixedCase = value.length >= 38 && /[A-Z]/.test(rest) && /[a-z]/.test(rest) && /[0-9]/.test(rest);
      const longPiece =
        value.length >= 40 && pieces.some((part) => part.length >= 12 && /[a-z]/i.test(part) && /[0-9]/.test(part));
      const labelledHex =
        pieces.length > 1 &&
        pieces.some((part) => /^[a-f0-9]{32,}$/i.test(part) && /[a-f]/i.test(part) && /[0-9]/.test(part));
      if (mixedCase || longPiece || labelledHex) start = Math.min(start, run.index);
    }
    return start;
  };
  // A credential can begin before a wrap. Withholding from its first source character also
  // covers every touched line, the stripped decorations between them, and every later line.
  const joinedStart = Math.min(credentialStart(credentialLines.join("")), keywordStart(keywordLines.join("")));
  const spacedStart = keywordStart(keywordLines.join(" "));
  const followingFrom = Math.min(
    credentialStart(window),
    offsets[joinedStart] ?? Infinity,
    spacedOffsets[spacedStart] ?? Infinity,
  );
  let lineStart = 0;
  for (const [index, line] of lines.entries()) {
    if (lineStart + line.length >= followingFrom && !hidden.has(index)) hidden.set(index, "secret shape");
    lineStart += line.length + 1;
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
  } catch (error) {
    if (!(error instanceof PublicCheckError && error.code === "PRIVATE_TERMS_MISSING"))
      return "[diagnostic withheld: private terms file is invalid]";
    // Only an absent file permits the environment-only fallback; invalid files still fail closed.
    try {
      terms = loadPrivateTerms(repo.mainRoot, process.env, { root: repo.mainRoot });
    } catch {
      return "[diagnostic withheld: private terms file is invalid]";
    }
  }
  return pushDiagnostic(stderr, terms);
}
