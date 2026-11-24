import { readlink } from "node:fs/promises";
import { join } from "node:path";
import { type FileFlag, LIMITS } from "@recense/contract";
import type { ChangedPath as PathChange } from "@recense/core";
import { createGitSession, type GitRunner } from "../git.ts";
import { CliError } from "../http.ts";
import { OversizedFile, readRegular } from "./read.ts";
import { statWorktree } from "./worktree.ts";

export type ChangedPath = PathChange & {
  oldOid?: string;
  newOid?: string;
  oldMode?: string;
  newMode?: string;
  newFromIndex?: boolean;
  newOversized?: boolean;
};
export type Side = { bytes: Buffer } | { flag: FileFlag } | null;
export async function readWorktree(
  root: string,
  path: string,
  gitDirs = [join(root, ".git")],
): Promise<{ bytes: Buffer; mode: string } | null> {
  const file = join(root, path);
  const info = await statWorktree(root, path, gitDirs);
  if (!info) return null;
  if (info.size > LIMITS.diffSideBytes) throw new OversizedFile();
  if (info.isSymbolicLink()) return { bytes: await readlink(file, { encoding: "buffer" }), mode: "120000" };
  return {
    bytes: await readRegular(file, LIMITS.diffSideBytes, [root], undefined, gitDirs),
    mode: info.mode & 0o100 ? "100755" : "100644",
  };
}
const classify = (bytes: Buffer): Side => (bytes.subarray(0, 8000).includes(0) ? { flag: "binary" } : { bytes });
export async function readSide(
  root: string,
  head: string,
  change: ChangedPath,
  side: "old" | "new",
  run: GitRunner,
  gitDirs = [join(root, ".git")],
): Promise<Side> {
  if ((side === "old" && change.status === "added") || (side === "new" && change.status === "deleted")) return null;
  const oid = side === "old" ? change.oldOid : change.newOid;
  const mode = side === "old" ? change.oldMode : change.newMode;
  if (mode === "160000") {
    if (!oid || /^0+$/.test(oid)) throw new CliError("could not identify submodule commit");
    return { bytes: Buffer.from(`Subproject commit ${oid}\n`) };
  }
  if (side === "new" && head === "worktree" && !change.newFromIndex) {
    if (change.newOversized) return { flag: "oversized" };
    try {
      const value = await readWorktree(root, change.path, gitDirs);
      return value ? classify(value.bytes) : null;
    } catch (error) {
      if (error instanceof OversizedFile) return { flag: "oversized" };
      throw error;
    }
  }
  if (!oid) throw new CliError("missing git object id");
  const size = Number((await run(root, ["cat-file", "-s", oid])).toString().trim());
  if (!Number.isSafeInteger(size) || size < 0) throw new CliError("invalid git object size");
  if (size > LIMITS.diffSideBytes) return { flag: "oversized" };
  const bytes = await run(root, ["cat-file", "blob", oid]);
  if (bytes.length !== size) throw new CliError("git object size changed");
  return classify(bytes);
}
export async function readSides(
  root: string,
  _base: string,
  head: string,
  change: ChangedPath,
  run = createGitSession(),
): Promise<{ old: Side; new: Side }> {
  return { old: await readSide(root, head, change, "old", run), new: await readSide(root, head, change, "new", run) };
}
