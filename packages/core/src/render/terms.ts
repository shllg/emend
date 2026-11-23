import { normalizeGlossaryForm } from "@emend/contract";
import { type HtmlElement, type HtmlRoot, renderData } from "./blocks.ts";
import { type DocTermMatcher, longMarkRun, scanDocTerms } from "./doc-terms.ts";

// Matches stay in one text node; word boundaries include neighbours across inline elements.
// Letters, marks, digits and _ are word characters. Match edges must also be grapheme boundaries.
// Forms and the matching view use NFC; marks keep the source text. Spaces match whitespace runs.
// Case is ignored except for acronyms (no lowercase and at least two uppercase letters). Allow trailing s/es, and
// prefer the longest form at a position. Other inflections belong in aliases.
const escapePattern = (text: string) => text.replace(/[\^$\\.*+?()[\]{}|/]/g, "\\$&");
const boundary = "[\\p{L}\\p{M}\\p{N}_]";
const startsWord = new RegExp(`^${boundary}`, "u");
const endsWord = new RegExp(`${boundary}$`, "u");
const skipped = new Set(["a", "code", "pre", "kbd", "samp", "h1", "h2", "h3", "h4", "h5", "h6"]);
export const phrasing = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
]);
// Keep both classifications explicit so additions to the sanitize schema need a decision.
export const runBreaks = new Set([
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "li",
  "ol",
  "p",
  "picture",
  "pre",
  "section",
  "source",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);
let segmenter: Intl.Segmenter | undefined;

export const TERM_MATCH_WORK_BUDGET = 400_000_000;
// A doc does not use the regex matcher above: it walks a prefix tree (doc-terms.ts) and stops after this many
// steps. Charged: 1 per code point compared (each tree lookup), per whitespace character a space consumes,
// per start position tried, per form that ends on the way, per character of the s/es suffix check and per
// character of an acronym's exact check; DOC_TERM_LOOKUP_STEPS for the first fold and the first word lookup of
// a character; DOC_TERM_SEGMENT_FIXED_STEPS plus DOC_TERM_SEGMENT_STEPS per character when a text node must
// be split into graphemes (ordinary ASCII text does not need it; a Markdown text node that is not NFC is
// charged this up front). Measured here (median of five runs), 10,000,000 steps take about 0.25 s or less on
// every shape tried: the hostile 450-form shapes, 450 forms on one tree node (the slowest), refused acronyms,
// 150,000 tiny text nodes that each need a split, a budget spent through segmentation alone and one spent
// through first-seen lookups alone. Ordinary English prose costs about 1.2 to 2 steps per character (1.2 when
// few words start a term, about 1.9 against 50 terms made of common words), so the budget covers about
// 5,000,000 to 8,000,000 characters of it. Non-ASCII prose in paragraphs of about 1,000 characters that each
// hold a candidate with a non-ASCII edge costs about 33 steps per character (about 300,000 characters).
// Not counted, each linear in the text: building the tree (3 to 6 ms for 450 forms), the check for a run of
// more than 30 combining marks (at most 23 ns per character: 24 ms for a 1 MiB doc and 0.19 s for 8 MiB) and
// the NFC normalization of each text node (at most 25 ns per character, on runs of 30 marks in the worst
// order: 26 ms and 0.21 s). A text node with a longer run of marks gets no marks.
export const DOC_TERM_MATCH_STEP_BUDGET = 10_000_000;

export function termMatcher(entries: { term: string; aliases?: string[] }[], budget = TERM_MATCH_WORK_BUDGET) {
  let weight = 0;
  const forms = entries
    .flatMap((entry, index) =>
      [entry.term, ...(entry.aliases ?? [])].map((form) => ({
        form: normalizeGlossaryForm(form),
        entry: index,
      })),
    )
    .filter(({ form }) => form.length > 0)
    .sort((a, b) => b.form.length - a.form.length)
    .map(({ form, entry }) => {
      weight += form.length;
      const source = `${form.split(" ").map(escapePattern).join("\\s+")}(?:es|s)?(?!${boundary})`;
      const acronym = !/\p{Ll}/u.test(form) && (form.match(/\p{Lu}/gu)?.length ?? 0) >= 2;
      return { entry, source, acronym, at: new RegExp(source, acronym ? "uy" : "iuy") };
    });
  return {
    count: entries.length,
    weight,
    remaining: budget,
    forms,
    pattern: new RegExp(`(?<!${boundary})(?:${forms.map(({ source }) => `(${source})`).join("|")})`, "giu"),
  };
}
export type TermMatcher = ReturnType<typeof termMatcher>;

function charge(matcher: TermMatcher, units: number) {
  if (units > matcher.remaining) {
    matcher.remaining = 0;
    return false;
  }
  matcher.remaining -= units;
  return true;
}

type HtmlText = Extract<HtmlElement["children"][number], { type: "text" }>;

function inlineNeighbours(tree: HtmlRoot) {
  const neighbours = new WeakMap<HtmlText, { before: boolean; after: boolean }>();
  let previous: { node: HtmlText; edges: { before: boolean; after: boolean } } | undefined;
  const stack: { parent: HtmlRoot | HtmlElement; index: number; breaksRun: boolean }[] = [
    { parent: tree, index: 0, breaksRun: true },
  ];
  while (stack.length) {
    const frame = stack.at(-1);
    if (!frame) break;
    const node = frame.parent.children[frame.index++];
    if (!node) {
      if (frame.breaksRun) previous = undefined;
      stack.pop();
    } else if (node.type === "element") {
      if (renderData(node).emendMedia !== undefined || renderData(node).emendDiagram !== undefined) {
        previous = undefined;
        continue;
      }
      const breaksRun = !phrasing.has(node.tagName);
      if (breaksRun) previous = undefined;
      stack.push({ parent: node, index: 0, breaksRun });
    } else if (node.type === "text" && node.value.length) {
      const edges = { before: !!previous && endsWord.test(previous.node.value), after: false };
      if (previous) previous.edges.after = startsWord.test(node.value);
      neighbours.set(node, edges);
      previous = { node, edges };
    }
  }
  return neighbours;
}

export function markTerms() {
  return (tree: HtmlRoot, file: { data: Record<string, unknown> }) => {
    const matcher = file.data.terms as TermMatcher | DocTermMatcher | undefined;
    if (!matcher?.forms.length || matcher.remaining <= 0) return;
    const neighbours = inlineNeighbours(tree);
    const seen = new Set<number>();
    const stack: { parent: HtmlRoot | HtmlElement; index: number }[] = [{ parent: tree, index: 0 }];
    while (stack.length && seen.size < matcher.count) {
      const frame = stack.at(-1);
      if (!frame) break;
      const node = frame.parent.children[frame.index++];
      if (!node) {
        stack.pop();
        continue;
      }
      if (node.type === "element") {
        if (
          skipped.has(node.tagName) ||
          renderData(node).emendGlossary === true ||
          renderData(node).emendMedia !== undefined ||
          renderData(node).emendDiagram !== undefined ||
          (Array.isArray(node.properties.className) &&
            (node.properties.className.includes("emend-term") ||
              node.properties.className.includes("emend-callout-marker")))
        )
          continue;
        stack.push({ parent: node, index: 0 });
      } else if (node.type === "text") {
        // A doc: text with a run of more than 30 combining marks costs quadratic time to normalize, so it
        // gets no marks and is not normalized. The writeup's regex path does not check.
        if ("trie" in matcher && longMarkRun(node.value)) continue;
        let view = node.value.normalize("NFC");
        let offsets: Map<number, number> | undefined;
        if (view !== node.value) {
          segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
          offsets = new Map();
          const clusters: string[] = [];
          let offset = 0;
          for (const { segment, index } of segmenter.segment(node.value)) {
            offsets.set(offset, index);
            const normalized = segment.normalize("NFC");
            clusters.push(normalized);
            offset += normalized.length;
          }
          view = clusters.join("");
          offsets.set(view.length, node.value.length);
        }
        const edges = neighbours.get(node);
        const rangeAt = (index: number, length: number) => {
          // Without offsets the node is NFC and not yet segmented: only the doc matcher asks then, for a
          // range whose edges are certain boundaries, so the index is its own offset.
          const start = offsets ? offsets.get(index) : index;
          const finish = offsets ? offsets.get(index + length) : index + length;
          if (
            start === undefined ||
            finish === undefined ||
            (start === 0 && edges?.before) ||
            (finish === node.value.length && edges?.after)
          )
            return;
          return { start, finish };
        };
        // Unchanged NFC nodes need segmentation only once a candidate exists.
        const segmentOnDemand = () => {
          if (offsets) return;
          segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
          offsets = new Map();
          for (const { index } of segmenter.segment(node.value)) offsets.set(index, index);
          offsets.set(view.length, node.value.length);
        };
        const advance = (index: number) => index + ((view.codePointAt(index) ?? 0) > 0xffff ? 2 : 1);
        const replacements: HtmlElement["children"] = [];
        let end = 0;
        const place = (entry: number, start: number, finish: number) => {
          if (start > end) replacements.push({ type: "text", value: node.value.slice(end, start) });
          replacements.push({
            type: "element",
            tagName: "span",
            properties: { className: ["emend-term"], dataEmendTerm: String(entry) },
            children: [{ type: "text", value: node.value.slice(start, finish) }],
          });
          end = finish;
          seen.add(entry);
        };
        if ("trie" in matcher) {
          // A doc: the prefix tree counts its own steps, and marks nothing once the budget is spent. A node
          // that is not NFC was segmented above, so the scan charges that work first.
          const scanned = scanDocTerms(
            matcher,
            view,
            rangeAt,
            seen,
            (entry, { start, finish }) => {
              place(entry, start, finish);
              return seen.size === matcher.count;
            },
            segmentOnDemand,
            offsets !== undefined,
          );
          if (!scanned) return;
          if (!replacements.length) continue;
          if (end < node.value.length) replacements.push({ type: "text", value: node.value.slice(end) });
          frame.parent.children.splice(frame.index - 1, 1, ...replacements);
          frame.index += replacements.length - 1;
          continue;
        }
        // The same matcher carries the remaining work across every writeup section.
        if (!charge(matcher, view.length * matcher.weight)) return;
        matcher.pattern.lastIndex = 0;
        for (let match = matcher.pattern.exec(view); match; match = matcher.pattern.exec(view)) {
          if (!charge(matcher, matcher.forms.length)) return;
          let form = matcher.forms[match.findIndex((value, index) => index > 0 && value !== undefined) - 1];
          let length = match[0].length;
          if (!form) continue;
          segmentOnDemand();
          let range = rangeAt(match.index, length);
          if (form.acronym || !range) {
            // Recheck case and boundaries together so a refused form cannot hide a shorter one.
            if (!charge(matcher, matcher.weight)) return;
            range = undefined;
            for (const candidate of matcher.forms) {
              candidate.at.lastIndex = match.index;
              const exact = candidate.at.exec(view);
              if (!exact) continue;
              const accepted = rangeAt(match.index, exact[0].length);
              if (!accepted) continue;
              form = candidate;
              length = exact[0].length;
              range = accepted;
              break;
            }
          }
          if (!range) {
            matcher.pattern.lastIndex = advance(match.index);
            continue;
          }
          matcher.pattern.lastIndex = match.index + length;
          if (seen.has(form.entry)) continue;
          place(form.entry, range.start, range.finish);
          if (seen.size === matcher.count) break;
        }
        if (!replacements.length) continue;
        if (end < node.value.length) replacements.push({ type: "text", value: node.value.slice(end) });
        frame.parent.children.splice(frame.index - 1, 1, ...replacements);
        frame.index += replacements.length - 1;
      }
    }
  };
}
