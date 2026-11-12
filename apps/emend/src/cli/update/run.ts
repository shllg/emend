import { spawn } from "node:child_process";

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  interrupted: "SIGINT" | "SIGTERM" | null;
  timedOut: boolean;
  error: boolean;
  stdout: string;
  stderr: string;
}

const captureLimit = 64 * 1024;

/** Start one program with an argv array and no shell. Keep terminal signals for the rollback report. */
export function runChild(
  file: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; output: "inherit" | "capture" },
): Promise<ChildResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let error = false;
    let settled = false;
    let interrupted: ChildResult["interrupted"] = null;
    const inherit = options.output === "inherit";
    const onInterrupt = () => {
      interrupted ??= "SIGINT";
    };
    const onTerminate = () => {
      interrupted ??= "SIGTERM";
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (inherit) {
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
      }
      resolve({ code, signal, interrupted, timedOut, error, stdout, stderr });
    };
    if (inherit) {
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onTerminate);
    }
    try {
      const child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      });
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
        killTimer.unref();
      }, options.timeoutMs);
      const capture = (current: string, chunk: string) => {
        if (Buffer.byteLength(current) + Buffer.byteLength(chunk) > captureLimit) {
          error = true;
          child.kill("SIGTERM");
          return current;
        }
        return current + chunk;
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = capture(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = capture(stderr, chunk);
      });
      child.once("error", () => {
        error = true;
        done(null, null);
      });
      child.once("close", done);
    } catch {
      error = true;
      done(null, null);
    }
  });
}

export function succeeded(result: ChildResult): boolean {
  return (
    result.code === 0 && result.signal === null && result.interrupted === null && !result.timedOut && !result.error
  );
}
