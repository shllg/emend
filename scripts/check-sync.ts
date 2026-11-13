// Checks that branch commits touching a shared surface carry a `Sync:` trailer (AGENTS.md,
// "Sync with hunk-review-skill"). It never reads the other repo and needs no network.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SyncResult {
  errors: string[];
  notes: string[];
  summary: string;
}

const SYNC_FORMATS = [
  "Sync: hunk-review-skill@<sha>",
  "Sync: none — <reason>",
  "Sync: pending hunk-review-skill <task>",
];

export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (c === "?") {
      source += "[^/]";
    } else {
      source += c.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function isValidSyncTrailer(value: string): boolean {
  const v = value.trim();
  return (
    /^hunk-review-skill@[0-9a-f]{7,40}$/.test(v) ||
    /^none\s+(?:—|--|-)\s+\S/.test(v) ||
    /^pending hunk-review-skill\s+\S/.test(v)
  );
}

/**
 * The `Sync:` values in a commit message's last paragraph. git reads a paragraph as trailers only
 * when every line has the `Key: value` form, so a `Closes #12` line above `Sync:` hides it from
 * `%(trailers)`. This fallback still finds it there, and nowhere else in the message.
 */
export function lastParagraphSyncValues(message: string): string[] {
  const paragraphs = message
    .trim()
    .split(/\n[ \t]*\n/)
    .filter((paragraph) => paragraph.trim() !== "");
  const last = paragraphs.at(-1) ?? "";
  return last
    .split("\n")
    .map((line) => /^Sync:(.*)$/.exec(line.trim())?.[1])
    .filter((value): value is string => value !== undefined);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function resolves(cwd: string, ref: string): boolean {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the `self` globs from sync/manifest.json. Returns an error message for a bad manifest.
 * The manifest comes from the working tree, not from each commit, so today's globs apply to every
 * branch commit. That is deliberate: a commit that predates a glob still has to carry a trailer.
 */
function manifestGlobs(cwd: string): { globs: RegExp[] } | { error: string } {
  const file = path.join(cwd, "sync", "manifest.json");
  if (!existsSync(file)) return { globs: [] };
  const bad = "sync/manifest.json is invalid:";
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { error: `${bad} not valid JSON (${(error as Error).message})` };
  }
  const surfaces = (manifest as { surfaces?: unknown } | null)?.surfaces;
  if (!Array.isArray(surfaces)) return { error: `${bad} "surfaces" must be an array` };
  const globs: RegExp[] = [];
  for (const surface of surfaces) {
    const self = (surface as { self?: unknown } | null)?.self;
    if (
      typeof surface !== "object" ||
      surface === null ||
      !Array.isArray(self) ||
      !self.every((glob) => typeof glob === "string")
    ) {
      return { error: `${bad} every surface needs "self" as an array of strings` };
    }
    for (const glob of self as string[]) globs.push(globToRegExp(glob));
  }
  return { globs };
}

function uncommittedFiles(cwd: string): string[] {
  const out = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = out.split("\0").filter((entry) => entry !== "");
  const files: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    files.push(entry.slice(3));
    // A rename or copy lists the origin path as the next entry. Both paths count.
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      i += 1;
      if (entries[i] !== undefined) files.push(entries[i]);
    }
  }
  return files;
}

export function checkSync(opts: { cwd: string; base?: string }): SyncResult {
  const { cwd } = opts;
  const errors: string[] = [];
  const notes: string[] = [];

  const unborn = !resolves(cwd, "HEAD");
  const manifest = manifestGlobs(cwd);
  if ("error" in manifest) return { errors: [manifest.error], notes, summary: "" };
  const isShared = (file: string): boolean =>
    file.startsWith("sync/") || manifest.globs.some((re) => re.test(file));

  const pending = (): void => {
    const files = uncommittedFiles(cwd).filter(isShared);
    if (files.length > 0) {
      notes.push(
        `note: uncommitted changes touch shared surfaces (${files.join(", ")}); their commit needs a Sync: trailer`,
      );
    }
  };
  if (unborn) {
    // No commits yet, so there is nothing to check.
    pending();
    return { errors, notes, summary: "check:sync ok: 0 commits (no commits yet), 0 touch shared surfaces" };
  }

  const explicit = opts.base ?? process.env.SYNC_BASE;
  let base: string | undefined;
  if (explicit) {
    base = resolves(cwd, explicit) ? explicit : undefined;
  } else if (resolves(cwd, "origin/main")) {
    base = "origin/main";
  } else if (resolves(cwd, "main")) {
    base = "main";
  }
  if (base === undefined) {
    return { errors: ["cannot find the branch base: set SYNC_BASE to the branch base"], notes, summary: "" };
  }

  const shas = git(cwd, ["rev-list", "--no-merges", `${base}..HEAD`])
    .split("\n")
    .filter((sha) => sha !== "");
  let touching = 0;
  for (const sha of shas) {
    const files = git(cwd, ["diff-tree", "-z", "--no-commit-id", "--name-only", "-r", "--root", sha])
      .split("\0")
      .filter((file) => file !== "");
    const shared = files.filter(isShared);
    if (shared.length === 0) continue;
    touching += 1;
    const trailers = git(cwd, ["log", "-1", "--format=%(trailers:key=Sync,valueonly)", sha])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (trailers.some(isValidSyncTrailer)) continue;
    const message = git(cwd, ["log", "-1", "--format=%B", sha]);
    if (lastParagraphSyncValues(message).some(isValidSyncTrailer)) continue;
    const subject = git(cwd, ["log", "-1", "--format=%s", sha]).trim();
    const listed = shared.slice(0, 5).join(", ");
    const more = shared.length > 5 ? ` and ${shared.length - 5} more` : "";
    errors.push(
      [
        `${sha.slice(0, 7)} ${subject}`,
        `  touches shared surfaces: ${listed}${more}`,
        "  needs one Sync: trailer in one of these forms:",
        ...SYNC_FORMATS.map((format) => `    ${format}`),
      ].join("\n"),
    );
  }

  pending();

  const summary = `check:sync ok: ${shas.length} commits since ${base}, ${touching} touch shared surfaces`;
  return { errors, notes, summary };
}

function main(): void {
  const cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const { errors, notes, summary } = checkSync({ cwd });
  for (const note of notes) console.log(note);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(summary);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
