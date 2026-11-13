import type { RevisionView } from "@emend/contract";

function baseDoc(revision: RevisionView) {
  // The server builds docs in file order (ord, id), including both views of a path.
  return revision.writeupEmpty && revision.base === null
    ? (revision.docs.find((doc) => doc.path === revision.main) ?? revision.docs[0])
    : undefined;
}

export function downloadDocChoices(
  revision: RevisionView,
): { id: string; path: string; label: string; title?: string; description?: string }[] {
  const base = baseDoc(revision);
  const key = (path: string, source: boolean) => `${source ? "source" : "rendered"}:${path}`;
  const files = new Map(
    revision.files
      .filter((file) => file.role === "doc")
      .map((file) => [key(file.path, file.view === "source"), file.id]),
  );
  return revision.docs.flatMap((doc) => {
    const id = files.get(key(doc.path, doc.kind === "source"));
    return doc === base || !id
      ? []
      : [
          {
            id,
            path: doc.path,
            label: doc.title ?? doc.path,
            title: doc.title,
            description: doc.kind === "source" ? `${doc.path} · source` : doc.title ? doc.path : undefined,
          },
        ];
  });
}

export function downloadBaseLabel(revision: RevisionView): string {
  const doc = baseDoc(revision);
  return doc ? (doc.title ?? doc.path) : "The writeup";
}
