import { normalizeGlossaryForm } from "@emend/contract";
import { type HtmlElement, type HtmlRoot, renderData } from "./blocks.ts";

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
    const matcher = file.data.terms as TermMatcher | undefined;
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
          renderData(node).emendMedia !== undefined ||
          renderData(node).emendDiagram !== undefined ||
          (Array.isArray(node.properties.className) && node.properties.className.includes("emend-term"))
        )
          continue;
        stack.push({ parent: node, index: 0 });
      } else if (node.type === "text") {
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
        // The same matcher carries the remaining work across every writeup section.
        if (!charge(matcher, view.length * matcher.weight)) return;
        const edges = neighbours.get(node);
        const rangeAt = (index: number, length: number) => {
          const start = offsets?.get(index);
          const finish = offsets?.get(index + length);
          if (
            start === undefined ||
            finish === undefined ||
            (start === 0 && edges?.before) ||
            (finish === node.value.length && edges?.after)
          )
            return;
          return { start, finish };
        };
        const advance = (index: number) => index + ((view.codePointAt(index) ?? 0) > 0xffff ? 2 : 1);
        const replacements: HtmlElement["children"] = [];
        let end = 0;
        matcher.pattern.lastIndex = 0;
        for (let match = matcher.pattern.exec(view); match; match = matcher.pattern.exec(view)) {
          if (!charge(matcher, matcher.forms.length)) return;
          let form = matcher.forms[match.findIndex((value, index) => index > 0 && value !== undefined) - 1];
          let length = match[0].length;
          if (!form) continue;
          // Unchanged NFC nodes need segmentation only once a candidate exists.
          if (!offsets) {
            segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
            offsets = new Map();
            for (const { index } of segmenter.segment(node.value)) offsets.set(index, index);
            offsets.set(view.length, node.value.length);
          }
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
          const { start, finish } = range;
          if (start > end) replacements.push({ type: "text", value: node.value.slice(end, start) });
          replacements.push({
            type: "element",
            tagName: "span",
            properties: { className: ["emend-term"], dataEmendTerm: String(form.entry) },
            children: [{ type: "text", value: node.value.slice(start, finish) }],
          });
          end = finish;
          seen.add(form.entry);
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
