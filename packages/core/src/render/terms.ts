import { type HtmlElement, type HtmlRoot, renderData } from "./blocks.ts";

// Match whole words within one text node (letters, marks, digits and _ are word characters).
// Forms and the matching view use NFC; marks keep the source text. Spaces match whitespace runs.
// Case is ignored except for acronyms (no lowercase and at least two uppercase letters). Allow trailing s/es, and
// prefer the longest form at a position. Other inflections belong in aliases.
export const normalizeTerm = (text: string) => text.normalize("NFC").replace(/\s+/gu, " ").trim();
const escapePattern = (text: string) => text.replace(/[\^$\\.*+?()[\]{}|/]/g, "\\$&");
const boundary = "[\\p{L}\\p{M}\\p{N}_]";
const skipped = new Set(["a", "code", "pre", "kbd", "samp", "h1", "h2", "h3", "h4", "h5", "h6"]);

export function termMatcher(entries: { term: string; aliases?: string[] }[]) {
  const forms = entries
    .flatMap((entry, index) =>
      [entry.term, ...(entry.aliases ?? [])].map((form) => ({
        form: normalizeTerm(form),
        entry: index,
      })),
    )
    .filter(({ form }) => form.length > 0)
    .sort((a, b) => b.form.length - a.form.length)
    .map(({ form, entry }) => {
      const source = `${form.split(" ").map(escapePattern).join("\\s+")}(?:es|s)?(?!${boundary})`;
      const acronym = !/\p{Ll}/u.test(form) && (form.match(/\p{Lu}/gu)?.length ?? 0) >= 2;
      return { entry, source, acronym, at: new RegExp(source, acronym ? "uy" : "iuy") };
    });
  return {
    count: entries.length,
    forms,
    pattern: new RegExp(`(?<!${boundary})(?:${forms.map(({ source }) => `(${source})`).join("|")})`, "giu"),
  };
}
export type TermMatcher = ReturnType<typeof termMatcher>;

export function markTerms() {
  return (tree: HtmlRoot, file: { data: Record<string, unknown> }) => {
    const matcher = file.data.terms as TermMatcher | undefined;
    if (!matcher?.forms.length) return;
    let segmenter: Intl.Segmenter | undefined;
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
        const advance = (index: number) => index + ((view.codePointAt(index) ?? 0) > 0xffff ? 2 : 1);
        const replacements: HtmlElement["children"] = [];
        let end = 0;
        matcher.pattern.lastIndex = 0;
        for (let match = matcher.pattern.exec(view); match; match = matcher.pattern.exec(view)) {
          let form = matcher.forms[match.findIndex((value, index) => index > 0 && value !== undefined) - 1];
          let length = match[0].length;
          if (!form) continue;
          if (form.acronym) {
            // An insensitive alternation can find a wrong-case acronym. Try the forms at
            // that same position again so a shorter, valid form still gets its turn.
            const candidate = matcher.forms.find((candidate) => {
              candidate.at.lastIndex = match.index;
              const exact = candidate.at.exec(view);
              if (!exact) return false;
              length = exact[0].length;
              return true;
            });
            if (!candidate) {
              matcher.pattern.lastIndex = advance(match.index);
              continue;
            }
            form = candidate;
            matcher.pattern.lastIndex = match.index + length;
          }
          const start = offsets ? offsets.get(match.index) : match.index;
          const finish = offsets ? offsets.get(match.index + length) : match.index + length;
          if (start === undefined || finish === undefined) {
            matcher.pattern.lastIndex = advance(match.index);
            continue;
          }
          if (seen.has(form.entry)) continue;
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
