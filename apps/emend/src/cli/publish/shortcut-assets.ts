import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, posix, relative, sep } from "node:path";
import { LIMITS, type PublishFile } from "@emend/contract";
import { CliError } from "../http.ts";
import { assetCandidates, assetWarning } from "./assets.ts";
import {
  checkPublishedFolders,
  GitFolderRead,
  inside,
  leadingFolders,
  OversizedFile,
  outsideGit,
  type PublishedFolder,
  PublishedFolderEscape,
  readRegular,
  sourcePath,
} from "./read.ts";
import type { BlobSource } from "./upload.ts";

interface AssetSource {
  file: string;
  docFolders: Set<string>;
  walkedFolders: Map<string, PublishedFolder>;
  docs: Set<DocAssets>;
  size?: number;
  skipped?: string;
  hash?: string;
}
interface DocAssets {
  doc: PublishFile;
  bytes: number;
  remaining: number;
  refs: { path: string; raw: string; source: AssetSource }[];
}

/** Gather bounded references before any asset IO; each source owns one merged set of boundaries. */
export class ShortcutAssets {
  private sources = new Map<string, AssetSource>();
  private docs: DocAssets[] = [];
  private referenceBytes = 0;
  private gitDirs: string[];
  private warn: (line: string) => void;
  private excludedAssets: ReadonlySet<string>;

  constructor(gitDirs: string[], warn: (line: string) => void, excludedAssets: ReadonlySet<string> = new Set()) {
    this.gitDirs = gitDirs;
    this.warn = warn;
    this.excludedAssets = excludedAssets;
  }

  add(doc: PublishFile, realSource: string, bytes: Buffer, folders: readonly PublishedFolder[]) {
    const entry: DocAssets = {
      doc,
      bytes: bytes.length,
      remaining: LIMITS.htmlDocWithAssetsBytes - bytes.length,
      refs: [],
    };
    this.docs.push(entry);
    const seen = new Set<string>();
    this.referenceBytes += 2; // Brackets for the assets array.
    for (const candidate of assetCandidates(realSource, bytes.toString(), this.warn, true)) {
      // The shortcut reports these skips once, using their walked paths.
      if (this.excludedAssets.has(candidate.file)) continue;
      const path = posix.join(posix.dirname(doc.path), candidate.ref);
      if (seen.has(path)) continue;
      seen.add(path);
      this.referenceBytes += Buffer.byteLength(JSON.stringify(path)) + (entry.refs.length ? 1 : 0);
      if (this.referenceBytes > LIMITS.publishJsonBytes) throw new CliError("publish request exceeds its size limit");
      let asset = this.sources.get(candidate.file);
      if (!asset) {
        asset = { file: candidate.file, docFolders: new Set(), walkedFolders: new Map(), docs: new Set() };
        this.sources.set(candidate.file, asset);
      }
      asset.docFolders.add(dirname(realSource));
      for (const folder of folders) asset.walkedFolders.set(folder.root, folder);
      asset.docs.add(entry);
      entry.refs.push({ path, raw: candidate.raw, source: asset });
    }
  }

  private pathIssue(asset: AssetSource, actual: string) {
    checkPublishedFolders(actual, [...asset.walkedFolders.values()]);
    if (this.excludedAssets.has(actual)) return "may hold a secret";
    if (actual.split(sep).includes("node_modules")) return "target is in node_modules";
    for (const folder of asset.docFolders) outsideGit(actual, this.gitDirs, [folder]);
    for (const folder of asset.docFolders) {
      if (!inside(folder, actual)) return "source is outside the allowed doc roots";
      if (
        relative(folder, actual)
          .split(sep)
          .some((segment) => segment.startsWith("."))
      )
        return "target leaves the visible doc folder";
    }
    if (Array.from(actual).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
      return "target leaves the visible doc folder";
  }

  private async inspect(asset: AssetSource) {
    const folders = [...asset.docFolders].sort((a, b) => a.length - b.length);
    try {
      const actual = await realpath(asset.file);
      const issue = this.pathIssue(asset, actual);
      if (issue)
        return issue === "source is outside the allowed doc roots" ? "target leaves the visible doc folder" : issue;
      if (asset.walkedFolders.size && !(await lstat(asset.file)).isFile()) return "not a regular file";
      // After pathIssue passes, every doc folder is an ancestor of the source.
      // Checking only the outermost (folders[0]) therefore covers all leading components.
      if (!(await leadingFolders(folders[0] ?? dirname(asset.file), asset.file)))
        return "target is behind a symlink or non-folder";
      const info = await stat(actual);
      if (!info.isFile()) return "not a regular file";
      asset.size = info.size;
    } catch (error) {
      if (error instanceof GitFolderRead || error instanceof PublishedFolderEscape) throw error;
      return "file does not exist";
    }
  }

  private checkSize(entry: DocAssets) {
    const size = entry.refs.reduce((sum, { source }) => sum + (source.size ?? 0), entry.bytes);
    if (size > LIMITS.htmlDocWithAssetsBytes) throw new CliError("HTML doc and assets exceed their size limit");
  }

  async resolve(fileCount: number, add: (bytes: Buffer, read: BlobSource["read"]) => string) {
    for (const asset of this.sources.values()) {
      asset.skipped = await this.inspect(asset);
      if (asset.size !== undefined && asset.size > LIMITS.assetBytes)
        throw new CliError("asset exceeds its size limit");
    }
    const paths = new Set<string>();
    for (const entry of this.docs) {
      entry.refs = entry.refs.filter(({ source, raw }) => {
        if (!source.skipped) return true;
        this.warn(assetWarning(raw, source.skipped));
        return false;
      });
      entry.doc.assets = entry.refs.map(({ path }) => path);
      for (const { path } of entry.refs) paths.add(path);
      if (fileCount + paths.size > LIMITS.filesPerRevision) throw new CliError("too many files in the review");
      this.checkSize(entry);
    }
    for (const asset of this.sources.values()) {
      if (asset.skipped) continue;
      const folders = [...asset.docFolders].sort((a, b) => a.length - b.length);
      const walked = [...asset.walkedFolders.values()];
      const check = (actual: string) => {
        const issue = this.pathIssue(asset, actual);
        if (issue)
          throw new CliError(issue === "target is in node_modules" ? "asset target changed into node_modules" : issue);
      };
      const read = async (limit: number = LIMITS.assetBytes) => {
        const actual = await sourcePath(asset.file, folders, this.gitDirs, walked);
        check(actual);
        return readRegular(
          walked.length ? asset.file : actual,
          limit,
          folders,
          undefined,
          this.gitDirs,
          (_info, opened) => check(opened),
        );
      };
      let limit: number = LIMITS.assetBytes;
      for (const doc of asset.docs) limit = Math.min(limit, doc.remaining);
      // A spent doc budget can leave limit <= 0; read(0) intentionally rejects content with the combined-size message.
      let bytes: Buffer;
      try {
        bytes = await read(limit);
      } catch (error) {
        if (error instanceof OversizedFile && limit < LIMITS.assetBytes)
          throw new CliError("HTML doc and assets exceed their size limit");
        throw error;
      }
      for (const doc of asset.docs) {
        doc.remaining -= bytes.length;
        if (doc.remaining < 0) throw new CliError("HTML doc and assets exceed their size limit");
      }
      asset.size = bytes.length;
      asset.hash = add(bytes, read);
    }
    const emitted = new Set<string>();
    const result = new Map<string, PublishFile[]>();
    for (const entry of this.docs) {
      this.checkSize(entry);
      const files: PublishFile[] = [];
      for (const { path, source } of entry.refs) {
        if (emitted.has(path)) continue;
        emitted.add(path);
        files.push({
          path,
          oldPath: null,
          role: "asset",
          parent: entry.doc.path,
          oldBlob: null,
          newBlob: source.hash ?? null,
          flag: null,
        });
      }
      result.set(entry.doc.path, files);
    }
    return result;
  }
}
