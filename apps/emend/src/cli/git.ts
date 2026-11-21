import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { LIMITS } from "@emend/contract";
import { findExecutable } from "./executable.ts";
import { CliError } from "./http.ts";

export type GitCall =
  | ["--version"]
  | ["rev-parse", "--show-toplevel" | "--show-object-format" | "--git-common-dir"]
  | ["rev-parse", "--abbrev-ref", "HEAD"]
  | ["diff-tree", "-r", "-z", "--raw", "-M", string, string]
  | ["ls-tree", "-r", "-l", "-z", "--full-tree", string]
  | ["cat-file", "-s" | "blob", string]
  | ["ls-files", "-z", "-t", "--stage"]
  | ["ls-files", "--others", "--exclude-standard", "-z"]
  | ["config", "--bool", "--get", "core.filemode"]
  | ["config", "--get", "remote.origin.url"];
export type GitRunner = (cwd: string, call: GitCall) => Promise<Buffer>;
export class GitNotAllowed extends CliError {
  constructor() {
    super("git command is not allowed");
  }
}
export class GitFailed extends CliError {
  readonly exitCode: number | string | undefined;
  constructor(exitCode: number | string | undefined) {
    super("git lookup failed");
    this.exitCode = exitCode;
  }
}
const oid = (value: unknown) => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function allowed(a: unknown): a is GitCall {
  if (!Array.isArray(a) || !a.every((part) => typeof part === "string")) return false;
  switch (a[0]) {
    case "--version":
      return a.length === 1;
    case "rev-parse":
      return (
        (a.length === 2 && ["--show-toplevel", "--show-object-format", "--git-common-dir"].includes(a[1] ?? "")) ||
        (a.length === 3 && a[1] === "--abbrev-ref" && a[2] === "HEAD")
      );
    case "diff-tree":
      return (
        a.length === 7 && a[1] === "-r" && a[2] === "-z" && a[3] === "--raw" && a[4] === "-M" && oid(a[5]) && oid(a[6])
      );
    case "ls-tree":
      return a.length === 6 && a[1] === "-r" && a[2] === "-l" && a[3] === "-z" && a[4] === "--full-tree" && oid(a[5]);
    case "cat-file":
      return a.length === 3 && ["-s", "blob"].includes(a[1] ?? "") && oid(a[2]);
    case "ls-files":
      return (
        JSON.stringify(a) === '["ls-files","--others","--exclude-standard","-z"]' ||
        JSON.stringify(a) === '["ls-files","-z","-t","--stage"]'
      );
    case "config":
      return (
        JSON.stringify(a) === '["config","--get","remote.origin.url"]' ||
        JSON.stringify(a) === '["config","--bool","--get","core.filemode"]'
      );
    default:
      return false;
  }
}
const fences = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.allow=never",
  "-c",
  "core.untrackedCache=false",
];
let executable: Promise<{ file: string; path: string }> | undefined;
function gitExecutable() {
  executable ??= findExecutable("git");
  return executable;
}
async function execute(cwd: string, args: string[], listing = false, signal?: AbortSignal): Promise<Buffer> {
  const binary = await gitExecutable();
  return new Promise((resolve, reject) =>
    execFile(
      binary.file,
      args,
      {
        cwd,
        encoding: "buffer",
        timeout: 10000,
        signal,
        maxBuffer: listing ? 64 * 1024 * 1024 : LIMITS.publishJsonBytes,
        env: {
          PATH: binary.path,
          HOME: process.env.HOME,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          GIT_NO_LAZY_FETCH: "1",
          LC_ALL: "C",
        },
      },
      (error, stdout) => {
        if (error) {
          reject(
            listing && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? new CliError("the repository lists too many files")
              : new GitFailed(error.code),
          );
        } else resolve(stdout);
      },
    ),
  );
}
/** Cache only within one publish, never across later invocations on a changed repository. */
export function createGitSession({ signal }: { signal?: AbortSignal } = {}): GitRunner {
  const versions = new Map<string, Promise<Buffer>>();
  const formats = new Map<string, Promise<string>>();
  return async (cwd, call) => {
    if (!allowed(call)) throw new GitNotAllowed();
    let version = versions.get(cwd);
    if (!version) {
      version = execute(cwd, [...fences, "--version"], false, signal).then((bytes) => {
        const match = /^git version (\d+)\.(\d+)/.exec(bytes.toString());
        if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 44))
          throw new CliError("git 2.44 or newer is required");
        return bytes;
      });
      versions.set(cwd, version);
    }
    const checked = await version;
    if (call[0] === "--version") return checked;
    let format = formats.get(cwd);
    if (!format) {
      // These bootstrap lookups cannot inspect attributes or worktree bytes.
      format = execute(cwd, [...fences, "rev-parse", "--show-object-format"], false, signal).then((bytes) => {
        const value = bytes.toString().trim();
        if (value !== "sha1" && value !== "sha256") throw new CliError("unsupported git object format");
        return value;
      });
      formats.set(cwd, format);
    }
    const objectFormat = await format;
    if (call[0] === "rev-parse" && call[1] === "--show-object-format") return Buffer.from(`${objectFormat}\n`);
    const emptyTree = createHash(objectFormat).update("tree 0\0").digest("hex");
    // Only tree/object reads and listings: comparing the index to disk can run clean
    // filters from info/attributes even with an empty attribute source.
    const args = [`--attr-source=${emptyTree}`, ...fences, call[0], ...call.slice(1)];
    if (call[0] === "diff-tree")
      args.push("--no-abbrev", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty", "--");
    const result = await execute(cwd, args, call[0] === "ls-tree" || call[0] === "ls-files", signal);
    if (call[0] === "rev-parse" && call[1] === "--show-toplevel") {
      // Discovery may start in a subdirectory; subsequent calls use its worktree root.
      const root = result.toString().replace(/\r?\n$/, "");
      formats.set(root, format);
      versions.set(root, version);
    }
    return result;
  };
}
export const git: GitRunner = (cwd, call) => createGitSession()(cwd, call);
