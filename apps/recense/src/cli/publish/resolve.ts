import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
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
  writeupMarkdown,
} from "@recense/contract";
import { decodeText, UnchangedFilesError, withOtherChanges } from "@recense/core";
import { WorkTimeout, workerExecutor } from "../../server/publish/executor.ts";
import type { Executor } from "../../server/publish/work.ts";
import { readDocRoots } from "../config.ts";
import { escapeReference } from "../escape.ts";
import { createGitSession, GitFailed } from "../git.ts";
import { CliError } from "../http.ts";
import { collectAssets, docAssetSizeError, docImageWarning, type WalkedSecretPaths } from "./assets.ts";
import { collectChanges } from "./collect.ts";
import { codeRoot } from "./context.ts";
import { createImageResolver, type ImageBlob } from "./image.ts";
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
import { gitFolders } from "./root.ts";
import { ShortcutAssets } from "./shortcut-assets.ts";
import { isSecretPath, readSkipReason } from "./shortcut-walk.ts";
import { readSide } from "./sides.ts";

import { type BlobSource, readBlob } from "./upload.ts";

export type PublishOptions = {
  manifest?: string;
  review?: string;
  project?: string;
  key?: string | ((instanceId: string) => string);
  skipNodeModules?: boolean;
  titleFromMain?: (bytes: Uint8Array, execute: Executor) => string | Promise<string>;
  /** Observe the existing source read without retaining or re-reading doc bytes for diagnostics. */
  onHtmlDoc?: (path: string, bytes: Buffer) => void;
  docFolders?: ReadonlyMap<string, readonly PublishedFolder[]>;
  /** Absolute paths rejected by the walked-doc private-key content check. */
  excludedAssets?: ReadonlySet<string>;
  /** Absolute paths whose secret-name warning is already supplied by the folder walk. */
  walkedSecretPaths?: WalkedSecretPaths;
  retainedSources?: RetainedSources;
  /** Real paths of shortcut folder arguments and explicitly named files. */
  folderRoots?: readonly string[];
  namedFiles?: ReadonlySet<string>;
  docArguments?: ReadonlyMap<string, string>;
};
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const imageSyntax = /!\[|<im(?:g|age)/i;
export function shortenRepoName(name: string): string {
  let end = LIMITS.titleChars;
  const before = name.charCodeAt(end - 1);
  const after = name.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
  return name.slice(0, end);
}
export async function publishContext(cwd: string, stateDir: string) {
  const git = createGitSession();
  const { worktree, root } = await codeRoot(cwd, stateDir, git);
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
  execute?: Executor,
) {
  let worker: ReturnType<typeof workerExecutor> | undefined;
  const ownedExecutor: Executor = (work) => {
    worker ??= workerExecutor();
    return worker(work);
  };
  try {
    return await resolveWithWorker(
      execute ?? ownedExecutor,
      manifest,
      options,
      stateDir,
      configDir,
      instanceId,
      cwd,
      warn,
      context,
      configRoots,
    );
  } finally {
    await worker?.close();
  }
}
async function resolveWithWorker(
  execute: Executor,
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
  // Every image needs one of these markers; the worker still decides what actually renders.
  if (
    options.manifest !== undefined &&
    writeupMarkdown(manifest.writeup).some((text) => imageSyntax.test(text ?? ""))
  ) {
    const result = await execute({
      kind: "writeup",
      source: manifest.writeup,
      topics: manifest.topics,
      media: (manifest.media ?? []).map(({ path }) => [path, "0".repeat(64)]),
    }).catch((error: unknown) => {
      throw new CliError(
        error instanceof WorkTimeout ? "the writeup rendering timed out" : "the writeup could not be rendered",
      );
    });
    if (result.kind !== "writeup") throw new CliError("the writeup could not be rendered");
    const paths = result.unlistedMedia ?? [];
    if (paths.length) {
      const shown = paths.slice(0, 5);
      const count = result.unlistedMediaCount ?? paths.length;
      const remaining = count - shown.length;
      const labels = shown.map((path) => {
        const points = Array.from(path);
        return escapeReference(points.length > 200 ? `${points.slice(0, 200).join("")}…` : path);
      });
      throw new CliError(
        `writeup image${count > 1 ? "s" : ""} not listed under media: ${labels.join(", ")}${remaining > 0 ? ` and ${remaining} more` : ""}`,
      );
    }
  }
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
    repoUrl = remote ? (remoteToRepoUrl(remote) ?? undefined) : undefined;
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
  const addBlob = (hash: string, size: number, read: BlobSource["read"]) => {
    if (!blobs.has(hash)) {
      if (totalBytes + size > LIMITS.revisionBytes) return null;
      totalBytes += size;
      if (options.docFolders) {
        // Shortcut deduplication retains every source's checks, including shared doc assets.
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
  const add = (bytes: Buffer, read: BlobSource["read"]) => addBlob(sha256(bytes), bytes.length, read);
  const registered = new WeakSet<ImageBlob>();
  const resolveImages = createImageResolver(root, git, gitDirs, (sources) => {
    // Reserve the whole pair before registering either upload or any shared-blob rechecks.
    const missing = new Map(sources.filter(({ hash }) => !blobs.has(hash)).map(({ hash, size }) => [hash, size]));
    let size = totalBytes;
    for (const bytes of missing.values()) size += bytes;
    if (size > LIMITS.revisionBytes) return;
    return () => {
      for (const source of sources) {
        if (registered.has(source)) continue;
        addBlob(source.hash, source.size, source.read);
        registered.add(source);
      }
    };
  });
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
  const mediaPaths = new Set(manifest.media?.map((item) => item.path));
  const shortcutAssets = options.docFolders
    ? new ShortcutAssets(
        gitDirs,
        warn,
        options.excludedAssets,
        options.folderRoots,
        options.namedFiles,
        options.retainedSources,
        options.walkedSecretPaths,
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
      if (await resolveImages(resolved, change, manifest.head)) {
        files.push(resolved);
        continue;
      }
      const before = new Set(blobs.keys());
      const beforeBytes = totalBytes;
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
    if (html) options.onHtmlDoc?.(file.path, bytes);
    if (sourceView) {
      try {
        decodeText(bytes);
      } catch {
        throw new CliError(`not a text file: ${argument}`);
      }
      if (file.source !== undefined) checkExtension(file.source);
      checkExtension(source);
    }
    if (file.path === manifest.main && options.titleFromMain) title = await options.titleFromMain(bytes, execute);
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
    if (sourceView) continue;
    const format = html ? "html" : "markdown";
    let imageReferences: string[] = [];
    // Only image syntax can produce img elements; a pre-check miss only leaves an image out.
    if (!html && imageSyntax.test(bytes.toString())) {
      const label = escapeReference(options.docArguments?.get(file.path) ?? file.path);
      try {
        const result = await execute({ kind: "doc-images", bytes: Uint8Array.from(bytes).buffer });
        if (result.kind !== "doc-images") throw new Error("wrong result");
        imageReferences = result.references;
        if (result.capped) warn(docImageWarning(label, "some images left out: too many image references"));
      } catch {
        warn(docImageWarning(label, "published without images: image discovery failed or timed out"));
      }
    }
    if (shortcutAssets) {
      // source is the checked real path, so aliases use the target folder for assets.
      // readResolvedDoc/readDoc enforce the doc Git and published-folder rules here.
      shortcutAssets.add(resolvedDoc, source, bytes, publishedFolders, format, imageReferences);
      continue;
    }
    const assets = await collectAssets(
      source,
      warn,
      bytes.toString(),
      gitDirs,
      options.skipNodeModules,
      publishedFolders,
      format,
      imageReferences,
    );
    resolvedDoc.assets = assets.map((asset) => posix.join(posix.dirname(file.path), asset.ref));
    let size = bytes.length;
    for (const asset of assets) {
      if (!html && mediaPaths.has(posix.join(posix.dirname(file.path), asset.ref))) continue;
      const info = await stat(asset.file);
      if (info.size > LIMITS.assetBytes) throw new CliError("asset exceeds its size limit");
      size += info.size;
      if (size > LIMITS.htmlDocWithAssetsBytes) throw new CliError(docAssetSizeError(format));
    }
    let actualSize = bytes.length;
    const readAsset = async (file: string, limit: number) => {
      const actual = await sourcePath(file, [dirname(source)], gitDirs, publishedFolders);
      if (!html && isSecretPath(basename(actual))) throw new CliError("asset target changed to a secret-looking name");
      if (options.skipNodeModules && actual.split(sep).includes("node_modules"))
        throw new CliError("asset target changed into node_modules");
      return readRegular(
        publishedFolders.length ? file : actual,
        limit,
        [dirname(source)],
        undefined,
        gitDirs,
        (_info, opened) => {
          checkPublishedFolders(opened, publishedFolders);
          if (!html && isSecretPath(basename(opened)))
            throw new CliError("asset target changed to a secret-looking name");
        },
      );
    };
    for (const asset of assets) {
      const path = posix.join(posix.dirname(file.path), asset.ref);
      if ((!html && mediaPaths.has(path)) || assetPaths.has(path)) continue;
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
    // Rendered docs already passed their checked reads; this phase checks their shared assets.
    const assets = await shortcutAssets.resolve(files.length, addRequired);
    files = files.flatMap((file) => [
      file,
      ...(file.role === "doc" && docViewOf(file) === "rendered" ? (assets.get(file.path) ?? []) : []),
    ]);
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
  // Shared assets and writeup-media overlaps count at their final stored size for every doc.
  const resolvedAssets = new Map(files.filter((file) => file.role === "asset").map((file) => [file.path, file]));
  for (const doc of files) {
    if (!doc.assets) continue;
    const size = doc.assets.reduce(
      (sum, path) => sum + (blobs.get(resolvedAssets.get(path)?.newBlob ?? "")?.size ?? 0),
      blobs.get(doc.newBlob ?? "")?.size ?? 0,
    );
    if (size > LIMITS.htmlDocWithAssetsBytes)
      throw new CliError(docAssetSizeError(isRenderedHtmlDoc(doc) ? "html" : "markdown"));
  }
  const keyFor = (id: string) => {
    const name = typeof options.key === "function" ? options.key(id) : options.key;
    return name || !code || !branch ? docsKey(id, name ?? options.review ?? "") : reviewKey(id, root, branch);
  };
  // The manifest's own repoUrl wins only when it is valid, and null opts out of the derived one.
  // The schema drops an invalid string, which falls back to the derived value.
  const requestRepoUrl = manifest.repoUrl === null ? undefined : (manifest.repoUrl ?? repoUrl);
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
    // Titles show only beside a repoUrl, so none is sent without one.
    ...(requestRepoUrl && manifest.issueRefs ? { issueRefs: manifest.issueRefs } : {}),
    ...(manifest.intentReview !== undefined ? { intentReview: manifest.intentReview } : {}),
    repoUrl: requestRepoUrl,
    files,
  });
  if (!request.success) throw new CliError("invalid resolved publish request");
  if (Buffer.byteLength(JSON.stringify(request.data)) > LIMITS.publishJsonBytes)
    throw new CliError("publish request exceeds its size limit");
  return { request: request.data, blobs, forInstance: (id: string) => ({ ...request.data, reviewKey: keyFor(id) }) };
}
