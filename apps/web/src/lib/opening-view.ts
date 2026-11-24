import type { FilePath, RevisionView } from "@recense/contract";

export function openingView(revision: RevisionView): { tab: "writeup" | "diff" | "docs"; doc?: FilePath } {
  if (revision.main === "writeup") return { tab: "writeup" };
  const main = revision.docs.find((doc) => doc.path === revision.main);
  if (main) return { tab: "docs", doc: main.path };
  if (!revision.writeupEmpty) return { tab: "writeup" };
  const first = revision.docs[0];
  if (first) return { tab: "docs", doc: first.path };
  if (revision.files.some((file) => file.role === "diff")) return { tab: "diff" };
  return { tab: "writeup" };
}
