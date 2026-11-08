type HiddenClass =
  | "raw HTML"
  | "reference definition"
  | "link destination"
  | "alt text"
  | "character reference"
  | "math"
  | "emoji shortcode"
  | "table"
  | "GitHub link"
  | "line length"
  | "whitespace run"
  | "list number"
  | "task marker"
  | "empty code block"
  | "fence info";
const refusal = (kind: HiddenClass) => `hidden Markdown in the body: ${kind}`;

// The only permitted ]( is a whole-line screenshot with a determined alt label.
const SCREENSHOT =
  /^!\[([^\]]*)\]\(https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/u;
const CHARACTER_REFERENCE = /&(?:#|[A-Za-z][A-Za-z0-9]{0,31};)/uy;
const FENCE_WORDS = new Set(
  "text plaintext console sh bash shell zsh diff json jsonc yaml yml toml ini md markdown ts typescript tsx js javascript jsx mjs css html xml sql python py ruby rb go rust rs http".split(
    " ",
  ),
);

function allowedFenceInfo(line: string, start: number): boolean {
  let end = line.length;
  while (start < end && (line[start] === " " || line[start] === "\t")) start++;
  while (end > start && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return start === end || FENCE_WORDS.has(line.slice(start, end).toLowerCase());
}

/** Conservative raw-line rules, without reconstructing CommonMark containers. */
function hiddenLineReason(lines: string[]): string | null {
  const markers = lines.flatMap((line) => {
    const marker = /^([\s>]*)(\d{1,9})([.)])(?=[ \t]|$)/u.exec(line);
    return marker ? [marker] : [];
  });
  const flat = markers.every((marker) => marker[1] === "");
  let previous: number | undefined;
  let delimiter: string | undefined;
  let onesOnly = false;
  // Within a run of same-delimiter, column-zero markers, strict k, k+1, ...
  // renders as written whether a line continues the list, restarts it (its start
  // is shown), or stays paragraph text. A 1 is always determined. But after a 1
  // that follows another marker, continuation and restart diverge, so only 1
  // stays safe. Intervening non-marker lines do not reset a sequence.
  for (const marker of markers) {
    if (marker[3] !== delimiter) {
      delimiter = marker[3];
      previous = undefined;
      onesOnly = false;
    }
    const digits = marker[2] ?? "";
    const number = Number(digits);
    if (
      digits.startsWith("0") ||
      (number !== 1 && (!flat || (previous !== undefined && (onesOnly || number !== previous + 1))))
    )
      return refusal("list number");
    if (previous !== undefined && number === 1) onesOnly = true;
    previous = number;
  }

  // Only column-zero openers need content. Container fences have the bounded
  // info-word allowance even when empty; their boundaries are not modelled here.
  let needsContent = false;
  for (const line of lines) {
    if (/^[\s>]*\[[xX ]\]/u.test(line) || /^(?:[\s>]|[-*+]|\d{1,9}[.)])*\[X\]/u.test(line))
      return refusal("task marker");
    const content = line.trimStart();
    if (needsContent && content) {
      if (/^(?:`{3,}|~{3,})/u.test(content)) return refusal("empty code block");
      needsContent = false;
    }
    if (/^(?:`{3,}|~{3,})[ \t]*[A-Za-z]+[ \t]*$/u.test(line)) needsContent = true;
  }
  return needsContent ? refusal("empty code block") : null;
}

/** Raw-text rules only: code, fences, escapes and containers never exempt their contents. */
export function hiddenMarkdownReason(body: string): string | null {
  let previousPipe = false;
  let dollars = 0;
  let screenshots = 0;
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  for (const line of lines) {
    if ([...line].length > 200) return refusal("line length");
    if (/[ \t]{17}/u.test(line)) return refusal("whitespace run");
    const delimiter = line.replace(/^[\s>]+/u, "");
    for (const form of [delimiter, delimiter.replace(/^(?:[-*+]|\d+[.)]) /u, "")]) {
      if (/^[|:\s-]+$/u.test(form) && form.includes("-") && (form.includes("|") || form.includes(":") || previousPipe))
        return refusal("table");
    }
    previousPipe = line.includes("|");
    const attachment = SCREENSHOT.exec(line);
    const screenshot = attachment?.[0] === line ? attachment : null;
    if (screenshot) {
      screenshots++;
      if (!["", "Screenshot", `Screenshot ${screenshots}`].includes(screenshot[1] ?? "")) return refusal("alt text");
    }
    if (/^[ \t]*$/u.test(line)) dollars = 0;
    if (line.includes("$`") || line.includes("`$")) return refusal("math");
    for (let i = 0; i < line.length; ) {
      const char = line[i];
      if (char === "<") return refusal("raw HTML");
      if (char === "]" && line[i + 1] === ":") return refusal("reference definition");
      if (char === "]" && line[i + 1] === "(" && !screenshot) return refusal("link destination");
      if (char === "&") {
        CHARACTER_REFERENCE.lastIndex = i;
        if (CHARACTER_REFERENCE.test(line)) return refusal("character reference");
      }
      if (char === "$" && ++dollars >= 2) return refusal("math");
      if (char === ":") {
        let end = i + 1;
        let letter = false;
        while (end < line.length && /[A-Za-z0-9_+-]/u.test(line[end] ?? "")) {
          if (/[A-Za-z]/u.test(line[end] ?? "")) letter = true;
          end++;
        }
        if (line[end] === ":" && (letter || ["+1", "-1", "100", "1234"].includes(line.slice(i + 1, end))))
          return refusal("emoji shortcode");
        // This alphabet contains no other refusal trigger; inspect the delimiter next.
        i = end;
      } else if (char === "`" || char === "~") {
        let end = i + 1;
        while (line[end] === char) end++;
        // A permitted suffix contains no more runs, so at most one suffix per line is scanned.
        if (end - i >= 3 && !allowedFenceInfo(line, end)) return refusal("fence info");
        i = end;
      } else i++;
    }
    if (!screenshot && /github\.com\//iu.test(line)) return refusal("GitHub link");
  }
  return hiddenLineReason(lines);
}
