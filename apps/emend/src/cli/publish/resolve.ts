import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, posix, resolve, sep } from "node:path";
import {
  docViewOf,
  isRenderedHtmlDoc,
  LIMITS,
  MEDIA_EXTENSIONS,
  OTHER_TOPIC,
  type PublishFile,
  type PublishManifest,
  PublishRequest,
} from "@emend/contract";
import { decodeText, UnchangedFilesError, withOtherChanges } from "@emend/core";
import { DocRootError, readDocRoots, rootRules, validateDocRoot } from "../config.ts";
import { escapeReference } from "../escape.ts";
import { createGitSession, GitFailed } from "../git.ts";
import { CliError } from "../http.ts";
import { collectAssets } from "./assets.ts";
import { collectChanges } from "./collect.ts";
import { docsKey, normalizeRemote, projectKey, reviewKey } from "./key.ts";
import {
  checkPublishedFolders,
  NotRegularFile,
  OversizedFile,
  outsideGitSegments,
  type PublishedFolder,
  readRegular,
  sourcePath,
} from "./read.ts";
import { remoteToRepoUrl } from "./repo-url.ts";
import type { RetainedSources } from "./retained.ts";
import { gitFolders, worktreeRoot } from "./root.ts";
import { ShortcutAssets } from "./shortcut-assets.ts";
import { readSkipReason } from "./shortcut-walk.ts";
import { readSide } from "./sides.ts";

import { type BlobSource, readBlob } from "./upload.ts";

export type PublishOptions = {
  manifest?: string;
  review?: string;
  project?: string;
  key?: string | ((instanceId: string) => string);
  skipNodeModules?: boolean;
  titleFromMain?: (bytes: Uint8Array) => string | Promise<string>;
  docFolders?: ReadonlyMap<string, readonly PublishedFolder[]>;
  /** Absolute paths rejected by the walked-doc private-key content check. */
  excludedAssets?: ReadonlySet<string>;
  retainedSources?: RetainedSources;
  /** Real paths of shortcut folder arguments and explicitly named files. */
  folderRoots?: readonly string[];
  namedFiles?: ReadonlySet<string>;
  docArguments?: ReadonlyMap<string, string>;
};
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function shortenRepoName(name: string): string {
  let end = LIMITS.titleChars;
  const before = name.charCodeAt(end - 1);
  const after = name.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
  return name.slice(0, end);
}
export async function publishContext(cwd: string, stateDir: string) {
  const git = createGitSession();
  const worktree = await worktreeRoot(cwd);
  if (worktree) {
    try {
      await validateDocRoot(worktree, homedir(), stateDir);
    } catch (error) {
      if (error instanceof DocRootError)
        throw new CliError(
          `the repository at ${escapeReference(worktree)} ${rootRules[error.reason].publish}, so emend does not publish from it`,
        );
      throw error;
    }
    const configured = await realpath(
      (await git(cwd, ["rev-parse", "--show-toplevel"])).toString().replace(/\r?\n$/, ""),
    );
    if (configured !== worktree) throw new CliError("the repository's worktree is configured elsewhere");
  }
  const root = worktree ?? (await realpath(cwd));
  const gitDirs = worktree ? await gitFolders(worktree, git) : [];
  return { git, worktree, root, gitDirs };
}
export async function resolvePublish(
  manifest: PublishManifest,
  options: PublishOptions,
  stateDir: string,
  configDir: string,
  instanceId: string | null,
  cwd: string,
  warn: (line: string) => void,
  context?: Awaited<ReturnType<typeof publishContext>>,
  configRoots?: readonly string[],
) {
  const { git, worktree, root, gitDirs } = context ?? (await publishContext(cwd, stateDir));
  const code = manifest.base !== undefined;
  if (code && !worktree) throw new CliError("not a git repository");
  const branchName = code ? (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toString().trim() : "HEAD";
  const branch = branchName === "HEAD" ? null : branchName;
  if ((!code || !branch) && !options.review && !options.key) throw new CliError("pass --review or --key");
  let repo: PublishRequest["repo"] = options.project
    ? { key: projectKey(options.project), name: options.project }
    : null;
  let repoUrl: string | undefined;
  if (worktree && (!options.project || code)) {
    let remote: string;
    try {
      remote = (await git(root, ["config", "--get", "remote.origin.url"])).toString().trim();
    } catch (error) {
      if (error instanceof GitFailed && error.exitCode === 1) remote = "";
      else throw error;
    }
    if (!options.project) {
      let identity = gitDirs.at(-1) ?? root;
      if (remote) {
        try {
          identity = normalizeRemote(remote);
        } catch (error) {
          if (!code && error instanceof CliError && error.message === "invalid origin URL") remote = "";
          else throw error;
        }
      }
      const name = remote
        ? basename(identity)
        : gitDirs.length === 1
          ? basename(root)
          : basename(identity) === ".git"
            ? basename(dirname(identity))
            : basename(identity).replace(/\.git$/, "");
      repo = { key: sha256(identity), name: shortenRepoName(name || basename(root)) };
    }
    if (code) repoUrl = remote ? (remoteToRepoUrl(remote) ?? undefined) : undefined;
  }
  const changes = code ? await collectChanges(root, manifest.base ?? "", manifest.head ?? "", git, warn, gitDirs) : [];
  let grouped: ReturnType<typeof withOtherChanges>;
  try {
    grouped = withOtherChanges(changes, manifest.files);
  } catch (error) {
    if (error instanceof UnchangedFilesError)
      throw new CliError(
        `not changed in ${escapeReference(`${manifest.base}..${manifest.head}`)}: ${error.paths.map(escapeReference).join(", ")}`,
      );
    throw error;
  }
  const topics = [...manifest.topics];
  if (grouped.files.length > LIMITS.filesPerRevision) throw new CliError("too many files in the review");
  if (grouped.other.length)
    topics.push({ ...OTHER_TOPIC, importance: 100, summary: "Changed files not assigned to a declared topic." });
  const blobs = new Map<string, BlobSource>();
  const rechecks = new Map<string, BlobSource["read"][]>();
  let totalBytes = Buffer.byteLength(JSON.stringify(manifest.writeup));
  if (totalBytes > LIMITS.revisionBytes) throw new CliError("the docs pass the revision size limit");
  const add = (bytes: Buffer, read: BlobSource["read"]) => {
    const hash = sha256(bytes);
    if (!blobs.has(hash)) {
      if (totalBytes + bytes.length > LIMITS.revisionBytes) return null;
      totalBytes += bytes.length;
      const size = bytes.length;
      if (options.docFolders) {
        // Shortcut deduplication retains every source's checks, including shared HTML assets.
        const checks: BlobSource["read"][] = [];
        rechecks.set(hash, checks);
        blobs.set(hash, {
          size,
          read: async () => {
            const content = await read();
            for (const check of checks) await readBlob(hash, { size, read: check });
            return content;
          },
        });
      } else blobs.set(hash, { size, read });
    } else rechecks.get(hash)?.push(read);
    return hash;
  };
  const addRequired = (bytes: Buffer, read: BlobSource["read"]) => {
    const hash = add(bytes, read);
    if (!hash) throw new CliError("the docs pass the revision size limit");
    return hash;
  };
  const ranks = new Map([...manifest.topics].sort((a, b) => a.importance - b.importance).map((t, i) => [t.slug, i]));
  grouped.files.sort((a, b) => {
    if (a.role === "doc" || b.role === "doc") return Number(b.role === "doc") - Number(a.role === "doc");
    return (ranks.get(a.topic ?? "") ?? ranks.size) - (ranks.get(b.topic ?? "") ?? ranks.size);
  });
  let files: PublishFile[] = [];
  let title = manifest.title;
  let assetCount = 0;
  const assetPaths = new Set<string>();
  const shortcutAssets = options.docFolders
    ? new ShortcutAssets(
        gitDirs,
        warn,
        options.excludedAssets,
        options.folderRoots,
        options.namedFiles,
        options.retainedSources,
      )
    : undefined;
  const roots = [
    ...(worktree ? [worktree] : []),
    ...(configRoots ?? (await readDocRoots(stateDir, configDir, cwd, warn))),
  ];
  for (const file of grouped.files) {
    if (file.role === "diff") {
      const change = changes.find((c) => c.path === file.path);
      if (!change || !manifest.base || !manifest.head) throw new CliError("diff files require base and head");
      const before = new Set(blobs.keys());
      const beforeBytes = totalBytes;
      const resolved: PublishFile = {
        path: change.path,
        oldPath: change.oldPath,
        status: change.status,
        role: "diff",
        topic: file.topic,
        notes: manifest.files.find((entry) => entry.role === "diff" && entry.path === file.path)?.notes,
        flag: null,
        oldBlob: null,
        newBlob: null,
      };
      for (const side of ["old", "new"] as const) {
        const head = manifest.head;
        const read = async () => {
          const value = await readSide(root, head, change, side, git, gitDirs);
          if (!value || !("bytes" in value)) throw new CliError("diff changed before upload");
          return value.bytes;
        };
        const value = await readSide(root, head, change, side, git, gitDirs);
        if (!value) continue;
        if ("flag" in value) {
          resolved.flag = value.flag;
          break;
        }
        const hash = add(value.bytes, read);
        if (!hash) {
          resolved.flag = "oversized";
          break;
        }
        resolved[side === "old" ? "oldBlob" : "newBlob"] = hash;
      }
      if (resolved.flag) {
        resolved.oldBlob = resolved.newBlob = null;
        for (const hash of blobs.keys()) if (!before.has(hash)) blobs.delete(hash);
        totalBytes = beforeBytes;
      }
      files.push(resolved);
      continue;
    }
    const original = resolve(root, file.source ?? file.path);
    const publishedFolders = options.docFolders?.get(file.path) ?? [];
    const argument = escapeReference(options.docArguments?.get(file.path) ?? file.source ?? file.path);
    const docError = (error: unknown): never => {
      if (
        error instanceof NotRegularFile ||
        ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
      )
        throw new CliError(`doc not found: ${argument}`);
      const reason = readSkipReason(error);
      if (reason) throw new CliError(`${error instanceof OversizedFile ? error.message : reason}: ${argument}`);
      throw error;
    };
    // Check the written alias here; sourcePath also checks its resolved target.
    outsideGitSegments(original, root);
    const sourceView = docViewOf(file) === "source";
    const walkedSource = sourceView && options.docFolders?.has(file.path) && !options.docArguments?.has(file.path);
    const retained = walkedSource ? options.retainedSources?.get(original) : undefined;
    if (walkedSource && !retained) throw new CliError("source changed before publish");
    const source = retained ? original : await sourcePath(original, roots, gitDirs, publishedFolders).catch(docError);
    const html = isRenderedHtmlDoc(file);
    const checkExtension = (path: string) => {
      if (sourceView) {
        if (extname(path).toLowerCase() !== extname(file.path).toLowerCase())
          throw new CliError("doc source must have the same extension as its path");
      } else if (docViewOf({ path }) !== "rendered" || isRenderedHtmlDoc({ role: "doc", path }) !== html)
        throw new CliError("doc source must end in .md, .markdown, .html or .htm, like its path.");
    };
    if (!sourceView) {
      if (file.source !== undefined) checkExtension(file.source);
      checkExtension(source);
    }
    const readResolvedDoc = (actual: string) =>
      readRegular(
        publishedFolders.length ? original : actual,
        html ? LIMITS.htmlDocBytes : LIMITS.markdownDocBytes,
        roots,
        undefined,
        gitDirs,
        (_info, opened) => checkPublishedFolders(opened, publishedFolders),
      ).catch(docError);
    const readDoc = async () => {
      if (retained) return retained;
      const actual = await sourcePath(original, roots, gitDirs, publishedFolders).catch(docError);
      checkExtension(actual);
      return readResolvedDoc(actual);
    };
    const bytes = retained ?? (await readResolvedDoc(source));
    if (sourceView) {
      try {
        decodeText(bytes);
      } catch {
        throw new CliError(`not a text file: ${argument}`);
      }
      if (file.source !== undefined) checkExtension(file.source);
      checkExtension(source);
    }
    if (file.path === manifest.main && options.titleFromMain) title = await options.titleFromMain(bytes);
    const resolvedDoc: PublishFile = {
      path: file.path,
      oldPath: null,
      role: "doc",
      topic: file.topic,
      title: file.title,
      ...(sourceView ? { view: "source" } : file.view ? { view: file.view } : {}),
      oldBlob: null,
      newBlob: addRequired(bytes, readDoc),
      flag: null,
      ...(html ? { assets: [] } : {}),
    };
    files.push(resolvedDoc);
    if (!html) continue;
    if (shortcutAssets) {
      // source is the checked real path, so aliases use the target folder for assets.
      // readResolvedDoc/readDoc enforce the HTML doc Git and published-folder rules here.
      shortcutAssets.add(resolvedDoc, source, bytes, publishedFolders);
      continue;
    }
    const assets = await collectAssets(
      source,
      warn,
      bytes.toString(),
      gitDirs,
      options.skipNodeModules,
      publishedFolders,
    );
    resolvedDoc.assets = assets.map((asset) => posix.join(posix.dirname(file.path), asset.ref));
    let size = bytes.length;
    for (const asset of assets) {
      const info = await stat(asset.file);
      if (info.size > LIMITS.assetBytes) throw new CliError("asset exceeds its size limit");
      size += info.size;
      if (size > LIMITS.htmlDocWithAssetsBytes) throw new CliError("HTML doc and assets exceed their size limit");
    }
    let actualSize = bytes.length;
    const readAsset = async (file: string, limit: number) => {
      const actual = await sourcePath(file, [dirname(source)], gitDirs, publishedFolders);
      if (options.skipNodeModules && actual.split(sep).includes("node_modules"))
        throw new CliError("asset target changed into node_modules");
      return readRegular(
        publishedFolders.length ? file : actual,
        limit,
        [dirname(source)],
        undefined,
        gitDirs,
        (_info, opened) => checkPublishedFolders(opened, publishedFolders),
      );
    };
    for (const asset of assets) {
      const path = posix.join(posix.dirname(file.path), asset.ref);
      if (assetPaths.has(path)) continue;
      assetPaths.add(path);
      if (grouped.files.length + ++assetCount > LIMITS.filesPerRevision)
        throw new CliError("too many files in the review");
      const content = await readAsset(
        asset.file,
        Math.min(LIMITS.assetBytes, LIMITS.htmlDocWithAssetsBytes - actualSize),
      );
      actualSize += content.length;
      const newBlob = addRequired(content, () => readAsset(asset.file, LIMITS.assetBytes));
      files.push({
        path,
        oldPath: null,
        role: "asset",
        parent: file.path,
        oldBlob: null,
        newBlob,
        flag: null,
      });
    }
  }
  if (shortcutAssets) {
    // HTML docs already passed their checked reads; this phase checks their shared assets.
    const assets = await shortcutAssets.resolve(files.length, addRequired);
    files = files.flatMap((file) => [file, ...(isRenderedHtmlDoc(file) ? (assets.get(file.path) ?? []) : [])]);
  }
  for (const item of manifest.media ?? []) {
    const label = escapeReference(item.source ?? item.path);
    const mediaError = (error: unknown): never => {
      if (error instanceof OversizedFile) throw new CliError("media exceeds its size limit");
      if (
        error instanceof NotRegularFile ||
        ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
      )
        throw new CliError(`media not found: ${label}`);
      throw error;
    };
    if (assetPaths.has(item.path))
      throw new CliError(`media path is already a doc asset: ${escapeReference(item.path)}`);
    if (grouped.files.length + assetCount + 1 > LIMITS.filesPerRevision)
      throw new CliError("too many files in the review");
    assetCount++;
    const extensionOf = (path: string) => path.split(".").at(-1)?.toLowerCase() ?? "";
    const original = resolve(root, item.source ?? item.path);
    // Check the written alias here; sourcePath also checks its resolved target.
    outsideGitSegments(original, root);
    const source = await sourcePath(original, roots, gitDirs, []).catch(mediaError);
    const wanted = extensionOf(item.path);
    if (
      !MEDIA_EXTENSIONS.has(wanted) ||
      extensionOf(item.source ?? item.path) !== wanted ||
      extensionOf(source) !== wanted
    )
      throw new CliError("media source must end in .png, .jpg, .jpeg, .gif, .webp or .avif, like its path.");
    const readMedia = async () => {
      const actual = await sourcePath(original, roots, gitDirs, []).catch(mediaError);
      if (extensionOf(actual) !== wanted)
        throw new CliError("media source must end in .png, .jpg, .jpeg, .gif, .webp or .avif, like its path.");
      return readRegular(actual, LIMITS.assetBytes, roots, undefined, gitDirs).catch(mediaError);
    };
    const bytes = await readRegular(source, LIMITS.assetBytes, roots, undefined, gitDirs).catch(mediaError);
    files.push({
      path: item.path,
      oldPath: null,
      role: "asset",
      oldBlob: null,
      newBlob: addRequired(bytes, readMedia),
      flag: null,
    });
  }
  const keyFor = (id: string) => {
    const name = typeof options.key === "function" ? options.key(id) : options.key;
    return name || !code || !branch ? docsKey(id, name ?? options.review ?? "") : reviewKey(id, root, branch);
  };
  const request = PublishRequest.safeParse({
    reviewId: options.review,
    reviewKey: keyFor(instanceId ?? ""),
    repo,
    branch,
    title,
    base: manifest.base ?? null,
    head: manifest.head ?? null,
    main: manifest.main,
    topics,
    writeup: manifest.writeup,
    links: manifest.links,
    // The manifest's own repoUrl wins only when it is valid, and null opts out of the derived one.
    // The schema drops an invalid string, which falls back to the derived value.
    repoUrl: manifest.repoUrl === null ? undefined : (manifest.repoUrl ?? repoUrl),
    files,
  });
  if (!request.success) throw new CliError("invalid resolved publish request");
  if (Buffer.byteLength(JSON.stringify(request.data)) > LIMITS.publishJsonBytes)
    throw new CliError("publish request exceeds its size limit");
  return { request: request.data, blobs, forInstance: (id: string) => ({ ...request.data, reviewKey: keyFor(id) }) };
}
