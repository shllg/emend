import { lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { inside } from "./read.ts";
import { statWorktree } from "./worktree.ts";

type FolderState = "directory" | "absent" | "blocked";

/** Collection-only metadata: content reads must keep their fresh per-file checks. */
export function collectionStat(root: string, gitDirs: string[], fs = { lstat, realpath }) {
  const folders = new Map<string, Promise<FolderState>>();
  const folderState = (folder: string): Promise<FolderState> => {
    if (folder === root) return Promise.resolve("directory");
    if (!inside(root, folder)) return Promise.resolve("blocked");
    const cached = folders.get(folder);
    if (cached) return cached;
    const pending = (async (): Promise<FolderState> => {
      const parent = await folderState(dirname(folder));
      if (parent !== "directory") return parent;
      try {
        return (await fs.lstat(folder)).isDirectory() ? "directory" : "blocked";
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return "absent";
        throw error;
      }
    })();
    // Cache the promise too, so concurrent siblings share the same in-flight check.
    folders.set(folder, pending);
    return pending;
  };
  const leadingFolders = async (_root: string, file: string) =>
    inside(root, file) && (await folderState(dirname(file))) === "directory";
  const metadata = { ...fs, leadingFolders };
  return {
    stat: (path: string) => statWorktree(root, path, gitDirs, metadata),
    leadingFolders: (file: string) => leadingFolders(root, file),
  };
}
