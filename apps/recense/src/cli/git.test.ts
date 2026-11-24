import { type ChildProcess, type ExecFileOptionsWithBufferEncoding, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { createGitSession, type GitCall, GitFailed, GitNotAllowed, git } from "./git.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
test("git refuses non-allowlisted forms before spawning", async () => {
  for (const call of [
    ["config", "--global", "x"],
    ["merge-base", "a".repeat(40), "b".repeat(40)],
    ["show", "--textconv", "HEAD:x"],
    ["cat-file", "--filters", "HEAD:x"],
    ["diff", "--name-status", "--ext-diff"],
    ["rev-parse", "--git-path", "config"],
    ["show", `${"a".repeat(40)}~`],
    ["cat-file", "blob", `${"a".repeat(40)}:x`],
    ["diff-index", "-z", "--raw", "--ignore-submodules=dirty", "a".repeat(40)],
    ["diff-index", "-z", "--raw", "--cached", "--no-renames", "a".repeat(40)],
    ["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"],
    ["ls-files", "-z", "-t", "--stage", "--recurse-submodules"],
    ["config", "--bool", "--get", "filter.evil.required"],
  ]) {
    await expect(git("/tmp/synthetic", call as GitCall)).rejects.toBeInstanceOf(GitNotAllowed);
  }
  expect(execFile).not.toHaveBeenCalled();
});
test("git fences every call and rejects old versions", async () => {
  const calls: { args: string[]; options: Record<string, unknown> }[] = [];
  const mocked = vi.mocked(execFile);
  mocked.mockImplementation(((
    _exe: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (err: Error | null, stdout: Buffer) => void,
  ) => {
    calls.push({ args, options });
    callback(
      null,
      Buffer.from(
        args.includes("--version")
          ? "git version 2.49.0\n"
          : args.includes("--show-object-format")
            ? "sha1\n"
            : args.includes("--show-toplevel")
              ? "/tmp/synthetic\n"
              : "",
      ),
    );
  }) as typeof execFile);
  const hash = "a".repeat(40);
  const run = createGitSession();
  await run("/tmp/synthetic/nested", ["rev-parse", "--show-toplevel"]);
  await run("/tmp/synthetic", ["diff-tree", "-r", "-z", "--raw", "-M", hash, hash]);
  await run("/tmp/synthetic", ["cat-file", "blob", hash]);
  await run("/tmp/synthetic", ["cat-file", "-s", hash]);
  await run("/tmp/synthetic", ["ls-tree", "-r", "-l", "-z", "--full-tree", hash]);
  await run("/tmp/synthetic", ["ls-files", "-z", "-t", "--stage"]);
  await run("/tmp/synthetic", ["ls-files", "--others", "--exclude-standard", "-z"]);
  await run("/tmp/synthetic", ["config", "--bool", "--get", "core.filemode"]);
  await run("/tmp/synthetic", ["config", "--get", "remote.origin.url"]);
  await run("/tmp/synthetic", ["rev-parse", "--git-common-dir"]);
  await run("/tmp/synthetic", ["rev-parse", "--abbrev-ref", "HEAD"]);
  expect(calls.filter((c) => c.args.includes("--version"))).toHaveLength(1);
  expect(calls.filter((c) => c.args.includes("--show-object-format"))).toHaveLength(1);
  for (const { args, options } of calls) {
    expect(args).toContain("core.fsmonitor=false");
    expect(args).toContain("core.attributesFile=/dev/null");
    for (const fence of ["core.hooksPath=/dev/null", "protocol.allow=never", "core.untrackedCache=false"])
      expect(args).toContain(fence);
    expect(options).toMatchObject({
      timeout: 10000,
      maxBuffer: args.includes("ls-tree") || args.includes("ls-files") ? 67108864 : 8388608,
    });
    expect(["/tmp/synthetic", "/tmp/synthetic/nested"]).toContain(options.cwd);
    expect(Object.keys(options.env as object).sort()).toEqual(
      ["PATH", "HOME", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "GIT_PAGER", "GIT_NO_LAZY_FETCH", "LC_ALL"].sort(),
    );
    if (args.includes("diff-tree")) {
      expect(args).toContain("--no-ext-diff");
      expect(args).toContain("--no-textconv");
      expect(args[0]).toMatch(/^--attr-source=/);
    }
  }
  mocked.mockImplementation(((
    _exe: string,
    _args: string[],
    _options: object,
    callback: (err: Error | null, stdout: Buffer) => void,
  ) => callback(null, Buffer.from("git version 2.43.9"))) as typeof execFile);
  await expect(git("/tmp/old", ["--version"])).rejects.toThrow("git 2.44 or newer is required");
});

test.each<GitCall>([
  ["ls-tree", "-r", "-l", "-z", "--full-tree", "a".repeat(40)],
  ["ls-files", "-z", "-t", "--stage"],
  ["ls-files", "--others", "--exclude-standard", "-z"],
  ["cat-file", "blob", "a".repeat(40)],
])("%s rejects output overflow without returning a partial listing", async (...call) => {
  vi.mocked(execFile).mockImplementation(((
    _exe: string,
    args: string[],
    _options: object,
    callback: (err: Error | null, stdout: Buffer) => void,
  ) => {
    if (args.includes("--version")) callback(null, Buffer.from("git version 2.55.0\n"));
    else if (args.includes("--show-object-format")) callback(null, Buffer.from("sha1\n"));
    else
      callback(
        Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
        Buffer.from("partial\0"),
      );
  }) as typeof execFile);
  const result = git("/tmp/synthetic", call);
  if (call[0] === "cat-file") await expect(result).rejects.toBeInstanceOf(GitFailed);
  else await expect(result).rejects.toThrow("the repository lists too many files");
});

test.each(["already aborted", "bootstrap", "format", "listing"])(
  "a git session cancels real children with an %s signal",
  async (phase) => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const repo = await mkdtemp(join(tmpdir(), "recense-git-abort-"));
    const children: ChildProcess[] = [];
    const closed: Promise<void>[] = [];
    onTestFinished(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.all(closed);
      await rm(repo, { recursive: true, force: true });
    });
    await promisify(actual.execFile)("git", ["-c", "core.hooksPath=/dev/null", "init", "-b", "main"], {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: repo, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    const controller = new AbortController();
    if (phase === "already aborted") controller.abort();
    vi.mocked(execFile).mockImplementation(((
      file: string,
      args: string[],
      options: ExecFileOptionsWithBufferEncoding,
      callback: (error: Error | null, stdout: Buffer) => void,
    ) => {
      const child = actual.execFile(file, args, options, callback);
      children.push(child);
      closed.push(new Promise<void>((resolve) => child.once("close", () => resolve())));
      if (
        (phase === "bootstrap" && args.includes("--version")) ||
        (phase === "format" && args.includes("--show-object-format")) ||
        (phase === "listing" && args.includes("ls-files"))
      )
        child.once("spawn", () => controller.abort());
      return child;
    }) as typeof execFile);
    const pending = createGitSession({ signal: controller.signal })(repo, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    await expect(pending).rejects.toMatchObject({ exitCode: "ABORT_ERR" });
    await Promise.all(closed);
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  },
);
