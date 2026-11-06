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

export interface RunBytesResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, ...FIXED };
  // GIT_DIFF_OPTS would override the diff context bin/wt pins.
  delete env.GIT_DIFF_OPTS;
  delete env.EMEND_PRIVATE_TERMS;
  // The exempt identity must come from the user's own global or system config.
  for (const key of Object.keys(env))
    if (/^GIT_CONFIG_(?:PARAMETERS|COUNT|GLOBAL|SYSTEM|NOSYSTEM|KEY_.*|VALUE_.*)$/.test(key)) delete env[key];
  // Repository selection must come from the checkout's origin, never a caller override.
  delete env.GH_REPO;
  return env;
}

/**
 * Runs a program without a shell, with the caller's environment plus FIXED (no prompts, no pager),
 * excluding Git config overrides, GIT_DIFF_OPTS, GH_REPO and EMEND_PRIVATE_TERMS.
 * Exit 127 means not found; 124 means it ran past the timeout.
 */
export function run(cmd: string, args: string[], opts: RunOptions): RunResult {
  const useInput = opts.input !== undefined;
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    env: childEnv(),
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

/** Like run(), but passes input and stdout as bytes and always captures both output streams. */
export function runBytes(
  cmd: string,
  args: string[],
  opts: { cwd: string; input?: Buffer; timeoutMs?: number },
): RunBytesResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    env: childEnv(),
    encoding: "buffer",
    timeout: opts.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    stdio: "pipe",
  });
  const stdout = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(r.stderr) ? r.stderr.toString("utf8") : "";
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
