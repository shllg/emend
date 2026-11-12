import { spawn } from "node:child_process";
import type { UpdateSignals } from "./signals.ts";

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

/** Start one program with an argv array and no shell. Forward update signals for the rollback report. */
export function runChild(
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    output: "inherit" | "capture";
    signals?: UpdateSignals;
  },
): Promise<ChildResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let error = false;
    let settled = false;
    let interrupted: ChildResult["interrupted"] = null;
    const inherit = options.output === "inherit";
    let onSignal: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      if (onSignal) options.signals?.signal.removeEventListener("abort", onSignal);
      resolve({ code, signal, interrupted, timedOut, error, stdout, stderr });
    };
    if (options.signals?.interrupted) {
      interrupted = options.signals.interrupted;
      done(null, null);
      return;
    }
    try {
      const child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: true,
        stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      });
      let terminating = false;
      let exited = false;
      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH") error = true;
        }
      };
      const terminate = (signal: "SIGINT" | "SIGTERM") => {
        terminating = true;
        signalGroup(signal);
        if (exited) signalGroup("SIGKILL");
        else {
          killTimer ??= setTimeout(() => signalGroup("SIGKILL"), 5000);
          killTimer.unref();
        }
      };
      onSignal = () => {
        interrupted = options.signals?.interrupted ?? null;
        if (interrupted) terminate(interrupted);
      };
      options.signals?.signal.addEventListener("abort", onSignal, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        terminate("SIGTERM");
      }, options.timeoutMs);
      const capture = (current: string, chunk: string) => {
        if (Buffer.byteLength(current) + Buffer.byteLength(chunk) > captureLimit) {
          error = true;
          terminate("SIGTERM");
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
      child.once("exit", (code, signal) => {
        exited = true;
        clearTimeout(timer);
        // The leader can exit while descendants keep running and hold its pipes open.
        if (terminating) signalGroup("SIGKILL");
        closeTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          done(code, signal);
        }, 1000);
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
