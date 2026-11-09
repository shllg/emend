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
  | "look-alike task box"
  | "invisible character"
  | "task marker"
  | "empty code block"
  | "fence info";
const refusal = (kind: HiddenClass) => `hidden Markdown in the body: ${kind}`;

// Blank glyphs missed by both \s and Default_Ignorable_Code_Point:
// U+2800 is braille blank; U+1D159 is a null notehead; U+13441/U+13442
// are Egyptian full/half blanks; U+16FE4 is the Khitan small script filler.
// Each occupies space or has zero width without a visible mark.
export const BLANK_GLYPHS = /[\u2800\u{1d159}\u{13441}\u{13442}\u{16fe4}]/u;
const BOX_GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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

function thematicBreak(content: string): boolean {
  return /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u.test(content);
}

function headingOrBreak(content: string): boolean {
  return /^#{1,6}(?:[ \t]|$)/u.test(content) || thematicBreak(content);
}

function endsList(line: string, contentColumn: number): boolean {
  const prefix = /^ {0,3}(?=\S)/u.exec(line)?.[0];
  if (prefix === undefined || prefix.length >= contentColumn) return false;
  const content = line.slice(prefix.length);
  return headingOrBreak(content);
}

type Paragraph = { setext: boolean };
type Block = { paragraph: Paragraph | null };
type Container = Block &
  ({ kind: "quote" } | { kind: "item"; width: number; markerIndent: number; delimiter: string; blankStart: boolean });

/** Paragraphs belong to the last continued container, never to the whole body. */
function listStarts() {
  const root: Block = { paragraph: null };
  let containers: Container[] = [];
  let fence: { run: string; depth: number } | null = null;
  return (raw: string) => {
    let line = "";
    const offsets: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      const width = raw[i] === "\t" ? 4 - (line.length % 4) : 1;
      line += raw[i] === "\t" ? " ".repeat(width) : raw[i];
      for (let j = 0; j < width; j++) offsets.push(i);
    }
    let cursor = 0;
    const spaceEnd = () => {
      let end = cursor;
      while (line[end] === " ") end++;
      return end;
    };
    let sibling: Extract<Container, { kind: "item" }> | undefined;
    const previousScope = containers.at(-1) ?? root;
    let kept = 0;
    for (const container of containers) {
      const end = spaceEnd();
      if (container.kind === "quote") {
        if (end - cursor > 3 || line[end] !== ">") break;
        cursor = end + 1;
        if (line[cursor] === " ") cursor++;
      } else {
        if (end === line.length) {
          if (container.blankStart) break;
        } else if (end - cursor < container.width) {
          sibling = container;
          break;
        }
        cursor += Math.min(container.width, end - cursor);
      }
      kept++;
    }
    const rest = line.slice(spaceEnd());
    const blockStart =
      spaceEnd() - cursor <= 3 &&
      (headingOrBreak(rest) || /^(?:>|`{3,}|~{3,}|(?:[-*+]|\d{1,9}[.)])(?= |$))/u.test(rest));
    const lazy = kept < containers.length && !!rest && previousScope.paragraph && !blockStart && !fence;
    if (lazy) {
      // Lazy text stays in this paragraph, but cannot be a setext underline or
      // authorize a new list marker: it did not continue every container.
      return { markers: [] as number[], overIndented: spaceEnd() - cursor > 3, paragraph: previousScope.paragraph };
    }
    containers = containers.slice(0, kept);
    if (fence && kept < fence.depth) fence = null;
    let scope = containers.at(-1) ?? root;
    const starts: number[] = [];
    let paragraphMarker: number | undefined;
    if (fence) {
      // Code cannot create containers. Judge literal boxes against the outside
      // containers, without letting a code line change the next line's margin.
      const run = /^ {0,3}(`{3,}|~{3,}) *$/u.exec(line.slice(cursor))?.[1];
      if (run && run[0] === fence.run[0] && run.length >= fence.run.length) {
        fence = null;
        return { markers: starts, overIndented: false, paragraph: scope.paragraph };
      }
      const overIndented = spaceEnd() - cursor > 3;
      while (cursor < line.length) {
        const end = spaceEnd();
        if (end - cursor > 3) break;
        if (line[end] === ">") {
          cursor = end + 1;
          if (line[cursor] === " ") cursor++;
          continue;
        }
        const marker = /^(?:[-*+]|\d{1,9}[.)])(?= |$)/u.exec(line.slice(end))?.[0];
        if (!marker) break;
        starts.push(offsets[end] ?? raw.length);
        cursor = end + marker.length;
        if (line[cursor] === " ") cursor++;
      }
      return { markers: starts, overIndented, paragraph: scope.paragraph };
    }
    if (!rest) {
      scope.paragraph = null;
      return { markers: starts, overIndented: false, paragraph: scope.paragraph };
    }
    for (const container of containers) if (container.kind === "item") container.blankStart = false;
    while (cursor < line.length) {
      const end = spaceEnd();
      const indent = end - cursor;
      if (indent > 3) break;
      if (scope.paragraph && /^(?:=+|-+) *$/u.test(line.slice(end))) {
        scope.paragraph.setext = true;
        scope.paragraph = null;
        return { markers: starts, overIndented: false, paragraph: scope.paragraph };
      }
      if (line[end] === ">") {
        scope.paragraph = null;
        const quote: Container = { kind: "quote", paragraph: null };
        containers.push(quote);
        scope = quote;
        cursor = end + 1;
        if (line[cursor] === " ") cursor++;
        sibling = undefined;
        continue;
      }
      const content = line.slice(end);
      if (headingOrBreak(content)) break;
      const marker = /^(?:[-*+]|\d{1,9}[.)])(?= |$)/u.exec(content)?.[0];
      if (!marker) break;
      const delimiter = marker.at(-1) ?? "";
      const markerEnd = end + marker.length;
      const blank = /^ *$/u.test(line.slice(markerEnd));
      const isSibling = sibling?.delimiter === delimiter && sibling.markerIndent === indent;
      if (scope.paragraph && !isSibling && (blank || (marker.length > 1 && !/^1[.)]$/u.test(marker)))) {
        paragraphMarker = offsets[end];
        break;
      }
      starts.push(offsets[end] ?? raw.length);
      scope.paragraph = null;
      const base = cursor;
      cursor = markerEnd;
      const padding = spaceEnd() - cursor;
      cursor += blank || padding > 4 ? 1 : padding;
      const item: Container = {
        kind: "item",
        width: cursor - base,
        markerIndent: indent,
        delimiter,
        blankStart: blank,
        paragraph: null,
      };
      containers.push(item);
      scope = item;
      sibling = undefined;
    }
    const end = spaceEnd();
    const remaining = line.slice(end);
    const opener = /^(?:`{3,}|~{3,})/u.exec(remaining)?.[0];
    if (end - cursor <= 3 && opener) {
      fence = { run: opener, depth: containers.length };
      scope.paragraph = null;
    } else if (!remaining || (end - cursor <= 3 && headingOrBreak(remaining))) scope.paragraph = null;
    else if (end - cursor <= 3) scope.paragraph ??= { setext: false };
    // Indented code opens no paragraph; over-indented paragraph text keeps one.
    return { markers: starts, overIndented: end - cursor > 3, paragraph: scope.paragraph, paragraphMarker };
  };
}

/** Conservative raw-line rules with a partial, fail-closed container tracker. */
function hiddenLineReason(lines: string[]): string | null {
  // These broad scans impose raw number limits, including malformed prefixes.
  // A separate raw leading-chain scan below opens ordered refusal contexts;
  // the container tracker authorizes only boxes that can start actual items.
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
  let sequenceContentColumn = 0;
  let blankStart = false;
  let blankItemBlock = false;
  // Within a run of same-delimiter, column-zero markers, strict k, k+1, ...
  // renders as written whether a line continues the list, restarts it (its start
  // is shown), or stays paragraph text. A literal 1 is a bounded allowance:
  // hidden digits are only 1s, at most one per marker. After a later 1,
  // continuation and restart diverge, so the run accepts only 1s; they cannot
  // spell anything. In the flat case every item's content is indented at least
  // two columns. After a Markdown blank line (spaces/tabs only), a column-zero
  // non-marker line is never lazy continuation or inside an item, so it ends the
  // open list and resets the run. An ATX heading or thematic break with at most
  // three leading spaces also ends it when below the item's content column.
  // Inside a top-level fence, the digits are code text the page shows.
  for (const [index, line] of lines.entries()) {
    const marker = markers[index];
    const followsBlank = index > 0 && /^[ \t]*$/u.test(lines[index - 1] ?? "");
    if ((flat && followsBlank && /^\S/u.test(line) && !marker) || (flat && endsList(line, sequenceContentColumn))) {
      previous = undefined;
      delimiter = undefined;
      onesOnly = false;
      sequenceContentColumn = 0;
      blankStart = false;
      blankItemBlock = false;
    }
    if (blankStart && !marker) {
      const indentation = /^[ \t]*/u.exec(line)?.[0] ?? "";
      const column = columns(indentation);
      if (
        column >= sequenceContentColumn &&
        column < sequenceContentColumn + 4 &&
        headingOrBreak(line.slice(indentation.length))
      )
        blankItemBlock = true;
    }
    if (!marker) continue;
    if (marker[3] !== delimiter) {
      delimiter = marker[3];
      previous = undefined;
      onesOnly = false;
      blankItemBlock = false;
    }
    const number = Number(marker[2]);
    // A block inside a non-one blank-start item cannot authorize a restart at 1.
    // Refuse that shape even though the general literal-one allowance covers it.
    if (number === 1 && previous !== 1 && blankItemBlock) return refusal("list number");
    if (number !== 1 && (!flat || (previous !== undefined && (onesOnly || number !== previous + 1))))
      return refusal("list number");
    if (previous !== undefined && number === 1) onesOnly = true;
    previous = number;
    const markerEnd = columns(marker[0]);
    const spacing = /^[ \t]*/u.exec(line.slice(marker[0].length))?.[0] ?? "";
    blankStart = marker[0].length + spacing.length === line.length;
    blankItemBlock = false;
    // A blank-start item has one column of padding, regardless of trailing spaces.
    const padding = blankStart ? 1 : columns(marker[0] + spacing) - markerEnd;
    sequenceContentColumn = markerEnd + (padding > 0 && padding <= 4 ? padding : 1);
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
  let orderedItem: {
    markerColumn: number;
    contentColumn: number;
    quoteDepth: number;
    paragraphOnly: boolean;
  } | null = null;
  let sawFence = false;
  // This coarse tracker only adds refusals. It never hides ordered markers or
  // restores an item; the context's fence flag survives apparent closers.
  let fenceRun: string | null = null;
  let fenceHasContainers = false;
  const boxColumns: number[] = [];
  // Each line retains its paragraph object. A later continued underline marks
  // that same object, including after lazy text or non-interrupting markers.
  // Blank lines and new blocks retire it, so later paragraphs cannot taint it.
  const structure = lines.map(listStarts());
  for (const [index, line] of lines.entries()) {
    const current = structure[index];
    if (!current) return refusal("task marker");
    const { markers: starts, overIndented, paragraphMarker } = current;
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
    // Disjoint prefix tokens keep repeated marker/space chains linear.
    const fence = /^((?:[ \t>]|(?:[-*+]|\d{1,9}[.)])(?=[ \t]))*)(`{3,}|~{3,})([ \t]*(?:[A-Za-z]+[ \t]*)?)$/u.exec(line);
    // Only column-zero boundaries at this quote depth or shallower can end
    // the context. Fence guesses never suppress its creation or restore it.
    const boundaryLine = line.replace(/^(?:>[ \t]?)+/u, "");
    const followsContextBlank = index > 0 && /^[ \t]*$/u.test(lines[index - 1] ?? "");
    if (
      orderedItem &&
      quoteDepth <= orderedItem.quoteDepth &&
      /^\S/u.test(boundaryLine) &&
      (headingOrBreak(boundaryLine) || (fence !== null && /^[`~]/u.test(boundaryLine)) || followsContextBlank)
    ) {
      orderedItem = null;
      sawFence = false;
    }
    // Raw markers retain the ordered/fence refusals even when the paragraph
    // reading cannot open the item. A definite paragraph only relaxes layout.
    const chain = /^(?:[ \t>]|(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$))*/u.exec(line)?.[0] ?? "";
    for (const marker of chain.matchAll(/(\d{1,9})[.)]([ \t]*)/gu)) {
      const end = marker.index + marker[0].length;
      if (!marker[2] && end < line.length) continue;
      const markerColumn = columns(line.slice(0, marker.index));
      if (marker[1] === "1") {
        if (orderedItem && markerColumn <= orderedItem.markerColumn) {
          orderedItem = null;
          sawFence = false;
        }
      } else if (!orderedItem || orderedItem.paragraphOnly || markerColumn <= orderedItem.markerColumn) {
        const markerEnd = columns(line.slice(0, end - (marker[2]?.length ?? 0)));
        const padding = end === line.length ? 1 : columns(line.slice(0, end)) - markerEnd;
        // Blank starts, absent padding and padding beyond four use one column.
        const contentColumn = markerEnd + (padding > 0 && padding <= 4 ? padding : 1);
        // Nested markers retain the outer context. Siblings retain its flag
        // until a structural boundary or a literal-one sibling ends it.
        orderedItem = {
          markerColumn,
          contentColumn,
          quoteDepth: line.slice(0, marker.index).match(/>/gu)?.length ?? 0,
          paragraphOnly: paragraphMarker === marker.index,
        };
      }
    }
    if (orderedItem && fence) sawFence = true;
    const fencedContext = sawFence || fenceRun !== null;
    // Under an unquoted later step, a checklist needs a real list start, spaces,
    // one dash and space, a canonical box, then one space and non-space text.
    // Children and siblings align with an open parent's box. A non-checklist
    // line clears that alignment stack; it does not reopen any container.
    const canonicalBox = /^( *)- \[[ x]\] \S/u.exec(line);
    if (canonicalBox) {
      while (indent < (boxColumns.at(-1) ?? 0)) boxColumns.pop();
    }
    // GitHub may find boxes in rendered text and hide their list numbers. Strip
    // escapes before checking the whole leading chain; only canonical boxes and
    // literal-one numbers are safe. A split box needs a marker, so JSON's bare
    // opening bracket remains text. Only whitespace and x/X can form a box;
    // other bracketed characters stay text. Closed bare boxes can be lazy continuations.
    const t = line.replaceAll("\\", "");
    const boxShape = /^(.*?)\[([\sxX]+)\]/u.exec(t);
    if (boxShape && /(?:[-*+]|\d+[.)])[ \t]*$/u.test(boxShape[1] ?? "") && /[^ \t>\d.*+)-]/u.test(boxShape[1] ?? ""))
      return refusal("task marker");
    // A marker-only line can start an item whose first paragraph is on this line.
    // Check that combined chain too, so a split box cannot hide the item's number.
    const previousLine = (lines[index - 1] ?? "").replaceAll("\\", "");
    const followsMarker = /^(?:[ \t>]|(?:[-*+]|\d+[.)])(?=[ \t]|$))*(?:[-*+]|\d+[.)])[ \t]*$/u.test(previousLine);
    const taskLines = [{ text: t, shift: 0 }];
    if (followsMarker) {
      const leading = /^[\s>]*/u.exec(t)?.[0].length ?? 0;
      taskLines.push({ text: previousLine + t.slice(leading), shift: previousLine.length - leading });
    }
    for (const { text, shift } of taskLines) {
      // Deliberately recognize malformed and Unicode-spaced prefixes here too:
      // this scan only refuses. Only the container reading can authorize an actual item.
      const task = /^((?:[\s>]|[-*+]|\d+[.)])*)\[(?:([\sxX]+)\]|\s*$)/u.exec(text);
      if (task) {
        const prefix = task[1] ?? "";
        const split = task[2] === undefined;
        if (split && !/^[\s>]*\]/u.test((lines[index + 1] ?? "").replaceAll("\\", ""))) continue;
        if (!split || /[-*+]|\d{1,9}[.)]/u.test(prefix) || orderedItem || overIndented) {
          // Defence in depth: real-list validation also rejects invalid prefixes.
          if (/[^ \t>\d.*+)-]/u.test(prefix)) return refusal("task marker");
          if (orderedItem && fencedContext) return refusal("task marker");
          if (task[2] !== " " && task[2] !== "x") return refusal("task marker");
          if (/[^ \t]/u.test(text[task[0].length] ?? "")) return refusal("task marker");
          // Task text must start on this line; later text cannot rescue a bare box.
          if (!/\S/u.test(text.slice(task[0].length))) return refusal("task marker");
          // cmark sets checked state from any literal [x]/[X] on the raw line.
          if (task[2] === " " && /\[[xX]\]/u.test(line)) return refusal("task marker");
          if ([...prefix.matchAll(/(\d{1,9})[.)]/gu)].some((number) => number[1] !== "1"))
            return refusal("list number");
          // The task regex matched a marker-only prefix, so the first [ and ]
          // delimit this box; escapes later in its text remain ordinary text.
          const boxEnd = line.indexOf("]", line.indexOf("["));
          if (line.slice(0, boxEnd + 1).includes("\\")) return refusal("task marker");
          if (
            orderedItem &&
            !orderedItem.paragraphOnly &&
            // Defence in depth: uncontinued quotes also fail the item-start check.
            (orderedItem.quoteDepth > 0 ||
              !canonicalBox ||
              (indent !== orderedItem.contentColumn && !boxColumns.includes(indent)))
          )
            return refusal("task marker");
          // All ordered markers above are 1; require a final marker and 1-4 ASCII spaces.
          const padding = /(?:[-*+]|\d{1,9}[.)])([ \t]+)$/u.exec(prefix)?.[1];
          if (!padding || padding.includes("\t") || padding.length > 4) return refusal("task marker");
          if (current.paragraph?.setext) return refusal("task marker");
          const finalMarker = /(?:[-*+]|\d{1,9}[.)])[ \t]+$/u.exec(prefix);
          if (!finalMarker || !starts.includes(finalMarker.index - shift)) return refusal("task marker");
        }
      }
    }
    // cmark's task scanner accepts digits plus any character as a marker and
    // drops source bytes after consuming quote/list containers. The marker right
    // before the box must be a normal literal-one marker, even inside a chain.
    if (
      /^(?:[ \t>]|(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$))*\d+[^\n][ \t]+\[[ xX]\](?:[ \t]|$)/u.test(line) &&
      !/^(?:[ \t>]|(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$))*1[.)][ \t]+\[/u.test(line)
    )
      return refusal("task marker");
    if (orderedItem && canonicalBox) boxColumns.push(indent + 2);
    else boxColumns.length = 0;
    if (fence?.[2]) {
      if (!fenceRun) {
        fenceRun = fence[2];
        fenceHasContainers = /[^ \t]/u.test(fence[1] ?? "");
      } else if (
        (fenceHasContainers || /^[ \t]*$/u.test(fence[1] ?? "")) &&
        !fence[3]?.trim() &&
        fence[2][0] === fenceRun[0] &&
        fence[2].length >= fenceRun.length
      )
        fenceRun = null;
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
  if (needsContent) return refusal("empty code block");
  // Preserve earlier refusal reasons. A short bracket group after a prefix
  // without ASCII letters can disguise a task through non-ASCII glyphs in
  // either the prefix or the group, even when the parser sees only text.
  // Count visible graphemes, including overlays. Non-ASCII opening/closing
  // punctuation also bounds a group; ASCII parentheses and braces do not.
  for (const line of lines) {
    for (const box of line.matchAll(
      /(?:\[|(?=\P{ASCII})\p{Ps})((?:[^\p{Ps}\p{Pe}]|[(){}])*)(?:\]|(?=\P{ASCII})\p{Pe})/gu,
    )) {
      const content = box[1] ?? "";
      const count = [...BOX_GRAPHEMES.segment(content)].length;
      if (count < 1 || count > 3) continue;
      const prefix = line.slice(0, box.index);
      if (!/[A-Za-z]/u.test(prefix) && /\P{ASCII}/u.test(prefix + box[0])) return refusal("look-alike task box");
      break; // Only the first short group is judged.
    }
  }
  return null;
}

/** Raw-text rules only: code, fences, escapes and containers never exempt their contents. */
export function hiddenMarkdownReason(body: string): string | null {
  // JavaScript-only line separators and blank glyphs can make literal text
  // look like a task. Keep this guard even when the caller checks invisible text.
  if (/[\u2028\u2029]/u.test(body) || BLANK_GLYPHS.test(body)) return refusal("invisible character");
  let previousPipe = false;
  let dollars = 0;
  let screenshots = 0;
  const lines = body.split(/\r\n|[\r\n]/u);
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
