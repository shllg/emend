import { spawn } from "node:child_process";

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error: boolean;
  stdout: string;
}

const captureLimit = 64 * 1024;

/** Start one program with an argv array and no shell. `inherit` hands the terminal to the child. */
export function runChild(
  file: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; output: "inherit" | "capture" },
): Promise<ChildResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let timedOut = false;
    let error = false;
    let settled = false;
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, timedOut, error, stdout });
    };
    const inherit = options.output === "inherit";
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < captureLimit) stdout += chunk;
    });
    child.once("error", () => {
      error = true;
      done(null, null);
    });
    child.once("close", done);
  });
}

export function succeeded(result: ChildResult): boolean {
  return result.code === 0 && result.signal === null && !result.timedOut && !result.error;
}
