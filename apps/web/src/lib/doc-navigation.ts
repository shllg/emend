import type { DocHeading, RenderedBlock, RevisionView } from "@emend/contract";

export type HeadingDoc = {
  path: string;
  headings?: readonly DocHeading[];
  blocks?: readonly Pick<RenderedBlock, "id" | "kind">[];
};
export const appElementId = (id: string) => /^(?:block-|thread-|diff-|topic-|doc-|html-doc-).+/.test(id);
export const docTitle = (doc: RevisionView["docs"][number]) => doc.title || doc.path.split("/").at(-1) || doc.path;

export function docFilename(doc: RevisionView["docs"][number], docs: RevisionView["docs"]) {
  const filename = doc.path.split("/").at(-1);
  const peers = docs.filter(
    (other) =>
      other.path !== doc.path && (docTitle(other) === docTitle(doc) || other.path.split("/").at(-1) === filename),
  );
  const parts = doc.path.split("/");
  for (let count = 1; count < parts.length; count++) {
    const suffix = parts.slice(-count).join("/");
    if (peers.every((other) => other.path.split("/").slice(-count).join("/") !== suffix)) return suffix;
  }
  return doc.path;
}

export function docContainer(root: ParentNode, path: string): HTMLElement | undefined {
  const scroller =
    (root instanceof HTMLElement ? root.closest<HTMLElement>("[data-reading-scroll]") : null) ??
    root.querySelector<HTMLElement>("[data-reading-scroll]");
  return Array.from(scroller?.querySelectorAll<HTMLElement>("[data-reading-doc]") ?? []).find(
    (element) => element.dataset.readingDoc === path,
  );
}

/** Only direct heading elements of the doc's own heading blocks are navigation targets. */
function ownHeadings(root: ParentNode, doc: HeadingDoc): HTMLElement[] {
  const blocks = new Set(doc.blocks?.filter((block) => block.kind === "heading").map((block) => block.id));
  return Array.from(docContainer(root, doc.path)?.querySelectorAll<HTMLElement>("h2, h3") ?? []).filter((element) => {
    const block = element.parentElement;
    return (
      block?.tagName === "DIV" &&
      block.dataset.blockKind === "heading" &&
      blocks.has(block.dataset.blockId ?? "") &&
      block.id === `block-${block.dataset.blockId}` &&
      !block.closest('.em-comment-html, [id^="thread-"], form')
    );
  });
}

/** Never interpret a declared heading as an app id or interpolate it into a selector. */
export function docHeading(root: ParentNode, doc: HeadingDoc, id: string): HTMLElement | undefined {
  const heading = doc.headings?.find((heading) => heading.id === id);
  if (!heading) return;
  return ownHeadings(root, doc).find(
    (element) => element.id === id && element.tagName.toLowerCase() === `h${heading.level}`,
  );
}

/** One scoped scan for Contents, even when the rendered doc has more headings than its metadata cap. */
export function findDocHeadings(root: ParentNode, doc: HeadingDoc): Map<string, HTMLElement> {
  const declared = new Map(
    doc.headings?.flatMap((heading) => (heading.id ? [[heading.id, heading.level] as const] : [])),
  );
  const found = new Map<string, HTMLElement>();
  for (const element of ownHeadings(root, doc)) {
    if (!found.has(element.id) && element.tagName.toLowerCase() === `h${declared.get(element.id)}`)
      found.set(element.id, element);
  }
  return found;
}
