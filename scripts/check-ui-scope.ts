import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants, lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join, posix } from "node:path";

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
  /^apps\/[^/]+\/dist\//,
  /^\.wt\/ui\//,
  /^\.wt\/ui-demo\.json(?:\.[^/]*)?$/,
  /^\.claude\/scheduled_tasks\.lock$/,
];

async function ignoredFiles(cwd: string, roots: string[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(path: string) {
    if (ignoredSkips.some((skip) => skip.test(path))) return;
    const file = join(cwd, path);
    const stat = lstatSync(file, { bigint: true });
    if (stat.isDirectory()) {
      if (ignoredSkips.some((skip) => skip.test(path + "/"))) return;
      for (const entry of readdirSync(file)) await walk(path + "/" + entry);
    } else if (stat.isSymbolicLink()) {
      const target = readlinkSync(file, { encoding: "buffer" });
      files.set(path, "link:" + createHash("sha256").update(target).digest("hex"));
    } else if (stat.isFile() && workspaceInstall.test(path)) {
      files.set(path, `meta:${stat.size}:${stat.mode}:${stat.ino}:${stat.mtimeNs}`);
    } else if (stat.isFile()) {
      const hash = createHash("sha256");
      const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
      const handle = await open(file, flags);
      for await (const chunk of handle.createReadStream()) hash.update(chunk);
      files.set(path, hash.digest("hex"));
    } else {
      throw new Error(`Cannot snapshot special file ${JSON.stringify(path)}`);
    }
  }
  for (const root of roots) await walk(root.replace(/\/$/, ""));
  return files;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readSnapshot(file: string, digest: string): Map<string, string> {
  const bytes = readFileSync(file);
  if (sha256(bytes) !== digest.toLowerCase()) throw new Error("Ignored snapshot sha256 differs");
  const values = JSON.parse(bytes.toString("utf8"));
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("Invalid ignored file snapshot");
  const files = new Map<string, string>();
  const stamp = /^(?:(?:link:)?[0-9a-f]{64}|meta:\d+:\d+:\d+:-?\d+)$/;
  for (const [path, hash] of Object.entries(values)) {
    if (typeof hash !== "string" || !stamp.test(hash))
      throw new Error("Invalid digest in ignored file snapshot");
    files.set(path, hash);
  }
  return files;
}

const splitPaths = (output: string) => output.split("\0").filter(Boolean);

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
  let cwd = process.cwd();
  const git = (args: string[]) => execFileSync("git", [
    "--no-replace-objects", "-c", "core.fsmonitor=false", ...args,
  ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  cwd = git(["rev-parse", "--show-toplevel"]).trimEnd();

  let violations = false;
  function report(path: string, prefix = "") {
    console.log(prefix + (/[\r\n]/.test(path) ? JSON.stringify(path) : path));
    violations = true;
  }
  const before = withSnapshot ? readSnapshot(args[3], args[5]) : undefined;
  for (const entry of splitPaths(git(["ls-files", "-v", "-z"])))
    if (/^[a-zS] /.test(entry)) report(entry.slice(2), "index flag: ");
  if (snapshotOnly && violations) return 1;
  if (since) {
    const base = args[1].toLowerCase();
    try {
      if (git(["rev-parse", "--verify", `${base}^{commit}`]).trim() !== base) return usage();
    } catch {
      return usage();
    }
    const diff = ["diff", "--name-only", "--no-renames", "-z"];
    // The index can still differ even when the working copy matches the base again.
    const paths = git([...diff, base, "--"]) + git([...diff, "--cached", base, "--"]) +
      git(["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const path of outsideScope(splitPaths(paths))) report(path);
  }
  const snapshot = snapshotOnly ? args[1] : args[3];
  if (snapshot) {
    const roots = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory",
      "-z"]);
    const current = await ignoredFiles(cwd, splitPaths(roots));
    if (snapshotOnly) {
      const bytes = JSON.stringify(Object.fromEntries(current));
      writeFileSync(snapshot, bytes, { flag: "wx", mode: 0o600 });
      console.log("snapshot sha256: " + sha256(bytes));
    } else if (before) {
      for (const path of [...new Set([...before.keys(), ...current.keys()])].sort()) {
        if (!before.has(path)) report(path, "ignored new: ");
        else if (!current.has(path)) report(path, "ignored removed: ");
        else if (before.get(path) !== current.get(path)) report(path, "ignored changed: ");
      }
    }
  }
  return violations ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error("Could not check UI scope:", error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
