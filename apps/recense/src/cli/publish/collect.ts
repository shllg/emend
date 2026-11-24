import { createHash } from "node:crypto";
import { readlink } from "node:fs/promises";
import { join } from "node:path";
import { FilePath, LIMITS } from "@recense/contract";
import { escapeReference } from "../escape.ts";
import { createGitSession, GitFailed, type GitRunner } from "../git.ts";
import { CliError } from "../http.ts";
import { collectionStat } from "./collect-stat.ts";
import type { ChangedPath } from "./sides.ts";
import { hashWorktreeFile, statWorktree } from "./worktree.ts";

export function decodePath(bytes: Buffer): string {
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CliError(`invalid path: ${Array.from(bytes, (b) => `\\x${b.toString(16).padStart(2, "0")}`).join("")}`);
  }
  if (!Buffer.from(path, "utf8").equals(bytes) || !FilePath.safeParse(path).success)
    throw new CliError(`invalid path: ${escapeReference(path)}`);
  return path;
}
function split(bytes: Buffer) {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0) throw new CliError("invalid git path listing");
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++)
    if (bytes[i] === 0) {
      parts.push(bytes.subarray(start, i));
      start = i + 1;
    }
  return parts;
}
export async function collectChanges(
  root: string,
  base: string,
  head: string,
  run: GitRunner = createGitSession(),
  warn = (line: string) => {
    process.stderr.write(line);
  },
  gitDirs = [join(root, ".git")],
  fs?: Parameters<typeof collectionStat>[2],
): Promise<ChangedPath[]> {
  if (head === "worktree") return collectWorktree(root, base, run, warn, gitDirs, fs);
  const bytes = await run(root, ["diff-tree", "-r", "-z", "--raw", "-M", base, head]);
  const parts = split(bytes);
  const files: ChangedPath[] = [];
  for (let index = 0; index < parts.length; index++) {
    const raw = parts[index]?.toString("ascii") ?? "";
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([AMDT]|R\d+)$/.exec(raw);
    const first = parts[++index];
    if (!match || !first) throw new CliError("invalid git path listing");
    const [, oldMode, newMode, oldOid, newOid, status] = match;
    const oldPath = status?.startsWith("R") ? decodePath(first) : null;
    const pathBytes = oldPath ? parts[++index] : first;
    if (!pathBytes) throw new CliError("invalid git path listing");
    files.push({
      path: decodePath(pathBytes),
      oldPath,
      oldMode,
      newMode,
      oldOid,
      newOid,
      status: oldPath
        ? "renamed"
        : status === "A"
          ? "added"
          : status === "D"
            ? "deleted"
            : oldOid === newOid && oldMode !== newMode
              ? "mode-changed"
              : "modified",
    });
  }
  return bounded(files);
}

type Entry = { mode: string; oid?: string; size?: number; fromIndex?: boolean; oversized?: boolean };
type IndexEntry = Entry & { oid: string; skip: boolean; stage: number };
function recordParts(record: Buffer) {
  const tab = record.indexOf(9);
  if (tab < 0) throw new CliError("invalid git path listing");
  return { metadata: record.subarray(0, tab).toString("utf8"), path: decodePath(record.subarray(tab + 1)) };
}
function treeEntries(bytes: Buffer) {
  const entries = new Map<string, Entry>();
  for (const record of split(bytes)) {
    const { metadata, path } = recordParts(record);
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64}) +([0-9]+|-|BAD)$/.exec(
      metadata,
    );
    if (!match) throw new CliError("invalid git path listing");
    const [, mode, type, oid, rawSize] = match;
    if (!mode || !oid || (mode === "160000") !== (type === "commit")) throw new CliError("invalid git path listing");
    // Missing promisor blobs can have size BAD. Never fetch them: compare the disk
    // hash, then let an object-id read fail if this revision needs the missing side.
    const size = rawSize === "-" || rawSize === "BAD" ? undefined : Number(rawSize);
    if (size !== undefined && !Number.isSafeInteger(size)) throw new CliError("invalid git object size");
    entries.set(path, { mode, oid, size });
  }
  return entries;
}
function indexEntries(bytes: Buffer) {
  const entries = new Map<string, IndexEntry>();
  for (const record of split(bytes)) {
    const { metadata, path } = recordParts(record);
    const match = /^([HSM]) (100644|100755|120000|160000) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])$/.exec(metadata);
    if (!match) throw new CliError("invalid git path listing");
    const [, tag, mode, oid, stage] = match;
    if (!mode || !oid) throw new CliError("invalid git path listing");
    // Count conflicts once. Prefer ours for the exec bit when fileMode is false;
    // ordinary files still get their content from the disk resolution.
    if (!entries.has(path) || stage === "0" || stage === "2")
      entries.set(path, { mode, oid, stage: Number(stage), skip: tag === "S", fromIndex: true });
  }
  return entries;
}
function hasGitlinkParent(path: string, index: Map<string, IndexEntry>) {
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1))
    if (index.get(path.slice(0, slash))?.mode === "160000") return true;
  return false;
}
async function collectWorktree(
  root: string,
  base: string,
  run: GitRunner,
  warn: (line: string) => void,
  gitDirs: string[],
  fs?: Parameters<typeof collectionStat>[2],
) {
  const before = treeEntries(await run(root, ["ls-tree", "-r", "-l", "-z", "--full-tree", base]));
  const index = indexEntries(await run(root, ["ls-files", "-z", "-t", "--stage"]));
  const paths = new Set([...before.keys(), ...index.keys()]);
  const format = (await run(root, ["rev-parse", "--show-object-format"])).toString().trim();
  if (format !== "sha1" && format !== "sha256") throw new CliError("unsupported git object format");
  let fileMode = true;
  try {
    fileMode = (await run(root, ["config", "--bool", "--get", "core.filemode"])).toString().trim() !== "false";
  } catch (error) {
    if (!(error instanceof GitFailed) || error.exitCode !== 1) throw error;
  }
  for (const entry of split(await run(root, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
    if (entry.at(-1) === 47) {
      const path = decodePath(entry.subarray(0, -1));
      warn(`recense: skipped ${escapeReference(path)}/: nested repository\n`);
      continue;
    }
    paths.add(decodePath(entry));
  }
  const metadata = collectionStat(root, gitDirs, fs);
  const inspect = async (path: string): Promise<ChangedPath | undefined> => {
    const old = before.get(path);
    const staged = index.get(path);
    let next: Entry | undefined;
    if (staged?.mode === "160000") {
      // Only staged gitlink bumps count. Never inspect the nested worktree or .git.
      next = staged;
    } else if (!(old?.mode === "160000" && !staged) && !hasGitlinkParent(path, index)) {
      const info = await metadata.stat(path);
      if (!info) {
        if (staged?.skip && (await metadata.leadingFolders(join(root, path)))) next = staged;
      } else if (info.isSymbolicLink()) {
        // Reading link text also needs fresh parents; the collection cache is not a read guard.
        if (!(await statWorktree(root, path, gitDirs))?.isSymbolicLink())
          throw new CliError("file changed while reading");
        const bytes = await readlink(join(root, path), { encoding: "buffer" });
        next = { mode: "120000", oid: createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex") };
      } else if (info.isFile()) {
        const executable = !fileMode && staged ? staged.mode === "100755" : Boolean(info.mode & 0o100);
        const sizeChanged = old?.mode.startsWith("100") && old.size !== undefined && old.size !== info.size;
        const oversized = info.size > LIMITS.diffSideBytes && !(old?.mode.startsWith("100") && old.size === info.size);
        next = {
          mode: executable ? "100755" : "100644",
          oid:
            sizeChanged || oversized ? undefined : await hashWorktreeFile(root, path, info, format, undefined, gitDirs),
          oversized,
        };
      } else if (!info.isDirectory()) {
        throw new CliError("expected a regular file");
      }
    }
    if (!old && !next) return;
    const sameOid = old?.oid !== undefined && old.oid === next?.oid;
    if (sameOid && old?.mode === next?.mode) return;
    return {
      path,
      oldPath: null,
      oldOid: old?.oid,
      oldMode: old?.mode,
      newOid: next?.oid,
      newMode: next?.mode,
      newFromIndex: next?.fromIndex,
      newOversized: next?.oversized,
      status: !old ? "added" : !next ? "deleted" : sameOid ? "mode-changed" : "modified",
    };
  };
  const changed: ChangedPath[] = [];
  const ordered = [...paths];
  for (let start = 0; start < ordered.length; start += 64) {
    const batch = await Promise.allSettled(ordered.slice(start, start + 64).map(inspect));
    // Drain each bounded batch, retaining listing order for errors and rename pairing.
    for (const result of batch) {
      if (result.status === "rejected") throw result.reason;
      if (result.value) changed.push(result.value);
    }
  }
  const deleted = new Map<string, ChangedPath[]>();
  for (const file of changed)
    if (file.status === "deleted" && file.oldOid) {
      const paths = deleted.get(file.oldOid) ?? [];
      paths.push(file);
      deleted.set(file.oldOid, paths);
    }
  const paired = new Set<ChangedPath>();
  for (const file of changed)
    if (file.status === "added" && file.newOid) {
      const old = deleted.get(file.newOid)?.shift();
      if (old) {
        file.oldPath = old.path;
        file.oldOid = old.oldOid;
        file.oldMode = old.oldMode;
        file.status = "renamed";
        paired.add(old);
      }
    }
  return bounded(changed.filter((file) => !paired.has(file)));
}
function bounded(files: ChangedPath[]) {
  if (files.length > LIMITS.filesPerRevision) throw new CliError("too many changed files");
  return files;
}
