import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type DocView, isRenderedHtmlDoc, LIMITS, PublishManifest, PublishResponse } from "@emend/contract";
import type { Io } from "../../main.ts";
import { readDocRoots } from "../config.ts";
import { publishDirect } from "../direct/index.ts";
import { escapeReference } from "../escape.ts";
import { apiRequest, CliError, printJson, publishAnswerIncomplete } from "../http.ts";
import { binnedError, movedError, refuseUncopiedReview } from "../moved.ts";
import { manifestError } from "../publish/manifest-error.ts";
import { GitFolderRead, inside, NotRegularFile, OversizedFile, readRegular } from "../publish/read.ts";
import { type PublishOptions, publishContext, resolvePublish } from "../publish/resolve.ts";
import { type ShortcutOptions, shortcutManifest } from "../publish/shortcut.ts";
import { SHORTCUT_LIMITS } from "../publish/shortcut-walk.ts";
import { upload } from "../publish/upload.ts";
import { readAttachmentPair, resolveTarget } from "../target.ts";

type PublishArgs = ShortcutOptions & { manifest?: string; json?: boolean; project?: string };
const publishUsage =
  "usage: emend publish <path>... [--title T] [--key K | --new] [--review ID] [--main PATH] [--source] [--json] [--project NAME], or emend publish --manifest <file> [--review <id>] [--key <name>] [--project NAME]";

export function parsePublishArgs(args: string[]): PublishArgs {
  const opts: PublishArgs = { paths: [] };
  let positional = false;
  const validValue = (value: string, title = false) =>
    title ||
    (value.length > 0 &&
      value.length <= LIMITS.pathChars &&
      !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === undefined) throw new CliError(publishUsage);
    if (name === "--" && !positional) {
      positional = true;
      continue;
    }
    if (positional || !name.startsWith("-")) {
      if (!validValue(name)) throw new CliError(publishUsage);
      opts.paths.push(name);
      continue;
    }
    if (name === "--new" || name === "--json" || name === "--source") {
      const key = name === "--new" ? "new" : name === "--source" ? "source" : "json";
      if (opts[key]) throw new CliError("duplicate publish option");
      opts[key] = true;
      continue;
    }
    if (name === "--project") {
      if (opts.project !== undefined) throw new CliError("duplicate publish option");
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new CliError(publishUsage);
      const project = value.trim();
      if (
        !project ||
        project.length > LIMITS.titleChars ||
        Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      )
        throw new CliError("invalid project name");
      opts.project = project;
      continue;
    }
    if (!["--manifest", "--review", "--key", "--title", "--main"].includes(name)) throw new CliError(publishUsage);
    const value = args[++i];
    if (value === undefined || value.startsWith("--") || !validValue(value, name === "--title"))
      throw new CliError(publishUsage);
    const key = name.slice(2) as "manifest" | "review" | "key" | "title" | "main";
    if (opts[key] !== undefined) throw new CliError("duplicate publish option");
    opts[key] = value;
  }
  if (
    opts.manifest &&
    (opts.paths.length || opts.title !== undefined || opts.main !== undefined || opts.new || opts.json || opts.source)
  )
    throw new CliError(publishUsage);
  if (!opts.manifest && !opts.paths.length) throw new CliError(publishUsage);
  if (opts.new && (opts.key || opts.review)) throw new CliError(publishUsage);
  if (opts.review && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(opts.review))
    throw new CliError("invalid review id");
  return opts;
}
export const publishTimeoutMs = (files: { role: string; path: string; view?: DocView }[]) =>
  30000 +
  15000 +
  10000 * (1 + files.filter((file) => file.role === "doc" && !isRenderedHtmlDoc(file)).length) +
  3 * 30000;

export function manifestJsonError(error: SyntaxError, text: string): string {
  const message = "the manifest is not valid JSON";
  // Only engine location suffixes are safe; quoted input can occur elsewhere in the message.
  const location = /\(line (\d+) column (\d+)\)$/.exec(error.message);
  if (location) return `${message} (line ${location[1]}, column ${location[2]})`;
  const position = /\bposition (\d+)$/.exec(error.message);
  if (!position) return message;
  const offset = Number(position[1]);
  if (!Number.isSafeInteger(offset) || offset > text.length) return message;
  const lines = text.slice(0, offset).split(/\r\n|\r|\n/);
  return `${message} (line ${lines.length}, column ${(lines.at(-1)?.length ?? 0) + 1})`;
}

async function readManifest(path: string, cwd: string, context: Awaited<ReturnType<typeof publishContext>>) {
  const manifestPath = resolve(cwd, path);
  const unsafeManifest = new CliError(
    `the manifest ${escapeReference(manifestPath)} can be changed by other users; write it in a private folder`,
  );
  let manifestText: string;
  try {
    manifestText = (
      await readRegular(
        manifestPath,
        LIMITS.publishJsonBytes,
        inside(context.root, manifestPath) ? [context.root] : undefined,
        undefined,
        context.gitDirs,
        async (info, actual) => {
          if (!process.getuid || (context.worktree && inside(context.worktree, actual))) return;
          const uid = process.getuid();
          if (info.uid !== uid || (info.mode & 0o002) !== 0) throw unsafeManifest;
          if ((info.mode & 0o020) !== 0) {
            const folder = await lstat(dirname(actual)).catch(() => {
              throw unsafeManifest;
            });
            if (!folder.isDirectory() || folder.uid !== uid || (folder.mode & 0o077) !== 0) throw unsafeManifest;
          }
        },
      )
    ).toString();
  } catch (error) {
    if (error instanceof GitFolderRead || error === unsafeManifest) throw error;
    if (error instanceof NotRegularFile || ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw new CliError(`manifest not found: ${escapeReference(path)}`);
    if (error instanceof OversizedFile) throw new CliError("manifest exceeds its size limit");
    throw new CliError("invalid publish manifest");
  }
  let input: unknown;
  try {
    input = JSON.parse(manifestText);
  } catch (error) {
    throw new CliError(
      error instanceof SyntaxError ? manifestJsonError(error, manifestText) : "invalid publish manifest",
    );
  }
  const parsed = PublishManifest.safeParse(input, { reportInput: true });
  if (!parsed.success) throw new CliError(manifestError(parsed.error.issues));
  return parsed.data;
}

export async function publishCommand(
  stateDir: string,
  configDir: string,
  args: string[],
  io: Io,
  cwd = process.cwd(),
): Promise<void> {
  const parsed = parsePublishArgs(args);
  const context = await publishContext(cwd, stateDir);
  const configRoots = await readDocRoots(stateDir, configDir, cwd, io.stderr);
  const shortcut = parsed.manifest
    ? undefined
    : await shortcutManifest(parsed, stateDir, configDir, cwd, context, configRoots);
  const manifest = shortcut?.manifest ?? (await readManifest(parsed.manifest ?? "", cwd, context));
  const options: PublishOptions = {
    manifest: parsed.manifest,
    key: shortcut?.key ?? parsed.key,
    review: parsed.review,
    project: parsed.project,
    skipNodeModules: shortcut !== undefined,
    titleFromMain: shortcut?.titleFromMain,
    docFolders: shortcut?.docFolders,
    excludedAssets: shortcut?.excludedAssets,
    retainedSources: shortcut?.retainedSources,
    folderRoots: shortcut?.folderRoots,
    namedFiles: shortcut?.namedFiles,
    docArguments: shortcut?.docArguments,
  };
  if (!manifest.base && !options.key && !options.review) throw new CliError("pass --review or --key");
  // Resolve all paths and unchanged-file checks before creating any server state.
  const warnings: string[] = [];
  let moreSkipped = 0;
  const warn = (line: string) => {
    if (shortcut && warnings.length >= SHORTCUT_LIMITS.warnings) moreSkipped++;
    else warnings.push(line);
  };
  for (const argument of shortcut?.skippedArguments ?? [])
    warn(`emend: skipped ${escapeReference(argument)}: not a visible text doc\n`);
  const collected = await resolvePublish(manifest, options, stateDir, configDir, null, cwd, warn, context, configRoots);
  const published = new Set(collected.request.files.map((file) => file.path));
  for (const { path, reason } of shortcut?.skipped ?? [])
    if (!published.has(path)) warn(`emend: skipped ${escapeReference(path)}: ${reason}\n`);
  const pair = await readAttachmentPair(stateDir);
  const localReviewId = pair
    ? await refuseUncopiedReview(
        stateDir,
        {
          reviewId: options.review,
          keyFor: (id) => collected.forInstance(id).reviewKey,
        },
        pair.attachment.hubUrl,
      )
    : undefined;
  const target = await resolveTarget(stateDir, pair);
  let response: unknown;
  try {
    if (target.via === "direct") response = await publishDirect(stateDir, collected);
    else {
      let instanceId: string;
      try {
        const instance = JSON.parse(
          (await readRegular(join(stateDir, "instance.json"), LIMITS.publicJsonBytes)).toString(),
        );
        if (typeof instance.id !== "string" || !/^[a-f0-9-]{36}$/i.test(instance.id)) throw new Error("invalid");
        instanceId = instance.id;
      } catch {
        throw new CliError("invalid emend instance");
      }
      const request = collected.forInstance(instanceId);
      if (localReviewId) request.reviewId = localReviewId;
      await upload(stateDir, target, collected.blobs);
      response = await apiRequest(stateDir, target, "/publish", {
        method: "POST",
        body: request,
        timeoutMs: publishTimeoutMs(request.files),
      });
    }
  } catch (error) {
    return movedError(
      stateDir,
      error,
      { reviewId: options.review, keyFor: (id) => collected.forInstance(id).reviewKey },
      true,
    ).catch((next) =>
      binnedError(stateDir, next, {
        reviewId: options.review,
        publish: true,
        shortcut: options.manifest === undefined,
      }),
    );
  }
  const result = PublishResponse.safeParse(response);
  if (!result.success) throw new CliError(publishAnswerIncomplete);
  if (!shortcut || parsed.json) await printJson(io, result.data);
  else {
    try {
      await (io.stdoutAsync ?? io.stdout)(`${escapeReference(result.data.url)}\n`);
    } catch {
      throw new CliError("Could not write to stdout.");
    }
  }
  for (const warning of warnings) io.stderr(warning);
  if (moreSkipped) io.stderr(`emend: and ${moreSkipped} more files skipped\n`);
  for (const folder of shortcut?.folderArguments ?? []) {
    const count = [...published].filter((path) => !folder.path || path.startsWith(`${folder.path}/`)).length;
    io.stderr(`emend: published ${count} files from ${escapeReference(folder.argument)}\n`);
  }
  for (const path of result.data.unrendered) io.stderr(`emend: could not render ${escapeReference(path)}\n`);
  io.stderr(`emend: published revision ${result.data.revision}: ${escapeReference(result.data.url)}\n`);
  if (target.via === "direct")
    io.stderr("emend: emend is not running; the review opens once it runs (emend serve, or emend service install)\n");
}
