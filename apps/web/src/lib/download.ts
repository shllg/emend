import type { RevisionView } from "@emend/contract";

function baseDoc(revision: RevisionView) {
  return revision.writeupEmpty && revision.base === null
    ? (revision.docs.find((doc) => doc.path === revision.main) ?? revision.docs[0])
    : undefined;
}

export function downloadDocChoices(
  revision: RevisionView,
): { id: string; path: string; label: string; title?: string }[] {
  const base = baseDoc(revision);
  const files = new Map(revision.files.filter((file) => file.role === "doc").map((file) => [file.path, file.id]));
  return revision.docs.flatMap((doc) => {
    const id = files.get(doc.path);
    return doc === base || !id ? [] : [{ id, path: doc.path, label: doc.title ?? doc.path, title: doc.title }];
  });
}

export function downloadBaseLabel(revision: RevisionView): string {
  const doc = baseDoc(revision);
  return doc ? (doc.title ?? doc.path) : "The writeup";
}
