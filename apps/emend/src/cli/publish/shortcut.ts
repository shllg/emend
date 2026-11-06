import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { docViewOf, isRenderedHtmlDoc, LIMITS, PublishManifest } from "@emend/contract";
import { cleanDocTitle, decodeText } from "@emend/core";
import { workerExecutor } from "../../server/publish/executor.ts";
import { readDocRoots } from "../config.ts";
import { escapeReference } from "../escape.ts";
import { CliError } from "../http.ts";
import { manifestError } from "./manifest-error.ts";
import {
  checkPublishedFolders,
  inside,
  NotRegularFile,
  OversizedFile,
  outsideGitSegments,
  type PublishedFolder,
  readRegular,
  sourcePath,
} from "./read.ts";
import type { publishContext } from "./resolve.ts";
import { readSkipReason, SHORTCUT_LIMITS, type SkipReason, visible, walkDocs } from "./shortcut-walk.ts";

export interface ShortcutOptions {
  paths: string[];
  title?: string;
  main?: string;
  key?: string;
  review?: string;
  new?: boolean;
  source?: boolean;
}

const isHtml = (path: string) => isRenderedHtmlDoc({ role: "doc", path });
const isMarkdown = (path: string) => docViewOf({ path }) === "rendered" && !isHtml(path);

function entry(paths: string[]): string {
  return (
    (paths.length === 1 ? paths[0] : undefined) ??
    paths.find((path) => path === "index.html") ??
    (paths.filter(isHtml).length === 1 ? paths.find(isHtml) : undefined) ??
    paths.find((path) => path === "index.md") ??
    paths.find((path) => path === "README.md") ??
    (paths.filter(isMarkdown).length === 1 ? paths.find(isMarkdown) : undefined) ??
    paths[0] ??
    ""
  );
}

/** Build an ordinary docs manifest; identity is finalized only when publish knows the instance. */
export async function shortcutManifest(
  options: ShortcutOptions,
  stateDir: string,
  cwd: string,
  context: Awaited<ReturnType<typeof publishContext>>,
) {
  const roots = [...(context.worktree ? [context.worktree] : []), ...(await readDocRoots(stateDir))];
  const checked = async (file: string) => {
    outsideGitSegments(file, context.root);
    try {
      return await sourcePath(file, roots, context.gitDirs);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw new CliError(`doc not found: ${escapeReference(file)}`);
      throw error;
    }
  };
  const inputs = new Set<string>();
  const bases: string[] = [];
  const docs = new Map<string, string>();
  const folders = new Map<string, PublishedFolder[]>();
  const explicit = new Map<string, string>();
  const folderArguments: PublishedFolder[] = [];
  const skipped = new Map<string, SkipReason>();
  const skippedArguments: string[] = [];
  const add = (actual: string, source: string) => {
    if (!visible(basename(actual))) {
      skipped.set(actual, "not a doc or referenced HTML asset");
      return;
    }
    docs.set(actual, source);
    if (docs.size > LIMITS.filesPerRevision) throw new CliError("too many files in the review");
  };
  const budget = { entries: 0, directories: 0 };
  for (const path of options.paths) {
    const source = resolve(cwd, path);
    const actual = await checked(source).catch((error: unknown) => {
      const reason = readSkipReason(error);
      if (reason) throw new CliError(`${reason}: ${escapeReference(path)}`);
      throw error;
    });
    const info = await lstat(actual);
    if (info.isDirectory()) folderArguments.push({ root: actual, argument: path });
    if (info.isFile() && !visible(basename(actual))) {
      skippedArguments.push(path);
      inputs.add(actual);
      continue;
    }
    if (inputs.has(actual)) continue;
    inputs.add(actual);
    if (info.isDirectory()) {
      bases.push(actual);
      await walkDocs(
        actual,
        path,
        checked,
        (file, source) => {
          add(file, source);
          const origins = folders.get(file) ?? [];
          origins.push({ root: actual, argument: path });
          folders.set(file, origins);
        },
        (file, reason) => skipped.set(file, reason),
        budget,
      );
    } else if (info.isFile()) {
      explicit.set(actual, path);
      bases.push(dirname(actual));
      // A walked file keeps its regular source and merged boundaries when an alias names it too.
      if (!folders.has(actual)) add(actual, source);
    } else throw new NotRegularFile();
  }
  // Check walked sizes/readability before choosing main; only source views require UTF-8.
  for (const [actual, source] of docs) {
    const boundaries = folders.get(actual);
    if (!boundaries) continue;
    const argument = explicit.get(actual);
    const html = !options.source && isHtml(actual);
    let bytes: Buffer;
    try {
      const checkedPath = await sourcePath(source, roots, context.gitDirs, boundaries);
      bytes = await readRegular(
        source,
        html ? LIMITS.htmlDocBytes : LIMITS.markdownDocBytes,
        roots,
        undefined,
        context.gitDirs,
        (_info, opened) => checkPublishedFolders(opened, boundaries),
      );
      if (checkedPath !== actual) throw new CliError("source changed before publish");
    } catch (error) {
      const reason = readSkipReason(error);
      if (!reason) throw error;
      if (argument !== undefined)
        throw new CliError(`${error instanceof OversizedFile ? error.message : reason}: ${escapeReference(argument)}`);
      docs.delete(actual);
      skipped.set(actual, reason);
      continue;
    }
    if (!options.source && docViewOf({ path: actual }) === "rendered") continue;
    try {
      const text = decodeText(bytes);
      if (argument === undefined && /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|PuTTY-User-Key-File-/.test(text)) {
        docs.delete(actual);
        skipped.set(actual, "may hold a secret");
      }
    } catch {
      if (argument !== undefined) throw new CliError(`not a text file: ${escapeReference(argument)}`);
      docs.delete(actual);
      skipped.set(actual, "not a text file");
    }
  }
  if (!docs.size) {
    const skips = [
      ...skippedArguments.map((path) => `${escapeReference(path)}: not a visible text doc`),
      ...[...skipped]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([file, reason]) => `${escapeReference(relative(cwd, file))}: ${reason}`),
    ];
    const names = skips.slice(0, SHORTCUT_LIMITS.warnings).join(", ");
    const more = skips.length - SHORTCUT_LIMITS.warnings;
    throw new CliError(
      `no text docs to publish${names ? `; skipped ${names}${more > 0 ? ` and ${more} more files` : ""}` : ""}`,
    );
  }
  let base = bases[0] ?? cwd;
  for (const folder of bases) while (!inside(base, folder)) base = dirname(base);
  const reviewPath = (file: string) => relative(base, file).split(sep).join("/");
  const files = [...docs].map(([actual, source]) => ({
    path: reviewPath(actual),
    source,
    role: "doc" as const,
    ...(options.source ? { view: "source" as const } : {}),
  }));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let main = entry(files.map((file) => file.path));
  if (options.main !== undefined) {
    const chosen = files.find((file) => file.path === options.main);
    if (chosen) main = chosen.path;
    else {
      const actual = await checked(resolve(cwd, options.main));
      if (!docs.has(actual)) throw new CliError("--main must name a published doc");
      main = reviewPath(actual);
    }
  }
  const givenTitle = cleanDocTitle(options.title ?? "");
  const fallbackTitle = cleanDocTitle(basename(main)) || "Document";
  const titleFromMain =
    givenTitle || docViewOf({ path: main, ...(options.source ? { view: "source" } : {}) }) === "source"
      ? undefined
      : async (bytes: Uint8Array) => {
          const execute = workerExecutor();
          try {
            const result = await execute({
              kind: "doc-metadata",
              format: isHtml(main) ? "html" : "markdown",
              bytes: Uint8Array.from(bytes).buffer,
            });
            return (result.kind === "doc-metadata" && result.title) || fallbackTitle;
          } catch {
            return fallbackTitle;
          } finally {
            await execute.close();
          }
        };
  const parsed = PublishManifest.safeParse(
    {
      version: 1,
      title: givenTitle || fallbackTitle,
      main,
      topics: [],
      files,
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    },
    { reportInput: true },
  );
  if (!parsed.success) throw new CliError(manifestError(parsed.error.issues));
  const paths = [...inputs].sort();
  const key =
    options.key ??
    (options.new
      ? `new:${randomUUID()}`
      : (id: string) =>
          `path:${createHash("sha256")
            .update(JSON.stringify([id, ...paths]))
            .digest("hex")
            .slice(0, 16)}`);
  const docFolders = new Map([...folders].map(([file, origins]) => [reviewPath(file), origins]));
  return {
    manifest: parsed.data,
    key,
    titleFromMain,
    docFolders,
    skippedArguments,
    skipped: [...skipped].map(([file, reason]) => ({ path: reviewPath(file), reason })),
    docArguments: new Map([...explicit].map(([file, argument]) => [reviewPath(file), argument])),
    folderArguments: folderArguments.map(({ root, argument }) => ({ path: reviewPath(root), argument })),
  };
}
