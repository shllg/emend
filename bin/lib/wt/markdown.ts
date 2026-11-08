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

function columns(text: string): number {
  let column = 0;
  for (const char of text) column += char === "\t" ? 4 - (column % 4) : 1;
  return column;
}

/** Conservative raw-line rules, without reconstructing CommonMark containers. */
function hiddenLineReason(lines: string[]): string | null {
  // Long starts can be drawn outside the comment box, including nested starts.
  if (lines.some((line) => /^(?:[\s>]|[-*+]|\d{1,9}[.)])*\d{4,9}[.)](?=[ \t]|$)/u.test(line)))
    return refusal("list number");
  if (lines.some((line) => /^(?:[\s>]|[-*+]|\d{1,9}[.)])*0\d{0,8}[.)](?=[ \t]|$)/u.test(line)))
    return refusal("list number");
  // Nested starts use roman/alpha markers on GitHub; keep their width bounded.
  if (lines.some((line) => /^(?:[\s>]|[-*+]|\d{1,9}[.)])+\d{2,9}[.)](?=[ \t]|$)/u.test(line)))
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
  let orderedItem: { markerColumn: number; contentColumn: number } | null = null;
  let taskFence: { run: string; column: number; inItem: boolean; quoteDepth: number; minColumn: number } | null = null;
  for (const [index, line] of lines.entries()) {
    let contentStart = 0;
    let indent = 0;
    while (line[contentStart] === " " || line[contentStart] === "\t") {
      indent += line[contentStart] === "\t" ? 4 - (indent % 4) : 1;
      contentStart++;
    }
    // Strip only ASCII indentation: a leading > remains code content.
    const content = line.slice(contentStart);
    const containerPrefix = /^[ \t>]*/u.exec(line)?.[0] ?? "";
    const quoteDepth = containerPrefix.match(/>/gu)?.length ?? 0;
    // Leaving a quote or list closes its fence. Do not let the old fence hide
    // the start of a later ordered item from this context check.
    if (
      taskFence &&
      content.trim() &&
      (quoteDepth < taskFence.quoteDepth || columns(containerPrefix) < taskFence.minColumn)
    )
      taskFence = null;
    // A blank followed by column-zero text ends the earlier item. A sibling
    // literal-one item ends it too; nested checklists at its content column do not.
    if (orderedItem && index > 0 && /^[ \t]*$/u.test(lines[index - 1] ?? "") && /^\S/u.test(line)) {
      orderedItem = null;
      if (taskFence?.inItem) taskFence = null;
    }
    if (!taskFence) {
      const chain = /^(?:[\s>]|[-*+]|\d{1,9}[.)])*/u.exec(line)?.[0] ?? "";
      for (const marker of chain.matchAll(/(\d{1,9})[.)]([ \t]*)/gu)) {
        const end = marker.index + marker[0].length;
        if (!marker[2] && end < line.length) continue;
        const markerColumn = columns(line.slice(0, marker.index));
        if (marker[1] === "1") {
          if (orderedItem && markerColumn <= orderedItem.markerColumn) orderedItem = null;
        } else {
          const markerEnd = columns(line.slice(0, end - (marker[2]?.length ?? 0)));
          const padding = columns(line.slice(0, end)) - markerEnd;
          // CommonMark uses one column when padding is absent or exceeds four.
          orderedItem = { markerColumn, contentColumn: markerEnd + (padding > 0 && padding <= 4 ? padding : 1) };
        }
      }
    }
    // GitHub may find boxes in rendered text and hide their list numbers. Strip
    // escapes before checking the whole leading chain; only canonical boxes and
    // literal-one numbers are safe. A split box needs a marker, so JSON's bare
    // opening bracket remains text. Only whitespace and x/X can form a box;
    // other bracketed characters stay text. Closed bare boxes can be lazy continuations.
    const t = line.replaceAll("\\", "");
    // A marker-only line can start an item whose first paragraph is on this line.
    // Check that combined chain too, so a split box cannot hide the item's number.
    const previousLine = (lines[index - 1] ?? "").replaceAll("\\", "");
    const followsMarker = /^(?:[\s>]|[-*+]|\d+[.)])*(?:[-*+]|\d+[.)])[ \t]*$/u.test(previousLine);
    const taskLines = [t];
    if (followsMarker) taskLines.push(previousLine + t.replace(/^[\s>]+/u, ""));
    for (const text of taskLines) {
      const task = /^((?:[\s>]|[-*+]|\d+[.)])*)\[(?:([\sxX])\]|\s*$)/u.exec(text);
      if (task) {
        const prefix = task[1] ?? "";
        const split = task[2] === undefined;
        if (!split || /[-*+]|\d+[.)]/u.test(prefix) || orderedItem) {
          if (orderedItem && (split || taskFence?.inItem || indent >= orderedItem.contentColumn + 4))
            return refusal("task marker");
          if (task[2] !== " " && task[2] !== "x") return refusal("task marker");
          // cmark sets checked state from any literal [x]/[X] on the raw line.
          if (task[2] === " " && /\[[xX]\]/u.test(line)) return refusal("task marker");
          if ([...prefix.matchAll(/(\d+)[.)]/gu)].some((number) => number[1] !== "1")) return refusal("list number");
          if (line.slice(0, line.indexOf("[")).includes("\\")) return refusal("task marker");
          // All ordered markers above are 1; require a final marker and spacing.
          if (!/(?:[-*+]|\d+[.)])[ \t]+$/u.test(prefix)) return refusal("task marker");
        }
      }
    }
    // cmark's task scanner accepts digits plus any character as a marker and
    // drops source bytes after consuming quote/list containers. The marker right
    // before the box must be a normal literal-one marker, even inside a chain.
    if (
      /^(?:[\s>]|[-*+]|\d{1,9}[.)])*\d+[^\n][ \t]+\[[ xX]\](?:[ \t]|$)/u.test(line) &&
      !/^(?:[\s>]|[-*+]|\d{1,9}[.)])*1[.)][ \t]+\[/u.test(line)
    )
      return refusal("task marker");
    const fence = /^([ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+[ \t>]*)*)(`{3,}|~{3,})([ \t]*[A-Za-z]*[ \t]*)$/u.exec(line);
    if (fence?.[2]) {
      const column = columns(fence[1] ?? "");
      if (taskFence) {
        if (
          !fence[3]?.trim() &&
          /^[ \t>]*$/u.test(fence[1] ?? "") &&
          quoteDepth === taskFence.quoteDepth &&
          fence[2][0] === taskFence.run[0] &&
          fence[2].length >= taskFence.run.length &&
          column <= taskFence.column + 3
        )
          taskFence = null;
      } else {
        const inItem = orderedItem !== null && column >= orderedItem.contentColumn;
        const fenceQuoteDepth = fence[1]?.match(/>/gu)?.length ?? 0;
        const listPrefix = [...(fence[1] ?? "").matchAll(/(?:[-*+]|\d{1,9}[.)])([ \t]+)/gu)].at(-1);
        let minColumn = inItem ? (orderedItem?.contentColumn ?? 0) : 0;
        if (listPrefix) {
          const markerEnd = columns(
            line.slice(0, listPrefix.index + listPrefix[0].length - (listPrefix[1]?.length ?? 0)),
          );
          const padding = columns(line.slice(0, listPrefix.index + listPrefix[0].length)) - markerEnd;
          minColumn = Math.max(minColumn, markerEnd + (padding <= 4 ? padding : 1));
        }
        // Four-space code at the top level is literal, not a fence opener.
        if (inItem || listPrefix || fenceQuoteDepth > 0 || column <= 3)
          taskFence = { run: fence[2], column, inItem, quoteDepth: fenceQuoteDepth, minColumn };
      }
    }
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
