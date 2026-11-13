// Plans releases from shipped commits, stamps the temporary build and writes release manifests.
// GitHub Actions owns verification, tagging, publishing and the release branch.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export class ReleaseError extends Error {}
class UsageError extends Error {}

export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;
const VERSION_VALUE = /("version"\s*:\s*")([^"]*)(")/;
const VERSION_SOURCE = "apps/emend/src/version.ts";
const PLUGIN_MANIFEST = "plugin/.claude-plugin/plugin.json";
const MARKETPLACE_MANIFEST = ".claude-plugin/marketplace.json";

// Directories include everything below them; the other entries name exact root-relative files.
export const SHIPPED_PATHS = [
  "apps/emend/",
  "apps/web/",
  "packages/",
  "plugin/",
  ".claude-plugin/",
  "README.md",
  "LICENSE",
  "docs/setup.md",
  "docs/setup/",
  "docs/usage.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".pnpmfile.mjs",
] as const;

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    throw new ReleaseError(`release: git ${args[0]} failed`);
  }
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(BigInt);
  const right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0n) - (right[i] ?? 0n);
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return 0;
}

// "Newest" means the highest plain v<x.y.z> tag merged into ref. Prerelease or odd tags and tags
// on other branches do not count. No tags is an empty list; a git failure refuses the release.
function mergedTags(root: string, ref: string): string[] {
  let listing: string;
  try {
    listing = git(root, ["tag", "--merged", ref, "--list", "v*"]);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new ReleaseError(`release: could not list tags (${reason})`);
  }
  return listing
    .split("\n")
    .filter((tag) => tag.startsWith("v") && VERSION_PATTERN.test(tag.slice(1)))
    .sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
}

export function lastTag(root: string, ref = "HEAD"): string | undefined {
  return mergedTags(root, ref)[0];
}

function topLevelVersion(text: string, file: string): unknown {
  try {
    return (JSON.parse(text) as { version?: unknown }).version;
  } catch {
    throw new ReleaseError(`release: ${file} is not valid JSON`);
  }
}

// Changes only the first "version" value, so key order, indentation and the final newline stay.
// It returns the new text and refuses unless the top-level version is now the target, so a nested
// "version" key that comes first is never mistaken for it.
export function bumpedVersionText(root: string, file: string, version: string): string {
  const text = readFileSync(join(root, file), "utf8");
  const bumped = text.replace(VERSION_VALUE, (_all, open, _old, close) => `${open}${version}${close}`);
  if (topLevelVersion(bumped, file) !== version) {
    throw new ReleaseError(`release: could not set the top-level version in ${file}`);
  }
  return bumped;
}

export function versionedManifestText(text: string, file: string, version: string): string {
  let original: unknown;
  try {
    original = JSON.parse(text);
  } catch {
    throw new ReleaseError(`release: ${file} is not valid JSON`);
  }
  const failure = `release: could not set the top-level version in ${file}`;
  if (!original || typeof original !== "object" || Array.isArray(original)) throw new ReleaseError(failure);
  if (Object.hasOwn(original, "version")) throw new ReleaseError(`release: ${file} must carry no version`);
  const stamped = text.replace(
    /(\r?\n[ \t]*|[ \t]*)"name"\s*:\s*"(?:[^"\\]|\\.)*"/,
    (name, whitespace) => `${name},${whitespace}"version": ${JSON.stringify(version)}`,
  );
  try {
    if (isDeepStrictEqual(JSON.parse(stamped), { ...original, version })) return stamped;
  } catch {
    // A match inside a string must never produce a damaged manifest.
  }
  throw new ReleaseError(failure);
}

export function stampPluginManifests(root: string, commit: string, version: string, outDir: string): void {
  if (!VERSION_PATTERN.test(version)) throw new ReleaseError("release: version must be plain x.y.z");
  const [plugin, marketplace] = [PLUGIN_MANIFEST, MARKETPLACE_MANIFEST].map((file) => {
    let text: string;
    try {
      text = git(root, ["show", `${commit}:${file}`]);
    } catch {
      throw new ReleaseError(`release: could not read ${file} at ${commit}`);
    }
    return versionedManifestText(text, file, version);
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "plugin.json"), plugin);
  writeFileSync(join(outDir, "marketplace.json"), marketplace);
}

const VERSION_LINE = /^(export const VERSION = ")([^"\r\n]*)(";)(?=\r?$)/gm;

// Replaces only the string literal in the single `export const VERSION = "<x>";` line.
export function bumpedSourceText(root: string, file: string, version: string): string {
  const text = readFileSync(join(root, file), "utf8");
  if ((text.match(VERSION_LINE) ?? []).length !== 1) {
    throw new ReleaseError(`release: ${file} must have exactly one 'export const VERSION = "...";' line`);
  }
  const bumped = text.replace(VERSION_LINE, (_all, open, _old, close) => `${open}${version}${close}`);
  if (!bumped.includes(`export const VERSION = "${version}";`)) {
    throw new ReleaseError(`release: could not set the version in ${file}`);
  }
  return bumped;
}

export function localDate(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

interface Entry {
  group: "breaking" | "feat" | "fix" | "perf";
  line: string;
}

const GROUPS: [Entry["group"], string][] = [
  ["breaking", "Breaking changes"],
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
];

export function classifyCommit(subject: string, body: string): Entry | undefined {
  const match = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject.trim());
  if (!match)
    return /^BREAKING[ -]CHANGE:/m.test(body) ? { group: "breaking", line: `- ${subject.trim()}` } : undefined;
  const [, type = "", scope, bang, summary = ""] = match;
  const line = `- ${summary.trim()}${scope ? ` (${scope})` : ""}`;
  if (bang || /^BREAKING[ -]CHANGE:/m.test(body)) return { group: "breaking", line };
  if (type === "feat" || type === "fix" || type === "perf") return { group: type, line };
}

export interface Commit {
  subject: string;
  body: string;
}

function countedCommits(root: string, previous: string, end = "HEAD"): Commit[] {
  const log = git(root, ["log", "--no-merges", `${previous}..${end}`, "--format=%H%x00%s%x00%b%x00"]);
  const fields = log.split("\0");
  const commits: Commit[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const sha = fields[i].trim();
    const subject = fields[i + 1];
    const body = fields[i + 2];
    if (/^(test|ci)(?:\([^)]*\))?!?:/.test(subject)) continue;
    // Disable rename detection so moving a file out of a shipped path still counts.
    const paths = git(root, [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "--no-renames",
      "-r",
      "-z",
      sha,
    ]).split("\0");
    if (
      paths.some((path) =>
        SHIPPED_PATHS.some((shipped) => (shipped.endsWith("/") ? path.startsWith(shipped) : path === shipped)),
      )
    )
      commits.push({ subject, body });
  }
  return commits;
}

export function changelogSection(version: string, date: string, commits: Commit[]): string {
  const heading = `## ${version} (${date})`;
  const entries = commits.flatMap(({ subject, body }) => classifyCommit(subject, body) ?? []);
  if (entries.length === 0) return `${heading}\n\nMaintenance release.\n`;
  const blocks = GROUPS.flatMap(([group, title]) => {
    const lines = entries.filter((entry) => entry.group === group).map((entry) => entry.line);
    return lines.length === 0 ? [] : [`### ${title}\n\n${lines.join("\n")}\n`];
  });
  return `${heading}\n\n${blocks.join("\n")}`;
}

export function stampVersion(root: string, version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new ReleaseError("release: version must be plain x.y.z");
  // Validate both replacements before writing either file.
  const manifest = bumpedVersionText(root, "apps/emend/package.json", version);
  const source = bumpedSourceText(root, VERSION_SOURCE, version);
  writeFileSync(join(root, "apps/emend/package.json"), manifest);
  writeFileSync(join(root, VERSION_SOURCE), source);
}

type Bump = "auto" | "patch" | "minor";
interface PlanOptions {
  root: string;
  bump?: Bump;
  notes?: string;
  date?: string;
  output?: string;
  stdout?: (line: string) => void;
  isPublished?: (version: string) => Promise<boolean>;
  releaseRef?: string;
}

export async function isPublished(version: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`https://registry.npmjs.org/@shllg%2Femend/${encodeURIComponent(version)}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
  } catch {
    throw new ReleaseError(`release: could not check npm for @shllg/emend@${version}`);
  }
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  throw new ReleaseError(`release: npm returned HTTP ${response.status} for @shllg/emend@${version}`);
}

function releaseCommit(root: string, ref: string): string {
  try {
    return git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  } catch {
    throw new ReleaseError(`release: release ref ${ref} is missing or invalid`);
  }
}

export function releaseSource(root: string, released: string): string {
  if (!git(root, ["ls-tree", "--name-only", released, "--", PLUGIN_MANIFEST]).trim()) {
    throw new ReleaseError(`release: ${PLUGIN_MANIFEST} is missing at ${released}`);
  }
  const text = git(root, ["show", `${released}:${PLUGIN_MANIFEST}`]);
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new ReleaseError(`release: ${PLUGIN_MANIFEST} at ${released} is not valid JSON`);
  }
  if (manifest && typeof manifest === "object" && !Array.isArray(manifest) && Object.hasOwn(manifest, "version")) {
    const version = (manifest as { version: unknown }).version;
    if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
      throw new ReleaseError(`release: ${PLUGIN_MANIFEST} at ${released} must carry a plain x.y.z version`);
    }
    // Stamp commits keep the tagged source first and the previous stamp second for fast-forward moves.
    try {
      return git(root, ["rev-parse", "--verify", `${released}^1^{commit}`]).trim();
    } catch {
      throw new ReleaseError(`release: stamp commit ${released} has no first parent`);
    }
  }
  return released;
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!result.error && result.status === 0) return true;
  if (!result.error && result.status === 1) return false;
  throw new ReleaseError(`release: could not check whether ${ancestor} is an ancestor of ${descendant}`);
}

export async function plan(options: PlanOptions) {
  const { root, bump = "auto", notes, date = localDate(), output } = options;
  const out = options.stdout ?? (() => {});
  const newest = lastTag(root);
  if (!newest) throw new ReleaseError("release: no plain v<x.y.z> tag is merged into HEAD");
  const taggedSha = git(root, ["rev-parse", "--verify", `refs/tags/${newest}^{commit}`]).trim();
  const releaseRef = options.releaseRef ?? "refs/remotes/origin/release";
  const released = releaseCommit(root, releaseRef);
  const source = releaseSource(root, released);
  const contained = isAncestor(root, taggedSha, released);
  const requireCurrentRelease = (sha: string) => {
    if (!isAncestor(root, source, sha)) {
      throw new ReleaseError(`release: ${releaseRef} is ahead of or diverged from ${sha}; refusing a stale release`);
    }
  };
  const checkPublished = async (version: string) => {
    try {
      return await (options.isPublished ?? isPublished)(version);
    } catch (error) {
      if (error instanceof ReleaseError) throw error;
      throw new ReleaseError(`release: could not check npm for @shllg/emend@${version}`);
    }
  };
  const published = await checkPublished(newest.slice(1));
  if (!published || !contained) {
    requireCurrentRelease(taggedSha);
    if (!published && contained) {
      throw new ReleaseError(`release: release already holds ${newest}'s commit but npm lacks ${newest.slice(1)}`);
    }
    if (!published && git(root, ["rev-parse", "HEAD"]).trim() !== taggedSha) {
      throw new ReleaseError(
        `release: ${newest} is tagged but not on npm; publish it from a run at its commit (re-run the failed jobs of the run that tagged it) or push a higher lightweight tag at main's HEAD and start the workflow`,
      );
    }
    const previous = mergedTags(root, "HEAD").find((tag) => compareVersions(tag.slice(1), newest.slice(1)) < 0);
    if (!previous) throw new ReleaseError(`release: cannot resume ${newest}: no earlier plain tag is merged into HEAD`);
    const version = newest.slice(1);
    const sha = taggedSha;
    const section = changelogSection(version, date, countedCommits(root, previous, sha));
    if (notes) writeFileSync(notes, section);
    if (output)
      appendFileSync(output, `release=true\nresume=true\nversion=${version}\nprevious=${previous}\nsha=${sha}\n`);
    const ignored = bump === "auto" ? "" : `; --bump ${bump} ignored when resuming`;
    out(`release: resumes ${newest} at ${sha} since ${previous}${ignored}`);
    return { release: true as const, resume: true, version, previous, sha, section };
  }
  const previous = newest;
  const commits = countedCommits(root, previous);
  if (commits.length === 0) {
    out(`release: nothing to release since ${previous}`);
    if (output) appendFileSync(output, "release=false\n");
    return { release: false as const, previous };
  }
  const sha = git(root, ["rev-parse", "HEAD"]).trim();
  requireCurrentRelease(sha);
  const breaking = commits.some(({ subject, body }) => classifyCommit(subject, body)?.group === "breaking");
  if (bump === "patch" && breaking) throw new ReleaseError("release: a breaking change requires a minor bump");
  const minor =
    bump === "minor" ||
    (bump === "auto" && (breaking || commits.some(({ subject }) => /^feat(?:\([^)]*\))?!?:/.test(subject))));
  const [major, oldMinor, patch] = previous.slice(1).split(".").map(BigInt);
  const version = minor ? `${major}.${oldMinor + 1n}.0` : `${major}.${oldMinor}.${patch + 1n}`;
  if (git(root, ["tag", "--list", `v${version}`]).trim()) {
    throw new ReleaseError(`release: the tag v${version} already exists`);
  }
  if (await checkPublished(version)) throw new ReleaseError(`release: npm already has ${version}`);
  const contract = readFileSync(join(root, "packages/contract/src/api.ts"), "utf8");
  const minimum = /^export const MIN_CLIENT_VERSION = "([^"]+)";/m.exec(contract)?.[1];
  if (!minimum || !VERSION_PATTERN.test(minimum)) {
    throw new ReleaseError("release: MIN_CLIENT_VERSION must be a plain version");
  }
  if (compareVersions(minimum, version) > 0) {
    throw new ReleaseError(`release: MIN_CLIENT_VERSION ${minimum} is greater than ${version}`);
  }
  if (!git(root, ["tag", "--merged", "HEAD", "--list", `v${minimum}`]).trim()) {
    throw new ReleaseError(`release: MIN_CLIENT_VERSION ${minimum} must name an already-released version`);
  }
  const section = changelogSection(version, date, commits);
  if (notes) writeFileSync(notes, section);
  if (output)
    appendFileSync(output, `release=true\nresume=false\nversion=${version}\nprevious=${previous}\nsha=${sha}\n`);
  out(
    `release: ${version} (${minor ? "minor" : "patch"}), ${commits.length} shipped commit(s) since ${previous} at ${sha}`,
  );
  return { release: true as const, resume: false, version, previous, sha, section };
}

type Command =
  | { command: "plan"; bump: Bump; notes?: string }
  | { command: "stamp"; version: string }
  | { command: "manifests"; version: string; commit: string; outDir: string };
const USAGE =
  "Usage: node scripts/release.ts plan [--bump auto|patch|minor] [--notes <file>] | stamp <x.y.z> | manifests <x.y.z> <commit> <dir>";

export function parseArgs(args: string[]): Command {
  if (args[0] === "stamp" && args.length === 2 && !args[1].startsWith("-")) {
    return { command: "stamp", version: args[1] };
  }
  if (args[0] === "manifests" && args.length === 4 && args.slice(1).every((arg) => !arg.startsWith("-"))) {
    return { command: "manifests", version: args[1], commit: args[2], outDir: args[3] };
  }
  if (args[0] !== "plan") throw new UsageError(USAGE);
  let bump: Bump = "auto";
  let notes: string | undefined;
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!value || value.startsWith("-") || seen.has(flag)) throw new UsageError(USAGE);
    seen.add(flag);
    if (flag === "--bump" && (value === "auto" || value === "patch" || value === "minor")) bump = value;
    else if (flag === "--notes") notes = value;
    else throw new UsageError(USAGE);
  }
  return { command: "plan", bump, notes };
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === "stamp") stampVersion(root, args.version);
    else if (args.command === "manifests") stampPluginManifests(root, args.commit, args.version, args.outDir);
    else await plan({ root, ...args, output: process.env.GITHUB_OUTPUT, stdout: console.log });
  } catch (error) {
    const message = error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error);
    console.error(error instanceof UsageError || message.startsWith("release:") ? message : `release: ${message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
