import type { RevisionView, ThreadView } from "@emend/contract";
import type { ReviewSearch } from "../router.tsx";

type Doc = RevisionView["docs"][number];
export const docKey = (doc: Doc) => `${doc.kind}:${doc.path}`;

export function threadOnDoc(thread: ThreadView, doc: Doc) {
  const location = thread.placement.status === "placed" ? thread.placement.location : thread.target;
  if (!("path" in location) || location.path !== doc.path) return false;
  switch (location.kind) {
    case "source-lines":
      return doc.kind === "source";
    case "doc-span":
      return doc.kind === "markdown";
    case "html-span":
      return doc.kind === "html";
    default:
      return false;
  }
}

/** Carry display modes between docs, but source belongs only to a source entry. */
export const docView = (doc?: Doc, view?: ReviewSearch["view"]): ReviewSearch["view"] =>
  doc?.kind === "source" ? "source" : view === "source" ? undefined : view;

export function findDoc(docs: Doc[], path?: string, view?: ReviewSearch["view"]) {
  return (
    docs.find((doc) => doc.path === path && (view === "source" ? doc.kind === "source" : doc.kind !== "source")) ??
    (view !== "source" ? docs.find((doc) => doc.path === path) : undefined)
  );
}
