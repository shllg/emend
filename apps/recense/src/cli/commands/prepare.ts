import { createHash } from "node:crypto";
import { constants, lstatSync, type Stats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, join, resolve } from "node:path";
import { docViewOf, isRenderedHtmlDoc, LIMITS, type PreparedFile, PublishManifest } from "@recense/contract";
import { cleanDocTitle, isLockfile } from "@recense/core";
import type { Io } from "../../main.ts";
import { createDiffCountBudget, type DiffCountBudget } from "../../server/publish/counts.ts";
import { type WorkerExecutor, workerExecutor } from "../../server/publish/executor.ts";
import { readDocRoots } from "../config.ts";
import { escapeJson, escapeReference } from "../escape.ts";
import { GitFailed, type GitRunner } from "../git.ts";
import { CliError, CliUsageError, printJson } from "../http.ts";
import { collectChanges } from "../publish/collect.ts";
import { inside, OversizedFile } from "../publish/read.ts";
import { publishContext, resolvePublish, shortenRepoName } from "../publish/resolve.ts";
import { worktreeRoot } from "../publish/root.ts";
import { type ChangedPath, readSide } from "../publish/sides.ts";
import { readBlob } from "../publish/upload.ts";
import { hashWorktreeFile, statWorktree } from "../publish/worktree.ts";

const PREPARE_DOC_BUDGET_MS = 30_000;

function parseArgs(args: string[]) {
  const usage = new CliUsageError("usage: recense prepare --base <commit> --head <commit|worktree> --dir <folder>");
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !flag ||
      !["--base", "--head", "--dir"].includes(flag) ||
      options.has(flag) ||
      value === undefined ||
      value.startsWith("--")
    )
      throw usage;
    options.set(flag, value);
  }
  const base = options.get("--base");
  const head = options.get("--head");
  const dir = options.get("--dir");
  if (base === undefined || head === undefined || !dir) throw usage;
  if (!PublishManifest.shape.base.safeParse(base).success) throw new CliError("base must be a full commit hash");
  if (!PublishManifest.shape.head.safeParse(head).success)
    throw new CliError("head must be a full commit hash or worktree");
  return { base, head, dir };
}

const alreadyExists = (folder: string) =>
  new CliError(`review.json already exists in ${escapeReference(folder)}; nothing was written`);

function checkFolder(info: Stats | undefined, path: string) {
  const name = escapeReference(path);
  if (!info) throw new CliError(`review folder does not exist: ${name}`);
  if (!info.isDirectory()) throw new CliError(`expected a directory, not a symlink or file: ${name}`);
  if (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0))
    throw new CliError(`review folder must be owned by the current user and writable only by that user: ${name}`);
  return info;
}

const sameIdentity = (current: Stats | undefined, before: Stats) =>
  current?.dev === before.dev && current.ino === before.ino;

async function writeManifest(folder: string, before: Stats, json: string) {
  // On Linux a readable directory can be pinned for the exclusive create.
  const dir =
    process.platform === "linux" && (before.mode & 0o400) !== 0
      ? await open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      : null;
  try {
    const info = checkFolder(dir ? await dir.stat() : await lstat(folder), folder);
    const parent = dir ? `/proc/self/fd/${dir.fd}` : folder;
    if (!sameIdentity(info, before) || (await realpath(parent)) !== folder)
      throw new CliError("review folder changed before writing");
    const path = join(parent, "review.json");
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    ).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw alreadyExists(folder);
      throw error;
    });
    try {
      if (!dir) {
        const current = checkFolder(await lstat(folder), folder);
        if (
          !sameIdentity(current, before) ||
          !sameIdentity(await lstat(path), await file.stat()) ||
          (await realpath(folder)) !== folder
        )
          throw new CliError("review folder changed before writing");
      }
      if (process.getuid) await file.chmod(0o600);
      await file.writeFile(json);
    } catch (error) {
      if (sameIdentity(lstatSync(path, { throwIfNoEntry: false }), await file.stat())) await unlink(path);
      throw error;
    } finally {
      await file.close();
    }
  } finally {
    await dir?.close();
  }
}

async function checkCommit(root: string, git: GitRunner, name: "base" | "head", commit: string) {
  try {
    await git(root, ["diff-tree", "-r", "-z", "--raw", "-M", commit, commit]);
  } catch (error) {
    if (error instanceof GitFailed)
      throw new CliError(`${name} is not a commit in this clone: ${escapeReference(commit)}`);
    throw error;
  }
}

type PublishContext = Awaited<ReturnType<typeof publishContext>>;
type LineCounts = Pick<PreparedFile, "added" | "removed">;
type Counting = { worker: WorkerExecutor; outcomes: Map<string, LineCounts>; budget: DiffCountBudget };

const gitBlobId = (format: string, bytes: Buffer) =>
  createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

async function prepareDiff(
  { root, git, gitDirs }: PublishContext,
  head: string,
  change: ChangedPath,
  format: string,
  { worker, outcomes, budget }: Counting,
) {
  const prepared: PreparedFile = { status: change.status };
  if (change.oldPath) prepared.oldPath = change.oldPath;
  if (isLockfile(change.path)) prepared.lockfile = true;
  const start = performance.now();
  const old = await readSide(root, head, change, "old", git, gitDirs);
  const next = await readSide(root, head, change, "new", git, gitDirs);
  if (old && "flag" in old) prepared.flag = old.flag;
  else if (next && "flag" in next) prepared.flag = next.flag;
  else {
    // A disk side may have changed since collection, or have no collected object id.
    const newOid = next && head === "worktree" && !change.newFromIndex ? gitBlobId(format, next.bytes) : change.newOid;
    const key = `${old ? change.oldOid : ""}:${next ? newOid : ""}`;
    const cached = outcomes.get(key);
    if (cached) Object.assign(prepared, cached);
    else if (budget.spentMs < budget.limitMs) {
      const result = await worker({
        kind: "diff-counts",
        old: old ? Uint8Array.from(old.bytes).buffer : null,
        next: next ? Uint8Array.from(next.bytes).buffer : null,
      }).catch(() => null);
      budget.spentMs += performance.now() - start;
      const counts = result?.kind === "diff-counts" ? result.counts : null;
      const facts = counts ? { added: counts.additions, removed: counts.deletions } : {};
      outcomes.set(key, facts);
      Object.assign(prepared, facts);
    }
  }
  return prepared;
}

type DocBudget = {
  remainingMs: number;
  remainingRows: number;
  remainingBytes: number;
  remainingJsonBytes: number;
  assetPaths: Set<string>;
  blobHashes: Set<string>;
};

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const blobPlaceholder = "0".repeat(64);

function diffJsonBytes({ path, oldPath, status }: ChangedPath, flag: PreparedFile["flag"]) {
  return jsonBytes({
    path,
    oldPath,
    status,
    role: "diff",
    flag: flag ?? null,
    oldBlob: status === "added" ? null : blobPlaceholder,
    newBlob: status === "deleted" ? null : blobPlaceholder,
  });
}

function refusedDoc(reason: string) {
  const limit = LIMITS.errorMessageChars;
  return {
    doc: "refused" as const,
    docRefusal: reason.length > limit ? `${reason.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "")}…` : reason,
  };
}

async function prepareDoc(
  { root, git, gitDirs }: PublishContext,
  change: ChangedPath,
  range: { base: string; head: string; branch: string | null },
  format: "sha1" | "sha256",
  resolveDoc: (path: string) => ReturnType<typeof resolvePublish>,
  budget: DocBudget,
): Promise<Pick<PreparedFile, "doc" | "docRefusal">> {
  if (change.status === "deleted") return { doc: "deleted" };
  if (change.newMode !== "100644" && change.newMode !== "100755")
    return refusedDoc("the changed doc is not a regular file");
  if (budget.remainingRows < 1) return refusedDoc("too many files in the review");
  if (budget.remainingMs <= 0) return refusedDoc("not checked: prepare ran out of time for doc checks");
  const start = performance.now();
  try {
    if (change.newOid) {
      const info = await statWorktree(root, change.path, gitDirs);
      if (!info?.isFile()) return { doc: "differs-from-head" };
      const html = isRenderedHtmlDoc({ role: "doc", path: change.path });
      if (info.size > (html ? LIMITS.htmlDocBytes : LIMITS.markdownDocBytes)) throw new OversizedFile();
      if (range.head !== "worktree") {
        const size = Number((await git(root, ["cat-file", "-s", change.newOid])).toString().trim());
        if (size !== info.size) return { doc: "differs-from-head" };
      }
      const oid = await hashWorktreeFile(root, change.path, info, format, undefined, gitDirs);
      if (oid !== change.newOid) return { doc: "differs-from-head" };
    }
    const { request, blobs } = await resolveDoc(change.path);
    const doc = request.files.find((file) => file.role === "doc");
    if (!doc) throw new Error("missing resolved doc");
    if (change.newOid) {
      const hash = doc.newBlob;
      const source = hash && blobs.get(hash);
      if (!hash || !source) throw new Error("missing resolved doc blob");
      if (gitBlobId(format, await readBlob(hash, source)) !== change.newOid) return { doc: "differs-from-head" };
    }

    const assets = request.files.filter((file) => file.role === "asset" && !budget.assetPaths.has(file.path));
    const rows = 1 + assets.length;
    if (rows > budget.remainingRows) return refusedDoc("too many files in the review");
    let bytes = 0;
    for (const [hash, source] of blobs) if (!budget.blobHashes.has(hash)) bytes += source.size;
    if (bytes > budget.remainingBytes) return refusedDoc("the docs pass the revision size limit");
    // The resolver supplied a docs-only shell. Restore the range for this code review.
    const shellBytes = jsonBytes({ ...request, ...range, files: [] });
    const addedJsonBytes = assets.reduce((sum, asset) => sum + jsonBytes(asset), jsonBytes(doc)) + rows;
    if (shellBytes + addedJsonBytes > budget.remainingJsonBytes)
      return refusedDoc("publish request exceeds its size limit");

    budget.remainingRows -= rows;
    budget.remainingBytes -= bytes;
    budget.remainingJsonBytes -= addedJsonBytes;
    for (const file of assets) budget.assetPaths.add(file.path);
    for (const hash of blobs.keys()) budget.blobHashes.add(hash);
    return { doc: "included" };
  } catch (error) {
    if (error instanceof CliError) return refusedDoc(error.message);
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (typeof code === "string" && Object.hasOwn(osConstants.errno, code))
      return refusedDoc("the doc could not be read");
    return refusedDoc("the doc could not be checked");
  } finally {
    budget.remainingMs -= performance.now() - start;
  }
}

export async function prepareCommand(
  stateDir: string,
  configDir: string,
  args: string[],
  io: Io,
  cwd: string,
  limits: {
    countBudgetMs?: number;
    docBudgetMs?: number;
    filesPerRevision?: number;
    revisionBytes?: number;
    publishJsonBytes?: number;
  } = {},
) {
  const { base, head, dir } = parseArgs(args);
  const requested = resolve(cwd, dir);
  const info = checkFolder(lstatSync(requested, { throwIfNoEntry: false }), requested);
  const folder = await realpath(requested);
  const worktree = await worktreeRoot(cwd);
  if (!worktree) throw new CliError("not a git repository");
  if (inside(worktree, folder)) throw new CliError("review folder must be outside the worktree");
  const manifest = join(folder, "review.json");
  if (lstatSync(manifest, { throwIfNoEntry: false })) throw alreadyExists(folder);

  const context = await publishContext(cwd, stateDir);
  const { root, git, gitDirs } = context;
  if (context.worktree !== worktree) throw new CliError("worktree changed during prepare");
  if (gitDirs.some((gitDir) => inside(gitDir, folder)))
    throw new CliError("review folder must be outside the repository's git folders");
  await checkCommit(root, git, "base", base);
  if (head !== "worktree") await checkCommit(root, git, "head", head);
  const warnings: string[] = [];
  const warn = (line: string) => warnings.push(line);
  const changes = await collectChanges(root, base, head, git, warn, gitDirs);
  const configRoots = await readDocRoots(stateDir, configDir, cwd, warn);
  const format = (await git(root, ["rev-parse", "--show-object-format"])).toString().trim();
  if (format !== "sha1" && format !== "sha256") throw new CliError("unsupported git object format");
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toString().trim();
  const range = { base, head, branch: branch === "HEAD" ? null : branch };
  const title = shortenRepoName(cleanDocTitle(range.branch ?? basename(root))) || "Review";
  const counting: Counting = {
    worker: workerExecutor(),
    outcomes: new Map(),
    budget: createDiffCountBudget(limits.countBudgetMs),
  };
  const writeup = { overview: "", tldr: "", decisions: null, topics: {} };
  const resolveDoc = (path: string) =>
    resolvePublish(
      { version: 1, title, topics: [], files: [{ path, role: "doc" }], writeup },
      { manifest: "prepare", key: "prepare" },
      stateDir,
      configDir,
      null,
      cwd,
      () => {},
      context,
      configRoots,
      counting.worker,
    );
  const files: PublishManifest["files"] = [];
  const publishJsonBytes = limits.publishJsonBytes ?? LIMITS.publishJsonBytes;
  // The agent's eventual writeup, topics and notes share these publish caps.
  const docBudget: DocBudget = {
    remainingMs: limits.docBudgetMs ?? PREPARE_DOC_BUDGET_MS,
    remainingRows: (limits.filesPerRevision ?? LIMITS.filesPerRevision) - changes.length,
    remainingBytes: (limits.revisionBytes ?? LIMITS.revisionBytes) - publishJsonBytes,
    remainingJsonBytes: publishJsonBytes - Math.max(0, changes.length - 1),
    assetPaths: new Set(),
    blobHashes: new Set(),
  };
  try {
    const diffs = [];
    for (const change of changes) {
      const prepared = await prepareDiff(context, head, change, format, counting);
      docBudget.remainingJsonBytes -= diffJsonBytes(change, prepared.flag);
      diffs.push({ change, prepared });
    }
    for (const { change, prepared } of diffs) {
      files.push({ path: change.path, role: "diff", prepared });
      if (docViewOf({ path: change.path }) !== "rendered") continue;
      Object.assign(prepared, await prepareDoc(context, change, range, format, resolveDoc, docBudget));
      if (prepared.doc === "included") files.push({ path: change.path, role: "doc" });
    }
  } finally {
    await counting.worker.close();
  }
  const skeleton = PublishManifest.parse({
    version: 1,
    title,
    base,
    head,
    topics: [],
    files,
    writeup,
  });
  await writeManifest(folder, info, `${escapeJson(JSON.stringify(skeleton, null, 2), "manifest")}\n`);
  await printJson(io, { manifest, diff: changes.length, doc: files.length - changes.length });
  for (const warning of warnings) io.stderr(warning);
}
