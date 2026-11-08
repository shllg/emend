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
  if (lines.some((line) => /^(?:[\s>]|[-*+]|\d{1,9}[.)])*0\d{0,8}[.)](?=[ \t]|$)/u.test(line)))
    return refusal("list number");
  // A nonzero, non-task marker later in a leading chain opens a new nested list
  // as its first item, whose number is shown. Task numbers are checked below.
  const markers = lines.map((line) => /^([\s>]*)(\d{1,9})([.)])(?=[ \t]|$)/u.exec(line));
  const flat = markers.every((marker) => !marker || marker[1] === "");
  let previous: number | undefined;
  let delimiter: string | undefined;
  let onesOnly = false;
  // Within a run of same-delimiter, column-zero markers, strict k, k+1, ...
  // renders as written whether a line continues the list, restarts it (its start
  // is shown), or stays paragraph text. A literal 1 is a bounded allowance:
  // hidden digits are only 1s, at most one per marker. After a later 1,
  // continuation and restart diverge, so the run accepts only 1s; they cannot
  // spell anything. In the flat case every item's content is indented at least
  // two columns. After a Markdown blank line (spaces/tabs only), a column-zero
  // non-marker line is never lazy continuation or inside an item, so it ends the
  // open list and resets the run.
  // Inside a top-level fence, the digits are code text the page shows.
  for (const [index, line] of lines.entries()) {
    const marker = markers[index];
    const followsBlank = index > 0 && /^[ \t]*$/u.test(lines[index - 1] ?? "");
    if (flat && followsBlank && /^\S/u.test(line) && !marker) {
      previous = undefined;
      delimiter = undefined;
      onesOnly = false;
    }
    if (!marker) continue;
    if (marker[3] !== delimiter) {
      delimiter = marker[3];
      previous = undefined;
      onesOnly = false;
    }
    const number = Number(marker[2]);
    if (number !== 1 && (!flat || (previous !== undefined && (onesOnly || number !== previous + 1))))
      return refusal("list number");
    if (previous !== undefined && number === 1) onesOnly = true;
    previous = number;
  }

  // Check openers with zero to three leading ASCII spaces, no tab or >. This is
  // exact at the top level and refuses some empty list-item fences (fail closed).
  // Openers behind > or indented further keep the bounded info-word allowance:
  // their boundaries need structure, which this raw-line rule does not model.
  // A closer must be in the opener's container, whose content offset is at most
  // the opener's indentation. CommonMark permits a closer up to that offset + 3,
  // so using opener indentation + 3 never under-detects a closer. An outer fence
  // holding a literal empty fence example may still be refused (fail closed).
  let needsContent: string | null = null;
  let openerIndent = 0;
  for (const line of lines) {
    // GitHub hides a task item's ordered number, whether checked or unchecked.
    const numberedTask = /^(?:[\s>]|[-*+]|\d{1,9}[.)])*(\d{1,9})[.)][ \t]+\[[ xX]\]/u.exec(line);
    if (numberedTask && numberedTask[1] !== "1") return refusal("list number");
    if (/^[\s>]*\[[xX ]\]/u.test(line) || /^(?:[\s>]|[-*+]|\d{1,9}[.)])*\[X\]/u.test(line))
      return refusal("task marker");
    let contentStart = 0;
    let indent = 0;
    while (line[contentStart] === " " || line[contentStart] === "\t") {
      indent += line[contentStart] === "\t" ? 4 - (indent % 4) : 1;
      contentStart++;
    }
    // Strip only ASCII indentation: a leading > remains code content.
    const content = line.slice(contentStart);
    if (needsContent && content.trim()) {
      const closer = /^(`{3,}|~{3,})[ \t]*$/u.exec(content)?.[1];
      if (closer && indent <= openerIndent + 3) {
        if (closer[0] === needsContent[0] && closer.length >= needsContent.length) return refusal("empty code block");
      }
      needsContent = null;
    }
    const opener = /^ {0,3}(`{3,}|~{3,})[ \t]*[A-Za-z]+[ \t]*$/u.exec(line);
    if (opener?.[1]) {
      needsContent = opener[1];
      openerIndent = indent;
    }
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
