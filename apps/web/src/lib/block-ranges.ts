import { normalizeText } from "../../../../packages/core/src/render/normalize.ts";

type TextRun = { node: Text; start: number; end: number };
let graphemes: Intl.Segmenter | undefined;

/** Read-only mapping from normalized UTF-16 offsets to the original text nodes. */
export function mapBlockText(block: HTMLElement) {
  if (
    block.dataset.blockKind === "diagram" ||
    block.dataset.blockKind === "chart" ||
    block.dataset.blockText === undefined
  )
    return;
  const nodes: TextRun[] = [];
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let raw = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = raw.length;
    raw += node.textContent ?? "";
    if (raw.length > start) nodes.push({ node: node as Text, start, end: raw.length });
  }

  // Grapheme boundaries are safe NFC boundaries, including combining marks and
  // Hangul split across inline elements. A changed run maps to its outer edges.
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let nfc = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const { segment, index } of graphemes.segment(raw)) {
    const normalized = segment.normalize("NFC");
    const changed = normalized !== segment;
    nfc += normalized;
    for (let i = 0; i < normalized.length; i++) {
      starts.push(changed ? index : index + i);
      ends.push(changed ? index + segment.length : index + i + 1);
    }
  }
  let collapsed = "";
  const from: number[] = [];
  const to: number[] = [];
  for (const match of nfc.matchAll(/\p{White_Space}+|[^\p{White_Space}]/gu)) {
    const value = /^\p{White_Space}/u.test(match[0]) ? " " : match[0];
    collapsed += value;
    for (let i = 0; i < value.length; i++) {
      from.push(starts[match.index + i] as number);
      to.push(ends[match.index + (value === " " ? match[0].length - 1 : i)] as number);
    }
  }
  const trim = collapsed.length - collapsed.trimStart().length;
  const text = collapsed.trim();
  if (text !== normalizeText(block.dataset.blockText)) return;

  return (start: number, end: number): Range | undefined => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) return;
    const first = from[trim + start];
    const last = to[trim + end - 1];
    if (first === undefined || last === undefined) return;
    const head = nodes.find((run) => run.start <= first && first < run.end);
    const tail = nodes.find((run) => run.start < last && last <= run.end);
    if (!head || !tail) return;
    const range = block.ownerDocument.createRange();
    range.setStart(head.node, first - head.start);
    range.setEnd(tail.node, last - tail.start);
    return range;
  };
}
