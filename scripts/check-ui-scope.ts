import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, type Stats, writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

const contentBoundaries = new Set([
  "App.test.tsx",
  "diff-boundary.test.ts",
  "lifecycle-ui.test.tsx",
  "main.test.tsx",
  "reading-navigation.test.tsx",
  "reading-position.test.tsx",
  "reading.test.tsx",
  "source.test.tsx",
  "routes/review.tsx",
  "routes/theme-sample.test.tsx",
  "components/diff/comment-lines.test.tsx",
  "components/diff/parse-client.test.ts",
  "components/diff/parse-client.ts",
  "components/diff/parse.worker.ts",
  "components/diff/render.test.tsx",
  "components/diff/visibility.test.tsx",
  "components/diff/worker-pool.test.tsx",
  "components/diff/worker-render.test.tsx",
  "components/reading/BlockView.tsx",
  "components/reading/ChartBlock.test.tsx",
  "components/reading/ChartBlock.tsx",
  "components/reading/DocView.tsx",
  "components/reading/GlossaryTerms.tsx",
  "components/reading/HtmlDiagramRenderer.tsx",
  "components/reading/HtmlDocFrame.tsx",
  "components/reading/IssueCards.tsx",
  "components/reading/MermaidBlock.tsx",
  "components/reading/SourceView.tsx",
  "components/reading/agent-note-refs.test.tsx",
  "components/reading/agent-note-refs.ts",
  "components/reading/glossary-terms.test.tsx",
  "components/reading/highlights.test.tsx",
  "components/reading/html-diagrams.test.ts",
  "components/reading/html-diagrams.ts",
  "components/reading/issue-cards.test.tsx",
  "components/reading/lightbox.test.tsx",
  "components/reading/screenshots.ts",
  "components/reading/thread-marks.test.tsx",
  "components/reading/writeup.test.tsx",
  "components/review/ReviewHeader.test.tsx",
  "components/review/ReviewHeader.tsx",
  "components/threads/threads.test.tsx",
].map((path) => `apps/web/src/${path}`));

function allowed(path: string): boolean {
  const name = posix.basename(path);
  if (name.startsWith(".git")) return false;
  if (contentBoundaries.has(path) || /mermaid|html-bridge|html-doc|sanitiz|frame-build/i.test(name)
      || /^sw[.-]/i.test(name)) return false;
  return path.startsWith("apps/web/public/") ||
    /^apps\/web\/src\/(components|routes|styles)\//.test(path) ||
    /^apps\/web\/src\/[^/]+\.test\.tsx?$/.test(path) ||
    ["apps/web/src/styles.css", "apps/web/src/App.tsx", "apps/web/index.html"].includes(path);
}

export function outsideScope(paths: Iterable<string>): string[] {
  return [...new Set(paths)].filter((path) => !allowed(path)).sort();
}

const workspaceInstall = /^(?:(?:apps|packages)\/[^/]+\/)?node_modules\//;
// Directory paths have a trailing slash.
const ignoredSkips = [
  /^(?:(?:apps|packages)\/[^/]+\/)?node_modules\/\.(?:vite|vitest-cache|cache)\//,
  /^(?:(?:apps|packages)\/[^/]+\/)?\.tsbuild\//,
  /^apps\/[^/]+\/dist\//,
  /^\.wt\/ui\//,
  /^\.wt\/ui-demo\.json(?:\.[^/]*)?$/,
  /^\.claude\/scheduled_tasks\.lock$/,
];

type Report = (path: string, prefix?: string) => void;

function* nulRecords(output: Buffer) {
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) throw new Error("Unterminated git record");
    yield output.subarray(start, end);
    start = end + 1;
  }
}

function decodeName(bytes: Buffer, report: Report, parent = ""): string | undefined {
  const name = bytes.toString("utf8");
  if (Buffer.from(name).equals(bytes)) return name;
  report(Buffer.from(parent).toString("hex") + bytes.toString("hex"), "undecodable name: ");
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type Entries = Map<string, string>;
type Snapshot = { files: Entries; git: Entries; main: Entries };

function git(cwd: string, ...args: string[]): Buffer {
  return execFileSync("git", [
    "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
    "-c", "core.fileMode=true", "-c", "core.trustctime=true", "-c", "core.checkStat=default",
    "-c", "core.symlinks=true", ...args,
  ], {
    cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function symbolicHead(cwd: string): Buffer {
  try {
    return git(cwd, "symbolic-ref", "-q", "HEAD");
  } catch (error) {
    if ((error as { status?: number }).status === 1) return Buffer.alloc(0);
    throw error;
  }
}

async function fileHash(file: string, format = "sha256", prefix = ""): Promise<string> {
  const hash = createHash(format).update(prefix);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  for await (const chunk of handle.createReadStream()) hash.update(chunk);
  return hash.digest("hex");
}

const mainSkips = [/^\.claude\/(?:worktrees|\.cc-writes)\//, /^\.claude\/scheduled_tasks\.lock$/];

const snapshotSkips = { files: ignoredSkips, git: [], main: mainSkips };

async function collectFiles(entries: Entries, file: string, key: string, part: keyof Snapshot,
  report: Report, optional = false): Promise<void> {
  const skips = snapshotSkips[part];
  if (skips.some((skip) => skip.test(key))) return;
  const stat = optional ? lstatSync(file, { bigint: true, throwIfNoEntry: false }) :
    lstatSync(file, { bigint: true });
  if (!stat) return;
  if (stat.isDirectory()) {
    if (skips.some((skip) => skip.test(key + "/"))) return;
    for (const bytes of readdirSync(file, { encoding: "buffer" })) {
      const name = decodeName(bytes, report, key + "/");
      if (name !== undefined)
        await collectFiles(entries, join(file, name), key + "/" + name, part, report);
    }
    return;
  }
  let hash: string;
  if (stat.isSymbolicLink()) {
    hash = sha256(readlinkSync(file, { encoding: "buffer" }));
    if (part === "files") hash = "link:" + hash;
  } else if (stat.isFile() && part === "files" && workspaceInstall.test(key)) {
    const parts = [stat.size, stat.mode, stat.ino, stat.dev, stat.nlink,
      stat.mtimeNs, stat.ctimeNs];
    hash = "meta:" + parts.join(":");
  } else if (stat.isFile()) {
    hash = await fileHash(file);
  } else {
    throw new Error(`Cannot snapshot special file ${JSON.stringify(key)}`);
  }
  entries.set(key, part === "git" ? sha256(stat.mode.toString(8) + "\0" + hash) : hash);
}

async function ignoredFiles(cwd: string, report: Report): Promise<Entries> {
  const files: Entries = new Map();
  const roots = git(cwd, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory",
    "-z");
  for (const bytes of nulRecords(roots)) {
    const root = decodeName(bytes, report);
    if (root === undefined) continue;
    const path = root.replace(/\/$/, "");
    await collectFiles(files, join(cwd, path), path, "files", report);
  }
  return files;
}

function configDigest(cwd: string, head: Buffer): string {
  const config = git(cwd, "config", "--list", "--show-origin", "--show-scope", "-z");
  const ref = head.toString("latin1").replace(/\n$/, "");
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) return sha256(config);
  const current = ref.slice(prefix.length);
  // Latin-1 round-trips every byte, including non-UTF-8 values and origin paths.
  const fields = Array.from(nulRecords(config), (bytes) => bytes.toString("latin1"));
  const hash = createHash("sha256");
  for (let i = 0; i < fields.length; i += 3) {
    const [scope, origin, setting] = fields.slice(i, i + 3);
    const newline = setting.indexOf("\n");
    const name = newline < 0 ? setting : setting.slice(0, newline);
    const upstream = /^branch\.(.+)\.(remote|merge)$/s.exec(name);
    if (upstream && upstream[1] !== current && newline >= 0) {
      const expected = upstream[2] === "remote" ? "origin" : prefix + upstream[1];
      if (setting.slice(newline + 1) === expected) continue;
    }
    hash.update(scope + "\0" + origin + "\0" + setting + "\0", "latin1");
  }
  return hash.digest("hex");
}

async function gitSettings(cwd: string, common: string, report: Report): Promise<Entries> {
  const entries: Entries = new Map();
  const head = symbolicHead(cwd);
  entries.set("config", configDigest(cwd, head));
  entries.set("HEAD", sha256(head));
  const refs = git(cwd, "for-each-ref", "--format=%(refname)%00%(objectname)", "refs/replace/");
  entries.set("replace", sha256(refs));
  const hooks = git(cwd, "rev-parse", "--git-path", "hooks").toString().trimEnd();
  const dir = git(cwd, "rev-parse", "--git-dir").toString().trimEnd();
  for (const [key, file] of [
    ["hooks", resolve(cwd, hooks)], ["info", join(common, "info")],
    ["config.worktree", resolve(cwd, dir, "config.worktree")],
  ]) await collectFiles(entries, file, key, "git", report, true);
  return entries;
}

// A tracked directory can have been replaced by a link. Never read through that link.
function pathStat(cwd: string, path: string, directories: Map<string, boolean>) {
  function directory(dir: string): boolean {
    if (dir === ".") return true;
    let exists = directories.get(dir);
    if (exists === undefined) {
      exists = directory(dirname(dir)) &&
        !!lstatSync(join(cwd, dir), { throwIfNoEntry: false })?.isDirectory();
      directories.set(dir, exists);
    }
    return exists;
  }
  if (directory(dirname(path))) return lstatSync(join(cwd, path), { throwIfNoEntry: false });
}

async function mainCheckout(cwd: string, main: string, report: Report): Promise<Entries> {
  const entries: Entries = new Map();
  if (cwd === main) return entries;
  entries.set("HEAD", sha256(Buffer.concat([git(main, "rev-parse", "HEAD"), symbolicHead(main)])));
  const status = git(main, "status", "--porcelain=v2", "-z", "--untracked-files=all");
  const records = [...nulRecords(status)];
  const digest = createHash("sha256");
  const directories = new Map<string, boolean>();
  const pathFields: Record<string, number> = { "1": 8, "2": 9, u: 10, "?": 1 };
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const type = String.fromCharCode(record[0]);
    const fields = pathFields[type];
    if (!fields) throw new Error("Unknown git status record");
    let start = 0;
    for (let field = 0; field < fields; field++) start = record.indexOf(32, start) + 1;
    const names = [record.subarray(start)];
    if (type === "2") names.push(records[++i]);
    const paths = names
      .filter((bytes) => !mainSkips.some((skip) => skip.test(bytes.toString("latin1"))))
      .map((bytes) => decodeName(bytes, report)).filter((path) => path !== undefined);
    if (!paths.length) continue;
    digest.update(record).update("\0");
    if (type === "2") digest.update(names[1]).update("\0");
    for (const p of paths) {
      const stat = pathStat(main, p, directories);
      const file = join(main, p);
      if (stat?.isFile()) digest.update(await fileHash(file));
      else if (stat?.isSymbolicLink()) digest.update(sha256(readlinkSync(file, "buffer")));
      digest.update("\0");
    }
  }
  entries.set("status", digest.digest("hex"));
  const files: Entries = new Map();
  for (const key of ["bin", ".claude", "scripts"])
    await collectFiles(files, join(main, key), key, "main", report, true);
  for (const [path, hash] of files) entries.set("files/" + path, hash);
  return entries;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readSnapshot(file: string, digest: string): Snapshot {
  const bytes = readFileSync(file);
  if (sha256(bytes) !== digest.toLowerCase()) throw new Error("Snapshot sha256 differs");
  const values: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isObject(values) || Object.keys(values).length !== 3) throw new Error("Invalid snapshot");
  const stamp = /^(?:(?:link:)?[0-9a-f]{64}|meta:(?:\d+:){5}-?\d+:-?\d+)$/;
  function part(value: unknown, pattern: RegExp): Entries {
    if (!isObject(value)) throw new Error("Invalid snapshot part");
    const entries: Entries = new Map();
    for (const [key, hash] of Object.entries(value)) {
      if (typeof hash !== "string" || !pattern.test(hash))
        throw new Error("Invalid snapshot value");
      entries.set(key, hash);
    }
    return entries;
  }
  const hash = /^[0-9a-f]{64}$/;
  return { files: part(values.files, stamp), git: part(values.git, hash),
    main: part(values.main, hash) };
}

function differences(before: Entries, after: Entries): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].sort()
    .filter((key) => before.get(key) !== after.get(key));
}

export async function worktreeEntry(file: string, stat: Stats | undefined, format: string) {
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(file, "buffer");
    const hash = createHash(format).update(`blob ${target.length}\0`);
    return "120000 " + hash.update(target).digest("hex");
  }
  if (stat.isFile()) {
    const mode = stat.mode & 0o100 ? "100755" : "100644";
    return mode + " " + await fileHash(file, format, `blob ${stat.size}\0`);
  }
  return "special";
}

async function checkPaths(cwd: string, base: string, restore: Set<string>, remove: Set<string>,
  ownerPaths: Set<string>, report: Report): Promise<Set<string>> {
  const tree: Entries = new Map();
  const index: Entries = new Map();
  const conflicts = new Set<string>();
  const links = new Set<string>();
  const gitlinks = new Set<string>();
  for (const row of nulRecords(git(cwd, "ls-tree", "-r", "-z", "--full-tree", base))) {
    const tab = row.indexOf(9);
    const path = decodeName(row.subarray(tab + 1), report);
    if (path === undefined) continue;
    const [mode, , id] = row.toString("ascii", 0, tab).split(" ");
    tree.set(path, mode + " " + id);
    if (mode === "160000") gitlinks.add(path);
  }
  for (const row of nulRecords(git(cwd, "ls-files", "-s", "-z"))) {
    const tab = row.indexOf(9);
    const path = decodeName(row.subarray(tab + 1), report);
    if (path === undefined) continue;
    const [mode, id, stage] = row.toString("ascii", 0, tab).split(" ");
    index.set(path, mode + " " + id);
    if (stage !== "0") conflicts.add(path);
    if (mode === "120000") links.add(path);
    if (mode === "160000") gitlinks.add(path);
  }
  const others: string[] = [];
  for (const row of nulRecords(git(cwd, "ls-files", "--others", "--exclude-standard", "-z"))) {
    const path = decodeName(row, report);
    if (path === undefined) continue;
    if (path.endsWith("/")) {
      report(path, "nested repository: ");
      ownerPaths.add(path.slice(0, -1));
    } else {
      others.push(path);
    }
  }
  const format = git(cwd, "rev-parse", "--show-object-format").toString().trimEnd();
  const directories = new Map<string, boolean>();
  const trackedPaths = new Set([...tree.keys(), ...index.keys()]);
  for (const path of [...new Set([...trackedPaths, ...others])].sort()) {
    const tracked = trackedPaths.has(path);
    const stat = pathStat(cwd, path, directories);
    const work = tracked ? await worktreeEntry(join(cwd, path), stat, format) : undefined;
    if (tracked && !conflicts.has(path) && index.get(path) === tree.get(path) &&
        work === tree.get(path)) continue;
    if (gitlinks.has(path)) {
      report(path, "gitlink: ");
      ownerPaths.add(path);
      continue;
    }
    if (stat?.isSymbolicLink() || links.has(path)) report(path, "symlink: ");
    else if (!allowed(path)) report(path);
    else continue;
    (tracked ? restore : remove).add(path);
  }
  return trackedPaths;
}

function writeList(snapshot: string, name: string, paths: Set<string>): void {
  const file = join(dirname(snapshot), name);
  rmSync(file, { force: true });
  const bytes = [...paths].sort().map((path) => path + "\0").join("");
  writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
}

function usage(): number {
  console.error("Usage: node scripts/check-ui-scope.ts --snapshot <file> | " +
    "--since <full commit id> [--snapshot <file> --snapshot-sha256 <hex>]");
  return 2;
}

async function main(args: string[]): Promise<number> {
  const fullId = /^(?:[\da-f]{40}|[\da-f]{64})$/i;
  const snapshotOnly = args.length === 2 && args[0] === "--snapshot" && !!args[1];
  const withSnapshot = args.length === 6 && args[2] === "--snapshot" && !!args[3] &&
    args[4] === "--snapshot-sha256" && /^[\da-f]{64}$/i.test(args[5]);
  const since = args[0] === "--since" && fullId.test(args[1]) &&
    (args.length === 2 || withSnapshot);
  if (!snapshotOnly && !since) return usage();
  const cwd = git(process.cwd(), "rev-parse", "--show-toplevel").toString().trimEnd();
  const restore = new Set<string>();
  const remove = new Set<string>();
  const ownerPaths = new Set<string>();
  const findings = new Set<string>();
  function report(path: string, prefix = "") {
    const raw = /^[A-Za-z0-9._@+/-]+$/.test(path) && !path.startsWith("-");
    const line = prefix + (raw ? path : JSON.stringify(path));
    if (!findings.has(line)) console.log(line);
    findings.add(line);
  }
  const before = withSnapshot ? readSnapshot(args[3], args[5]) : undefined;
  for (const row of nulRecords(git(cwd, "ls-files", "-v", "-z"))) {
    const path = decodeName(row.subarray(2), report);
    if (path !== undefined && /^[a-zS] /.test(row.toString("ascii", 0, 2))) {
      report(path, "index flag: ");
      restore.add(path);
    }
  }
  if (snapshotOnly && findings.size) return 1;
  let tracked = new Set<string>();
  if (since) {
    const base = args[1].toLowerCase();
    try {
      if (git(cwd, "rev-parse", "--verify", `${base}^{commit}`).toString().trim() !== base)
        return usage();
    } catch {
      return usage();
    }
    const head = git(cwd, "rev-parse", "HEAD").toString().trimEnd();
    if (head !== base) report(head, "head moved: ");
    tracked = await checkPaths(cwd, base, restore, remove, ownerPaths, report);
  }
  const snapshot = snapshotOnly ? args[1] : args[3];
  if (snapshot) {
    const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
      .toString().trimEnd();
    const main = dirname(common);
    const settings = await gitSettings(cwd, common, report);
    const files = await ignoredFiles(cwd, report);
    if (snapshotOnly) {
      const checkout = await mainCheckout(cwd, main, report);
      if (findings.size) return 1;
      const bytes = JSON.stringify({
        files: Object.fromEntries(files), git: Object.fromEntries(settings),
        main: Object.fromEntries(checkout),
      });
      writeFileSync(snapshot, bytes, { flag: "wx", mode: 0o600 });
      console.log("snapshot sha256: " + sha256(bytes));
    } else if (before) {
      const changedSettings = differences(before.git, settings);
      for (const key of changedSettings) report(key, "git changed: ");
      if (!changedSettings.length) {
        for (const key of differences(before.main, await mainCheckout(cwd, main, report)))
          report(key, "main changed: ");
      }
      for (const path of differences(before.files, files)) {
        if (!before.files.has(path)) {
          report(path, "ignored new: ");
          (tracked.has(path) ? restore : remove).add(path);
        } else {
          report(path, files.has(path) ? "ignored changed: " : "ignored removed: ");
          if (tracked.has(path)) restore.add(path);
        }
      }
      for (const path of ownerPaths) {
        restore.delete(path);
        remove.delete(path);
      }
      writeList(snapshot, "restore.nul", restore);
      writeList(snapshot, "delete.nul", remove);
    }
  }
  return findings.size ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error("Could not check UI scope:", error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
