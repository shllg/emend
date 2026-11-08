import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export type Exit = 0 | 1 | 2 | 3 | 69 | 124;

export const BRANCH_PREFIX = "emend-";
export const TASK_BRANCH_PREFIX = "emend-task-";

/** A failure with an exit code. The message never contains a refused argument. */
export class WtError extends Error {
  code: Exit;
  constructor(code: Exit, message: string) {
    super(message);
    this.name = "WtError";
    this.code = code;
  }
}

const BRANCH_RE = /^[a-z0-9][a-z0-9._/-]{0,62}$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+){1,4}$/;
const PR_RE = /^[1-9][0-9]{0,6}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const TASK_RE = /^[0-9]{3}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

function invalid(what: string): never {
  throw new WtError(2, `Invalid ${what}.`);
}

/** A branch bin/wt may create or use: never `main`, and a name git accepts as a ref. */
export function branchName(s: string): string {
  if (typeof s !== "string" || !BRANCH_RE.test(s) || s === "main") invalid("branch name");
  if (s.includes("..") || s.includes("//") || s.endsWith("/") || s.endsWith(".")) invalid("branch name");
  for (const part of s.split("/")) {
    if (part.startsWith(".") || part.endsWith(".lock")) invalid("branch name");
  }
  return s;
}

/** A start point: a branch, a remote branch, a tag or a full or short commit id. */
export function refName(s: string): string {
  if (typeof s !== "string" || !REF_RE.test(s)) invalid("ref");
  if (s.includes("..") || s.includes("//") || s.endsWith("/") || s.endsWith(".") || s.endsWith(".lock")) invalid("ref");
  return s;
}

export function slug(s: string): string {
  if (typeof s !== "string" || !SLUG_RE.test(s)) invalid("slug");
  return s;
}

export function prNumber(s: string): number {
  if (typeof s !== "string" || !PR_RE.test(s)) invalid("pull request number");
  return Number(s);
}

export function issueNumber(s: string): number {
  if (typeof s !== "string" || !/^[1-9][0-9]*$/.test(s) || !Number.isSafeInteger(Number(s))) invalid("issue number");
  return Number(s);
}

/** Explicit task namespace plus legacy task branches; unpadded issue numbers never match. */
export function taskFromBranch(branch: string): string | null {
  const name = branch.startsWith(TASK_BRANCH_PREFIX)
    ? branch.slice(TASK_BRANCH_PREFIX.length)
    : branch.startsWith(BRANCH_PREFIX)
      ? branch.slice(BRANCH_PREFIX.length)
      : branch;
  const number = /^(0\d{2})-[a-z0-9][a-z0-9._-]*$/.exec(name)?.[1];
  return number && Number(number) > 0 && Number(number) < 99 ? number : null;
}

export function commitSha(s: string): string {
  if (typeof s !== "string" || !SHA_RE.test(s)) invalid("commit id");
  return s;
}

/** A three-digit task number, 001 to 098. */
export function taskNumber(s: string): string {
  if (typeof s !== "string" || !TASK_RE.test(s)) invalid("task number");
  const n = Number(s);
  if (n < 1 || n > 98) invalid("task number");
  return s;
}

const MAX_TEXT_FILE_BYTES = 1024 * 1024;

/**
 * Free text from `--x <text>` or `--x-file <path>`. Returns the text, or the UTF-8 contents of the file (a
 * regular file of at most 1 MiB). Exit 2 when both are given, or when neither is given and `required` is set.
 * Returns null when neither is given and the text is optional.
 */
export function textArg(
  text: string | undefined,
  file: string | undefined,
  label: string,
  required: boolean,
): string | null {
  if (text !== undefined && file !== undefined) {
    throw new WtError(2, `Give --${label} or --${label}-file, not both.`);
  }
  if (text !== undefined) return text;
  if (file === undefined) {
    if (required) throw new WtError(2, `Give --${label} or --${label}-file.`);
    return null;
  }
  try {
    return readTextFile(file);
  } catch {
    throw new WtError(2, `The --${label}-file must be a readable regular UTF-8 file of at most 1 MiB (no symlinks).`);
  }
}

/** Bound the read itself, even if a file grows after fstat. Never open a FIFO or follow a leaf symlink. */
export function readFileBytes(file: string, max = MAX_TEXT_FILE_BYTES): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) throw new Error("not a bounded regular file");
    const bytes = Buffer.alloc(max + 1);
    let size = 0;
    for (;;) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      size += n;
      if (size > max) throw new Error("file too large");
      if (n === 0) return bytes.subarray(0, size);
    }
  } finally {
    closeSync(fd);
  }
}

export function readTextFile(file: string, max = MAX_TEXT_FILE_BYTES): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileBytes(file, max));
}

export function issueFromBranch(branch: string): number | null {
  const n = /^emend-([1-9][0-9]*)-/.exec(branch)?.[1];
  // A name discovered among claims is data, not an explicit issue-number argument.
  // Keep user input strict while treating unparseable branch numbers as no inferred issue.
  return n !== undefined && Number.isSafeInteger(Number(n)) ? Number(n) : null;
}

/** Numeric emend names are reserved for explicitly registered issues, including padded numbers. */
export function requireIssueBranch(branch: string, issue?: number): void {
  if (/^emend-[0-9]+-/u.test(branch) && issue === undefined)
    throw new WtError(2, "Numeric emend branch names require --issue; use emend-task- names for tasks.");
  if (issue !== undefined && issueFromBranch(branch) !== issue)
    throw new WtError(2, "The branch number must match --issue.");
}

/** Local state must be a regular file inside a real .wt directory. */
export function readWtJson(top: string, name: string): Record<string, unknown> {
  const dir = join(top, ".wt");
  if (!lstatSync(dir).isDirectory()) throw new Error("not a directory");
  const info: unknown = JSON.parse(
    readTextFile(join(dir, name), name === "worktree.json" ? 65_536 : MAX_TEXT_FILE_BYTES),
  );
  if (typeof info !== "object" || info === null || Array.isArray(info)) throw new Error("invalid metadata");
  return info as Record<string, unknown>;
}

export function worktreeIssue(top: string): number | null {
  try {
    const issue = readWtJson(top, "worktree.json").issue;
    if (issue === undefined || issue === null) return null;
    if (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue < 1) throw new Error("invalid issue");
    return issue;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WtError(2, "Could not read .wt/worktree.json.");
  }
}

export type FlagSpec = Record<string, "boolean" | "string">;

export interface ParsedFlags {
  flags: Record<string, string | boolean | undefined>;
  positionals: string[];
}

/** Flags whose value is free text: the next argument is taken verbatim, even when it starts with `-`. */
const VERBATIM_FLAGS = new Set(["title", "subject", "body", "brief"]);

/** One line of 1 to 72 characters, without control characters. A single final newline is dropped. */
export function oneLine(text: string, what: string): string {
  const line = text.replace(/\r?\n$/, "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(line))
    throw new WtError(2, `The ${what} must be a single line.`);
  if (/\p{Cf}/u.test(line)) throw new WtError(2, `The ${what} must not contain invisible formatting characters.`);
  const length = [...line].length;
  if (length < 1 || length > 72) throw new WtError(2, `The ${what} must be 1 to 72 characters.`);
  return line;
}

/**
 * Parses `--name`, `--name value` and `--name=value`. Anything else that starts with `-` is refused,
 * as is a repeated flag, a missing value, a value that looks like a flag and too many positionals.
 * The free-text flags (`--title`, `--subject`, `--body`, `--brief`) take the next argument verbatim.
 * A refusal names the option, never its value.
 */
export function parseFlags(args: string[], spec: FlagSpec, maxPositionals = 0): ParsedFlags {
  const flags: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  const bad = (what: string): never => {
    throw new WtError(2, `${what}.`);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const shown = `--${name.slice(0, 40)}`;
      if (!Object.hasOwn(spec, name)) bad(`Unknown option ${shown}`);
      if (flags[name] !== undefined) bad(`Option ${shown} given twice`);
      if (spec[name] === "boolean") {
        if (eq !== -1) bad(`Option ${shown} takes no value`);
        flags[name] = true;
      } else if (eq !== -1) {
        flags[name] = arg.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next === undefined || (next.startsWith("-") && !VERBATIM_FLAGS.has(name))) {
          bad(`Option ${shown} needs a value`);
        }
        flags[name] = next;
        i++;
      }
    } else if (arg.startsWith("-")) {
      bad("Unknown or malformed option");
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > maxPositionals) bad("Unexpected argument");
  return { flags, positionals };
}
