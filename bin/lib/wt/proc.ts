import { spawnSync } from "node:child_process";

const FIXED: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PAGER: "cat",
  GIT_PAGER: "cat",
  PAGER: "cat",
  LC_ALL: "C.UTF-8",
};

export interface RunOptions {
  cwd: string;
  input?: string;
  /** Inherit stdin and stderr so the child can talk to the terminal. Stdout is still captured. */
  tty?: boolean;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a program without a shell, with the caller's environment plus FIXED (no prompts, no pager),
 * excluding GIT_DIFF_OPTS. Exit code 127 means the program was not found; 124 means it ran past the timeout.
 */
export function run(cmd: string, args: string[], opts: RunOptions): RunResult {
  const useInput = opts.input !== undefined;
  const env = { ...process.env, ...FIXED };
  // GIT_DIFF_OPTS would override the diff context bin/wt pins.
  delete env.GIT_DIFF_OPTS;
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    env,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    stdio: opts.tty ? [useInput ? "pipe" : "inherit", "pipe", "inherit"] : "pipe",
  });
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") {
      return { code: 127, stdout, stderr: stderr || "command not found" };
    }
    if (code === "ETIMEDOUT") return { code: 124, stdout, stderr: stderr || "timed out" };
    return { code: 1, stdout, stderr: stderr || r.error.message };
  }
  return { code: r.status ?? 1, stdout, stderr };
}
