import { type ChildProcess, execFile, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { pollUntil } from "../test/poll-until.ts";
import { findExecutable } from "./executable.ts";
import { CliError } from "./http.ts";
import { ensureTailscaleServe, tailscaleSelf, waitForTailscaleEscalations } from "./tailscale.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});
vi.mock("./executable.ts", () => ({ findExecutable: vi.fn() }));
let assertKillPids: (() => void) | undefined;
afterEach(async () => {
  try {
    if (vi.isFakeTimers()) {
      await vi.runAllTimersAsync();
      await waitForTailscaleEscalations();
    }
    assertKillPids?.();
  } finally {
    assertKillPids = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(spawn).mockReset();
    vi.mocked(findExecutable).mockReset();
  }
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const status = JSON.stringify({ BackendState: "Running", Self: { DNSName: "hub.example.ts.net" } });
const deadlineMs = 1_000;

class FakeChild extends EventEmitter {
  pid = 12345;
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private exited = false;
  private closedPipes = 0;
  private closed = false;

  constructor() {
    super();
    for (const stream of [this.stdout, this.stderr])
      stream.once("close", () => {
        this.closedPipes++;
        this.maybeClose();
      });
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.maybeClose();
  }

  private maybeClose() {
    if (!this.closed && this.exited && this.closedPipes === 2) {
      this.closed = true;
      this.emit("close", this.exitCode, this.signalCode);
    }
  }
}

function fixture() {
  vi.useFakeTimers();
  const child = new FakeChild();
  const spawned = Promise.withResolvers<void>();
  vi.mocked(findExecutable).mockResolvedValue({ file: "/synthetic/bin/tailscale", path: "/synthetic/bin" });
  vi.mocked(spawn).mockImplementation(() => {
    spawned.resolve();
    return child as unknown as ChildProcess;
  });
  const group = { exists: true };
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    if (!group.exists) throw Object.assign(new Error("group gone"), { code: "ESRCH" });
    return true;
  });
  assertKillPids = () => {
    // signalGroup catches kill errors, so assertions must run outside the spy.
    for (const [pid] of kill.mock.calls) expect(pid).toBe(-child.pid);
  };
  return { child, group, kill, spawned: spawned.promise, env: { PATH: "/synthetic/bin", HOME: "/synthetic" } };
}

async function stopped(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  // Orphans can briefly remain as zombies until init reaps them; they are already dead.
  const { stdout } = await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "stat="], {
    env: { PATH: process.env.PATH, LC_ALL: "C" },
  });
  return stdout.trim().startsWith("Z");
}

test.each(["timeout", "overflow", "exit"] as const)(
  "%s ends a call whose descendant holds stdout and terminates the group",
  async (mode) => {
    const f = fixture();
    const result = tailscaleSelf(f.env, undefined, { deadlineMs });
    const assertion =
      mode === "exit"
        ? expect(result).resolves.toEqual({ dnsName: "hub.example.ts.net" })
        : expect(result).rejects.toThrow(
            mode === "timeout"
              ? "tailscale did not answer within 1 second."
              : "could not read the output of tailscale status.",
          );
    await f.spawned;
    if (mode === "exit") {
      f.child.stdout.write(status);
      f.child.exit();
      await vi.advanceTimersByTimeAsync(249);
      expect(f.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    } else {
      if (mode === "timeout") {
        await vi.advanceTimersByTimeAsync(deadlineMs - 1);
        expect(f.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      } else f.child.stdout.write(Buffer.alloc(17 * 1024 * 1024));
      f.child.exit(null, "SIGTERM");
    }
    await assertion;
    expect(f.child.stdout.destroyed).toBe(true);
    expect(f.child.stderr.destroyed).toBe(true);
    expect(f.kill).toHaveBeenCalledWith(-f.child.pid, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.kill).toHaveBeenLastCalledWith(-f.child.pid, "SIGKILL");
  },
);

test("a child ignoring SIGTERM is killed one second after the deadline", async () => {
  const f = fixture();
  let settled = false;
  const result = tailscaleSelf(f.env, undefined, { deadlineMs }).finally(() => {
    settled = true;
  });
  const assertion = expect(result).rejects.toThrow("tailscale did not answer within 1 second.");
  await f.spawned;
  await vi.advanceTimersByTimeAsync(deadlineMs);
  expect(f.kill.mock.calls).toEqual([[-f.child.pid, "SIGTERM"]]);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(999);
  expect(f.kill).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.kill.mock.calls).toEqual([
    [-f.child.pid, "SIGTERM"],
    [-f.child.pid, 0],
    [-f.child.pid, "SIGKILL"],
  ]);
  f.child.exit(null, "SIGKILL");
  await assertion;
  expect(f.child.signalCode).toBe("SIGKILL");
});

test.each(["timeout", "exit", "overflow", "abort"] as const)(
  "%s settles before escalation but still kills a descendant that traps SIGTERM",
  async (mode) => {
    const f = fixture();
    const abort = new AbortController();
    const result = tailscaleSelf(f.env, abort.signal, { deadlineMs });
    const assertion =
      mode === "exit"
        ? expect(result).resolves.toEqual({ dnsName: "hub.example.ts.net" })
        : expect(result).rejects.toThrow(
            mode === "timeout"
              ? "tailscale did not answer within 1 second."
              : mode === "overflow"
                ? "could not read the output of tailscale status."
                : "synthetic abort",
          );
    await f.spawned;
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(deadlineMs);
    else if (mode === "overflow") f.child.stdout.write(Buffer.alloc(17 * 1024 * 1024));
    else if (mode === "abort") abort.abort(new Error("synthetic abort"));
    else f.child.stdout.write(status);
    f.child.exit();
    if (mode === "exit") await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(f.kill).toHaveBeenCalledWith(-f.child.pid, "SIGTERM");
    expect(f.kill).not.toHaveBeenCalledWith(-f.child.pid, "SIGKILL");
    let escalated = false;
    const escalation = waitForTailscaleEscalations().then(() => {
      escalated = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(escalated).toBe(false);
    expect(f.kill).not.toHaveBeenCalledWith(-f.child.pid, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    await escalation;
    expect(f.kill.mock.calls.slice(-2)).toEqual([
      [-f.child.pid, 0],
      [-f.child.pid, "SIGKILL"],
    ]);
  },
);

test("the descendant dies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-tailscale-process-"));
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const executable = await vi.importActual<typeof import("./executable.ts")>("./executable.ts");
  vi.mocked(findExecutable).mockImplementation(executable.findExecutable);
  const spawned = Promise.withResolvers<ChildProcess>();
  let closed: Promise<void> | undefined;
  vi.mocked(spawn).mockImplementation((...args: Parameters<typeof spawn>) => {
    const child = actual.spawn(...args);
    // Handle a spawn error at once: it settles this promise instead of rejecting unhandled.
    closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    spawned.resolve(child);
    return child;
  });
  onTestFinished(async () => {
    try {
      await writeFile(join(dir, "release"), "");
      await waitForTailscaleEscalations();
      await closed;
      const descendant = await readFile(join(dir, "descendant"), "utf8").catch(() => "");
      if (descendant) await pollUntil(async () => expect(await stopped(Number(descendant))).toBe(true));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  await writeFile(
    join(dir, "descendant.sh"),
    `trap '' TERM
printf '%s' "$$" > ${quote(join(dir, "descendant"))}
printf ready >&2
while [ ! -f ${quote(join(dir, "release"))} ]; do :; done
`,
  );
  await writeFile(
    join(dir, "tailscale"),
    `#!/bin/sh
trap 'exit 0' TERM
/bin/sh ${quote(join(dir, "descendant.sh"))} &
wait
`,
    { mode: 0o700 },
  );
  const abort = new AbortController();
  const result = tailscaleSelf({ PATH: dir, HOME: dir }, abort.signal);
  const assertion = expect(result).rejects.toThrow("synthetic abort");
  const child = await spawned.promise;
  await once(child.stderr as NodeJS.ReadableStream, "data");
  const pid = Number(await readFile(join(dir, "descendant"), "utf8"));
  expect(await stopped(pid)).toBe(false);
  abort.abort(new Error("synthetic abort"));
  await assertion;
  await waitForTailscaleEscalations();
  await pollUntil(async () => expect(await stopped(pid)).toBe(true));
});

test("about 1 MiB of valid status JSON is read completely when the fake exits at once", async () => {
  const f = fixture();
  const result = tailscaleSelf(f.env);
  await f.spawned;
  f.group.exists = false;
  f.child.stdout.end(`${" ".repeat(1024 * 1024)}${status}`);
  f.child.stderr.end();
  f.child.exit();
  await expect(result).resolves.toEqual({ dnsName: "hub.example.ts.net" });
});

test("status output arriving between exit and close is drained", async () => {
  const f = fixture();
  const result = tailscaleSelf(f.env);
  await f.spawned;
  f.group.exists = false;
  f.child.stdout.write(status.slice(0, -1));
  f.child.exit();
  await vi.advanceTimersByTimeAsync(20);
  f.child.stdout.end(status.slice(-1));
  f.child.stderr.end();
  await expect(result).resolves.toEqual({ dnsName: "hub.example.ts.net" });
});

test("the deadline still bounds output draining after exit", async () => {
  const f = fixture();
  const assertion = expect(tailscaleSelf(f.env, undefined, { deadlineMs: 100 })).rejects.toThrow(
    "tailscale did not answer within 0.1 seconds.",
  );
  await f.spawned;
  f.child.stdout.write(status);
  f.child.exit();
  await vi.advanceTimersByTimeAsync(99);
  expect(f.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await assertion;
  expect(f.kill.mock.calls).toEqual([[-f.child.pid, "SIGTERM"]]);
});

test("a clean exit checks the group but sends no signal and adds no grace period", async () => {
  const f = fixture();
  const result = tailscaleSelf(f.env);
  await f.spawned;
  f.group.exists = false;
  f.child.stdout.end(status);
  f.child.stderr.end();
  f.child.exit();
  await expect(result).resolves.toEqual({ dnsName: "hub.example.ts.net" });
  expect(f.kill.mock.calls).toEqual([[-f.child.pid, 0]]);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([false, true])("escalation probes the group before SIGKILL (still present: %s)", async (present) => {
  const f = fixture();
  const result = tailscaleSelf(f.env);
  await f.spawned;
  f.child.stdout.end(status);
  f.child.stderr.end();
  f.child.exit();
  await expect(result).resolves.toEqual({ dnsName: "hub.example.ts.net" });
  expect(f.kill.mock.calls).toEqual([
    [-f.child.pid, 0],
    [-f.child.pid, "SIGTERM"],
  ]);
  f.kill.mockClear();
  f.group.exists = present;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.kill.mock.calls).toEqual(
    present
      ? [
          [-f.child.pid, 0],
          [-f.child.pid, "SIGKILL"],
        ]
      : [[-f.child.pid, 0]],
  );
});

test.each(["status", "serve"] as const)(
  "a synchronous %s spawn failure uses only the generic error",
  async (command) => {
    const f = fixture();
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw Object.assign(new Error("synthetic private spawn detail"), { code: "E2BIG" });
    });
    const result = command === "status" ? tailscaleSelf(f.env) : ensureTailscaleServe(3636, f.env);
    await expect(result).rejects.toEqual(
      new CliError(
        command === "status" ? "Tailscale is not running or not logged in." : "Could not configure Tailscale Serve.",
      ),
    );
  },
);

test.each(["EMFILE", "ENFILE"])("%s with null pipes is handled before the child error event", async (code) => {
  const f = fixture();
  let hadErrorListener = false;
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null });
    process.nextTick(() => {
      hadErrorListener = child.listenerCount("error") > 0;
      // Keep the red run from crashing Vitest itself; the assertion still catches the missing listener.
      if (hadErrorListener) child.emit("error", Object.assign(new Error("synthetic spawn failure"), { code }));
      child.emit("close", -1, null);
    });
    return child as ChildProcess;
  });
  await expect(tailscaleSelf(f.env)).rejects.toEqual(new CliError("Tailscale is not running or not logged in."));
  expect(hadErrorListener).toBe(true);
});
