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

/** Read only raw container prefixes; this never exempts code or escaped text. */
function containerPrefix(line: string) {
  let offset = 0;
  let continuation = "";
  let container = "";
  let afterList = false;
  const ordered: { digits: string; key: string }[] = [];
  while (offset < line.length) {
    const spaces = /^[ \t]+/u.exec(line.slice(offset));
    if (spaces) {
      continuation += spaces[0];
      offset += spaces[0].length;
      continue;
    }
    if (line[offset] === ">") {
      continuation += ">";
      container = continuation;
      offset++;
      afterList = false;
      continue;
    }
    const marker = /^([-+*]|(\d{1,9})([.)]))([ \t]+|$)/u.exec(line.slice(offset));
    if (!marker) break;
    if (marker[2]) ordered.push({ digits: marker[2], key: `${line.slice(0, offset)}|${marker[3]}` });
    continuation += " ".repeat(marker[1]?.length ?? 1) + (marker[4] || " ");
    container = continuation;
    offset += marker[0].length;
    afterList = true;
  }
  return { content: line.slice(offset), container, ordered, afterList };
}

function expandTabs(line: string): string {
  let expanded = "";
  for (const char of line) expanded += char === "\t" ? " ".repeat(4 - (expanded.length % 4)) : char;
  return expanded;
}

function hiddenStructureReason(lines: string[]): string | null {
  let seenOrdered = false;
  let previousKey = "";
  let nextNumber: number | null = null;
  let pendingTask: string | null = null;
  let fence: { container: string; close: RegExp; content: boolean } | null = null;
  for (const line of lines) {
    const prefix = containerPrefix(line);
    for (const { digits, key } of prefix.ordered) {
      if (digits.startsWith("0")) return refusal("list number");
      const number = Number(digits);
      if (!seenOrdered) {
        nextNumber = number + 1;
      } else if (key === previousKey && nextNumber !== null) {
        if (number !== 1 && number !== nextNumber) return refusal("list number");
        nextNumber++;
      } else {
        // Only an uninterrupted run at one prefix/indent proves a rendered
        // counter. Across possible boundaries or containers, fail closed to 1.
        if (number !== 1) return refusal("list number");
        nextNumber = null;
      }
      seenOrdered = true;
      previousKey = key;
    }
    if (prefix.ordered.length === 0) nextNumber = null;
    if (prefix.afterList && /^\[X\](?:[ \t]|$)/u.test(prefix.content)) return refusal("task marker");
    if (pendingTask !== null) {
      if (line.startsWith(pendingTask)) {
        const continuation = line.slice(pendingTask.length).trimStart();
        if (/^\[X\](?:[ \t]|$)/u.test(continuation)) return refusal("task marker");
        if (continuation) pendingTask = null;
      } else if (line.trim() || pendingTask.includes(">")) pendingTask = null;
    }
    if (prefix.afterList && !prefix.content) pendingTask = prefix.container;

    if (fence) {
      const expanded = expandTabs(line);
      const content = expanded.startsWith(fence.container)
        ? expanded.slice(fence.container.length)
        : !expanded.trim() && !fence.container.includes(">")
          ? ""
          : null;
      if (content === null) {
        // Leaving the quote/list closes an unterminated fenced block too.
        if (!fence.content) return refusal("empty code block");
        fence = null;
      } else if (fence.close.test(content)) {
        if (!fence.content) return refusal("empty code block");
        fence = null;
        continue;
      } else {
        if (content.trim()) fence.content = true;
        continue;
      }
    }
    const opening = /^(`{3,}|~{3,})[ \t]*[A-Za-z]*[ \t]*$/u.exec(prefix.content);
    if (opening?.[1]) {
      fence = {
        container: expandTabs(prefix.container),
        close: new RegExp(`^[ \\t]{0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*$`, "u"),
        content: false,
      };
    }
  }
  return fence && !fence.content ? refusal("empty code block") : null;
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
  return hiddenStructureReason(lines);
}
