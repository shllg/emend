import type { FileView } from "@emend/contract";

/** The deepest folder shared by every changed file in this revision. */
export function sharedDiffFolder(files: Pick<FileView, "path" | "role">[]): string | undefined {
  const folders = files.filter((file) => file.role === "diff").map((file) => file.path.split("/").slice(0, -1));
  let common = folders[0] ?? [];
  for (const folder of folders.slice(1)) {
    const mismatch = common.findIndex((segment, index) => segment !== folder[index]);
    if (mismatch !== -1) common = common.slice(0, mismatch);
    if (!common.length) break;
  }
  return common.length ? common.join("/") : undefined;
}
