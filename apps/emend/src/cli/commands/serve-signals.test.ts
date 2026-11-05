import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { constants, watch } from "node:fs";
import { appendFile, type FileHandle, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vitest";
import { pollUntil } from "../../test/poll-until.ts";

async function watchFileUntil(path: string, matches: (text: string | undefined) => boolean, signal: AbortSignal) {
  const changed = Promise.withResolvers<void>();
  const check = async () => {
    try {
      const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (matches(text)) changed.resolve();
    } catch (error) {
      changed.reject(error);
    }
  };
  // Watch the parent before reading: gates are created by atomic rename and may
  // already exist by the time the test starts waiting.
  const watcher = watch(dirname(path), () => void check());
  watcher.on("error", changed.reject);
  const abort = () => changed.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  void check();
  try {
    await changed.promise;
  } finally {
    watcher.close();
    signal.removeEventListener("abort", abort);
  }
}

const name = "hub.example.ts.net";
let entryDir: string;
let entry: string;
let socketEntry: string;
beforeAll(async () => {
  entryDir = await mkdtemp(join(tmpdir(), "emend-signal-entry-"));
  entry = join(entryDir, "cli.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../../cli.ts", import.meta.url))],
    outfile: entry,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: ["node:*"],
  });
  // New lifecycle cases need real processes/signals, but no TCP socket. Keep the
  // existing end-to-end cases on the real listener, and exercise actual state/close
  // code with this socket double for the phase-gated cases.
  socketEntry = join(entryDir, "cli-socket.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../../cli.ts", import.meta.url))],
    outfile: socketEntry,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    plugins: [
      {
        name: "synthetic-listener",
        setup(builder) {
          builder.onResolve({ filter: /^node:http$/ }, (args) => {
            if (args.importer.endsWith("/server/serve.ts")) return { path: "http", namespace: "socket-double" };
          });
          builder.onLoad({ filter: /.*/, namespace: "socket-double" }, () => ({
            contents: `
import { EventEmitter } from "node:events";
import { existsSync, renameSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
function onRelease(done) {
  const release = process.env.EMEND_TEST_RELEASE;
  const watcher = watch(dirname(release), check);
  function check() {
    if (!existsSync(release)) return;
    watcher.close();
    done();
  }
  check();
}
class Socket extends EventEmitter {
  listening = false;
  listen(options, ready) {
    this.keepAlive = setInterval(() => {}, 1000);
    this.listening = true;
    const marker = process.env.EMEND_TEST_LISTEN;
    if (!marker) { queueMicrotask(ready); return; }
    writeFileSync(marker + ".tmp", String(process.pid));
    renameSync(marker + ".tmp", marker);
    onRelease(ready);
  }
  address() { return { address: "127.0.0.1", port: 41999 }; }
  closeAllConnections() {}
  close(done) {
    if (process.env.EMEND_TEST_CLOSED) writeFileSync(process.env.EMEND_TEST_CLOSED, "closed");
    const marker = process.env.EMEND_TEST_CLOSE;
    if (!marker) { clearInterval(this.keepAlive); this.listening = false; done(); return; }
    writeFileSync(marker + ".tmp", String(process.pid));
    renameSync(marker + ".tmp", marker);
    onRelease(() => {
      clearInterval(this.keepAlive);
      this.listening = false;
      done();
    });
  }
}
export const createServer = () => new Socket();
`,
          }));
        },
      },
    ],
  });
});
afterAll(async () => {
  if (entryDir) await rm(entryDir, { recursive: true, force: true });
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function killIfPresent(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
async function stopped(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  const { stdout } = await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "stat="], {
    env: { PATH: process.env.PATH, LC_ALL: "C" },
  });
  return stdout.trim().startsWith("Z");
}
async function fixture(
  options: {
    timeout?: boolean;
    phase?: "status" | "listen" | "bg" | "off" | "close";
    stderrFailure?: "throw" | "event";
    socketDouble?: boolean;
    closedStdout?: boolean;
    stubbornDescendant?: boolean;
    keepAlive?: boolean;
    holdEscalation?: boolean;
  } = {},
) {
  const phase = options.phase ?? "status";
  const watches = new Set<AbortController>();
  const pendingWaits = new Set<{ label: string }>();
  async function track<T>(label: string, promise: Promise<T>): Promise<T> {
    const pending = { label };
    pendingWaits.add(pending);
    try {
      return await promise;
    } finally {
      pendingWaits.delete(pending);
    }
  }
  let launcherPid: number | undefined;
  function rememberLauncher(text: string) {
    const pid = Number(text);
    launcherPid ??= pid;
    return pid;
  }
  let running: ChildProcess | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let stdoutReader: FileHandle | undefined;
  let stdoutFile: FileHandle | undefined;
  let stderrFile: FileHandle | undefined;
  let cleaned = false;
  const dir = await mkdtemp(join(tmpdir(), "emend-serve-signals-"));
  onTestFinished(cleanup);
  const stateDir = join(dir, "state");
  const configPath = join(dir, "config.json");
  const callsPath = join(dir, "calls");
  const holdPath = join(dir, "hold-cleanup");
  const enteredPath = join(dir, "cleanup-started");
  const releasePath = join(dir, "release-cleanup");
  const reportPath = join(dir, "report-attempts");
  const bootstrap = join(dir, "bootstrap.mjs");
  const listenErrorPath = join(dir, "listen-error");
  const stdoutErrorPath = join(dir, "stdout-error");
  const descendantPath = join(dir, "descendant");
  const socketClosedPath = join(dir, "socket-closed");
  const signalsPath = join(dir, "signals");
  const escalationArmedPath = join(dir, "escalation-armed");
  const escalationAwaitedPath = join(dir, "escalation-awaited");
  const escalationReleasePath = join(dir, "escalation-release");
  const handlerRemovedPath = join(dir, "handler-removed-while-held");
  // Finished hooks run in reverse registration order: capture evidence before cleanup.
  onTestFinished(async (context) => {
    if (context.task.result?.state !== "fail") return;
    const pending = [...pendingWaits].map(({ label }) => label);
    const exitCode = running ? running.exitCode : "unknown";
    const signalCode = running ? running.signalCode : "unknown";
    const read = (path: string) => readFile(path, "utf8").catch(() => undefined);
    const markers = [
      "cleanup-started",
      "escalation-armed",
      "escalation-awaited",
      "escalation-release",
      "handler-removed-while-held",
      "release-cleanup",
      "hold-cleanup",
      "descendant",
      "socket-closed",
      "listen-error",
      "stdout-error",
    ];
    const [markerStates, signals, callRecords, descendant, launcher] = await Promise.all([
      Promise.all(
        markers.map(async (marker) => {
          const present = await stat(join(dir, marker)).then(
            () => true,
            () => false,
          );
          return `${marker}: ${present ? "present" : "absent"}`;
        }),
      ),
      read(signalsPath),
      read(callsPath),
      read(descendantPath),
      read(enteredPath),
    ]);
    if (launcher !== undefined) rememberLauncher(launcher);
    const processState = async (pid: number | undefined) => {
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return "unknown";
      return promisify(execFile)("/bin/ps", ["-o", "pid=,ppid=,pgid=,stat=", "-p", String(pid)], {
        env: { PATH: process.env.PATH, LC_ALL: "C" },
        timeout: 2000,
      }).then(
        ({ stdout }) => stdout.trim() || "gone",
        (error: { code?: string | number }) => (error.code === 1 ? "gone" : "unknown"),
      );
    };
    const processes = await Promise.all(
      (
        [
          ["emend", running?.pid],
          ["launcher", launcherPid],
          ["descendant", descendant === undefined ? undefined : Number(descendant)],
        ] as const
      ).map(async ([name, pid]) => `${name} (pid ${pid ?? "unknown"}): ${await processState(pid)}`),
    );
    throw new Error(
      [
        "serve-signals failure report:",
        `pending waits: ${pending.join(", ") || "none"}`,
        ...markerStates,
        `signals: ${signals?.trim() || "none"}`,
        `calls: ${(callRecords ?? "").split("\n").filter(Boolean).length} lines`,
        ...processes,
        `emend exitCode: ${exitCode}; signalCode: ${signalCode}`,
      ].join("\n"),
    );
  });
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try {
      for (const abort of watches) abort.abort();
      // Release only the currently held fakes; never replay historical pids.
      await writeFile(releasePath, "");
      if (running?.pid && running.exitCode === null && running.signalCode === null) killIfPresent(-running.pid);
      await closed;
      if (options.stubbornDescendant) {
        const descendant = await readFile(descendantPath, "utf8").catch(() => "");
        if (descendant) await pollUntil(async () => expect(await stopped(Number(descendant))).toBe(true));
      }
    } finally {
      try {
        await Promise.all([stdoutReader?.close(), stdoutFile?.close(), stderrFile?.close()]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
  await writeFile(
    bootstrap,
    `
import { existsSync, writeFileSync, appendFileSync, renameSync, watch } from "node:fs";
import { Server } from "node:http";
import { errorMonitor } from "node:events";
${options.keepAlive ? "setInterval(() => {}, 1000);" : ""}
${
  options.holdEscalation
    ? `
const nativeSetTimeout = globalThis.setTimeout;
const nativeWithResolvers = Promise.withResolvers;
const nativePromiseAll = Promise.all;
let lastPromise;
let escalationPromise;
let held = false;
Promise.withResolvers = function (...args) {
  const deferred = nativeWithResolvers.apply(this, args);
  lastPromise = deferred.promise;
  return deferred;
};
Promise.all = function (iterable) {
  if (!held) return nativePromiseAll.call(this, iterable);
  const promises = Array.from(iterable);
  if (promises.includes(escalationPromise)) {
    writeFileSync(${JSON.stringify(`${escalationAwaitedPath}.tmp`)}, "awaited");
    renameSync(${JSON.stringify(`${escalationAwaitedPath}.tmp`)}, ${JSON.stringify(escalationAwaitedPath)});
  }
  return nativePromiseAll.call(this, promises);
};
// Production must remove its signal handlers only after the escalation wait ends.
// Record any removal that happens while the escalation timer is held.
function noteRemoval(event) {
  if (!held || (event !== undefined && !["SIGINT", "SIGTERM", "SIGHUP"].includes(event))) return;
  writeFileSync(${JSON.stringify(`${handlerRemovedPath}.tmp`)}, String(event));
  renameSync(${JSON.stringify(`${handlerRemovedPath}.tmp`)}, ${JSON.stringify(handlerRemovedPath)});
}
for (const method of ["off", "removeListener", "removeAllListeners"]) {
  const original = process[method];
  process[method] = function (...args) {
    noteRemoval(args[0]);
    return original.apply(this, args);
  };
}
globalThis.setTimeout = function (fn, delay, ...args) {
  if (delay !== 1000 || !String(fn).includes("SIGKILL")) return nativeSetTimeout(fn, delay, ...args);
  escalationPromise = lastPromise;
  let released = false;
  // This referenced watcher belongs to emend: an incorrect early process.exit
  // must lose the callback and leave the detached descendant alive.
  const watcher = watch(${JSON.stringify(dir)}, check);
  function check() {
    if (released || !existsSync(${JSON.stringify(escalationReleasePath)})) return;
    released = true;
    held = false;
    watcher.close();
    fn(...args);
  }
  held = true;
  writeFileSync(${JSON.stringify(`${escalationArmedPath}.tmp`)}, "armed");
  renameSync(${JSON.stringify(`${escalationArmedPath}.tmp`)}, ${JSON.stringify(escalationArmedPath)});
  check();
  return watcher;
};`
    : ""
}
// A later event-loop turn proves an unhandled stdout error did not terminate us.
process.stdout.on(errorMonitor, (error) => setImmediate(() => {
  writeFileSync(${JSON.stringify(`${stdoutErrorPath}.tmp`)}, error.code);
  renameSync(${JSON.stringify(`${stdoutErrorPath}.tmp`)}, ${JSON.stringify(stdoutErrorPath)});
}));
// Observe completed signal dispatch without adding a listener that could mask
// missing production handlers or change the default signal disposition.
const emit = process.emit;
process.emit = function (event, ...args) {
  const handled = emit.call(this, event, ...args);
  if (["SIGINT", "SIGTERM", "SIGHUP"].includes(event))
    appendFileSync(${JSON.stringify(signalsPath)}, event + "\\n");
  return handled;
};
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once("error", (error) => writeFileSync(${JSON.stringify(listenErrorPath)}, error.code ?? "unknown"));
  return listen.apply(this, args);
};
${
  options.stderrFailure
    ? `
process.stderr.write = () => {
  appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ discovery: existsSync(${JSON.stringify(join(stateDir, "server.json"))}) }) + "\\n");
  const error = Object.assign(new Error("write EIO"), { code: "EIO" });
  ${options.stderrFailure === "throw" ? "throw error;" : 'queueMicrotask(() => process.stderr.emit("error", error)); return false;'}
};`
    : ""
}
`,
  );
  const gate = `
    printf '%s' "$$" > ${quote(`${enteredPath}.tmp`)}
    /bin/mv ${quote(`${enteredPath}.tmp`)} ${quote(enteredPath)}
    while [ ! -f ${quote(releasePath)} ] && [ -d ${quote(dir)} ]; do :; done
    /bin/rm -f ${quote(enteredPath)}
  `;
  await writeFile(configPath, "{}");
  await writeFile(callsPath, "");
  await writeFile(
    join(dir, "tailscale"),
    `#!/bin/sh
${options.holdEscalation ? "" : `trap 'exit 0' TERM\ntrap ${quote(`/bin/rm -f ${quote(enteredPath)}`)} EXIT\n`}printf '%s %s\\n' "$$" "$*" >> ${quote(callsPath)}
if [ "$1" = status ]; then
  ${
    options.stubbornDescendant
      ? `/bin/sh -c ${quote(`trap '' TERM\nprintf '%s' "$$" > ${quote(`${descendantPath}.tmp`)}\n/bin/mv ${quote(`${descendantPath}.tmp`)} ${quote(descendantPath)}\nwhile [ ! -f ${quote(releasePath)} ] && [ -d ${quote(dir)} ]; do :; done`)} &
  while [ ! -f ${quote(descendantPath)} ] && [ -d ${quote(dir)} ]; do :; done`
      : ""
  }
  ${options.timeout ? gate : `printf '%s\\n' '${JSON.stringify({ BackendState: "Running", Self: { DNSName: name } })}'`}
elif [ "$2" = status ]; then
  ${phase === "status" ? `if [ -f ${quote(holdPath)} ]; then ${gate} fi` : ""}
  /bin/cat ${quote(configPath)}
elif [ "$2" = --bg ]; then
  printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"${name}:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "$4" > ${quote(configPath)}
  ${phase === "bg" ? gate : ""}
elif [ "$2" = --https=443 ] && [ "$3" = off ]; then
  ${phase === "off" ? gate : ""}
  ${options.stderrFailure ? "printf 'permission denied' >&2; exit 1" : ":"}
  printf '{}' > ${quote(configPath)}
else exit 7
fi
`,
    { mode: 0o700 },
  );
  const calls = async () =>
    (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ pid: Number(line.slice(0, line.indexOf(" "))), args: line.slice(line.indexOf(" ") + 1) }));
  const stdoutPath = join(dir, "stdout");
  const stderrPath = join(dir, "stderr");
  // Own both ends of an OS pipe so closing the reader reaches the writer itself.
  if (options.closedStdout)
    await promisify(execFile)("/usr/bin/mkfifo", [stdoutPath], { env: { PATH: process.env.PATH, LC_ALL: "C" } });
  stdoutReader = options.closedStdout ? await open(stdoutPath, constants.O_RDONLY | constants.O_NONBLOCK) : undefined;
  stdoutFile = options.closedStdout ? await open(stdoutPath, "w") : undefined;
  stderrFile = await open(stderrPath, "w");
  // Preserve stderr even when the terminal's pipe has gone away.
  // A separate group lets the test signal the entire job without signalling Vitest.
  const child = spawn(
    process.execPath,
    ["--import", bootstrap, options.socketDouble ? socketEntry : entry, "serve", "--tailscale", "--port", "0"],
    {
      cwd: dir,
      detached: true,
      stdio: ["ignore", stdoutFile?.fd ?? "pipe", stderrFile.fd],
      env: {
        EMEND_HOME: stateDir,
        HOME: dir,
        PATH: dir,
        LC_ALL: "C",
        NODE_NO_WARNINGS: "1",
        ...(phase === "close" ? { EMEND_TEST_CLOSE: enteredPath, EMEND_TEST_RELEASE: releasePath } : {}),
        ...(phase === "listen"
          ? {
              EMEND_TEST_LISTEN: enteredPath,
              EMEND_TEST_RELEASE: releasePath,
              EMEND_TEST_CLOSED: socketClosedPath,
            }
          : {}),
      },
    },
  );
  running = child;
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  // Some cases only await close; still observe spawn failures immediately.
  void exited.catch(() => {});
  closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: child.exitCode, signal: child.signalCode }));
  });
  const readyLine = Promise.withResolvers<string>();
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.includes("\n")) readyLine.resolve(stdout);
  });
  const waitWhileRunning = async <T>(pending: Promise<T>): Promise<T> =>
    Promise.race([
      pending,
      exited.then(async ({ code, signal }) => {
        const stderr = await readFile(stderrPath, "utf8");
        const listenError = await readFile(listenErrorPath, "utf8").catch(() => "");
        throw new Error(`emend exited before readiness: ${code}/${signal}: ${stderr} (listen ${listenError})`);
      }),
    ]);
  const waitForFile = async (
    path: string,
    matches: (text: string | undefined) => boolean = (text) => text !== undefined,
  ) => {
    const abort = new AbortController();
    watches.add(abort);
    try {
      await waitWhileRunning(watchFileUntil(path, matches, abort.signal));
    } finally {
      abort.abort();
      watches.delete(abort);
    }
  };
  await stdoutReader?.close();
  stdoutReader = undefined;
  let signalCount = 0;
  return {
    child,
    exited,
    closed,
    track,
    cleanup: () => track("cleanup", cleanup()),
    logOldPid: (pid: number) => track("logOldPid", appendFile(callsPath, `${pid} old completed call\n`)),
    reports: () =>
      track(
        "reports",
        readFile(reportPath, "utf8").then((text) =>
          text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ),
      ),
    startedPid: () => track("startedPid", readFile(enteredPath, "utf8").then(rememberLauncher)),
    calls: () => track("calls", calls()),
    configPath,
    stateDir,
    stderr: () => track("stderr", readFile(stderrPath, "utf8")),
    stdoutError: () =>
      track(
        "stdoutError",
        waitForFile(stdoutErrorPath).then(() => readFile(stdoutErrorPath, "utf8")),
      ),
    descendantPid: () => track("descendantPid", readFile(descendantPath, "utf8").then(Number)),
    socketClosed: () => track("socketClosed", readFile(socketClosedPath, "utf8")),
    gateEntered: () =>
      track(
        "gateEntered",
        waitForFile(enteredPath, (text) => {
          if (text === undefined) return false;
          rememberLauncher(text);
          return true;
        }),
      ),
    handlerRemovedWhileHeld: () => track("handlerRemovedWhileHeld", stat(handlerRemovedPath)),
    escalationArmed: () => track("escalationArmed", waitForFile(escalationArmedPath)),
    escalationAwaited: () => track("escalationAwaited", waitForFile(escalationAwaitedPath)),
    releaseEscalation: () => track("releaseEscalation", writeFile(escalationReleasePath, "")),
    ready: () =>
      track(
        "ready",
        waitWhileRunning(readyLine.promise).then((line) => {
          expect(line).toBe(`emend: serving https://${name}\n`);
        }),
      ),
    signal(signal: NodeJS.Signals, target: "process" | "group" = "process") {
      const count = ++signalCount;
      return track(
        `signal ${signal} #${count} acknowledged`,
        (async () => {
          const records = (text: string | undefined) => (text ?? "").split("\n").slice(0, -1);
          process.kill(target === "group" ? -(child.pid as number) : (child.pid as number), signal);
          await waitForFile(signalsPath, (text) => records(text).length >= count);
          expect(records(await readFile(signalsPath, "utf8"))[count - 1]).toBe(signal);
        })(),
      );
    },
    holdCleanup: () => track("holdCleanup", writeFile(holdPath, "")),
    releaseCleanup: () => track("releaseCleanup", writeFile(releasePath, "")),
  };
}

test.each([
  ["process", "SIGHUP", "SIGHUP"],
  ["process", "SIGTERM", "SIGINT"],
  ["group", "SIGHUP", "SIGHUP"],
  ["group", "SIGTERM", "SIGINT"],
] as const)("signals to the %s: %s then %s allow cleanup to finish", async (target, first, second) => {
  const f = await fixture();
  await f.ready();
  expect(f.child.pid).toBeTypeOf("number");
  await f.holdCleanup();
  await f.signal(first, target);
  // The fake holds the cleanup status call so the next real signal lands during it.
  await f.gateEntered();
  await f.signal(second, target);
  await f.releaseCleanup();
  expect(await f.closed).toEqual({ code: 0, signal: null });
  expect(await f.stderr()).toBe("");
  expect((await f.calls()).map((call) => call.args).filter((args) => args === "serve --https=443 off")).toHaveLength(1);
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
  await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(join(f.stateDir, "server-url.json"), "utf8"))).toEqual({
    baseUrl: `https://${name}`,
  });
});

test("a detached Tailscale child is still killed by the ten-second timeout", async () => {
  const f = await fixture({ timeout: true });
  await f.gateEntered();
  expect(await f.calls(), await f.stderr()).toHaveLength(1);
  const pid = (await f.calls())[0]?.pid;
  expect(pid).toBeTypeOf("number");
  // A negative pid addresses the group: this must be the fake's own group, not emend's.
  expect(() => process.kill(-(pid as number), 0)).not.toThrow();
  expect(await f.closed).toEqual({ code: 1, signal: null });
  expect(await f.stderr()).toBe("emend: tailscale did not answer within 10 seconds.\n");
  expect(() => process.kill(pid as number, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}, 15_000);

test("startup SIGTERM waits for the referenced escalation after the launcher exits", async () => {
  const f = await fixture({ timeout: true, stubbornDescendant: true });
  await f.gateEntered();
  const descendant = await f.descendantPid();
  process.kill(f.child.pid as number, "SIGTERM");
  expect(await f.closed).toEqual({ code: 143, signal: null });
  await pollUntil(async () => expect(await stopped(descendant)).toBe(true));
  expect(await f.stderr()).toBe("");
  expect((await f.calls()).map((call) => call.args)).toEqual(["status --json"]);
  await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("SIGTERM during listen closes the late server and exits 143", async () => {
  const f = await fixture({ phase: "listen", socketDouble: true });
  await f.gateEntered();
  await f.signal("SIGTERM");
  await f.releaseCleanup();
  expect(await f.exited).toEqual({ code: 143, signal: null });
  expect(await f.closed).toEqual({ code: 143, signal: null });
  expect(await f.socketClosed()).toBe("closed");
  expect(await f.stderr()).toBe("");
  expect((await f.calls()).map((call) => call.args)).toEqual(["status --json"]);
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
  await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["SIGTERM", "SIGHUP"] as const)(
  "a second %s while startup escalation is pending cannot leave a descendant alive",
  async (second) => {
    const f = await fixture({ timeout: true, stubbornDescendant: true, holdEscalation: true });
    await f.gateEntered();
    const launcher = await f.startedPid();
    const descendant = await f.descendantPid();
    await f.signal("SIGTERM");
    await f.escalationArmed();
    // The launcher's default SIGTERM disposition stops its pid while the descendant ignores TERM.
    await f.track(
      "launcher stopped",
      pollUntil(async () => expect(await stopped(launcher)).toBe(true)),
    );
    expect(await f.track("descendant alive check", stopped(descendant))).toBe(false);
    // If production stops awaiting through Promise.all, this marker wait fails at the test timeout.
    await f.escalationAwaited();
    await f.signal(second);
    await f.releaseEscalation();
    expect(await f.track("emend closed", f.closed)).toEqual({ code: 143, signal: null });
    await f.track(
      "descendant stopped",
      pollUntil(async () => expect(await stopped(descendant)).toBe(true)),
    );
    expect(await f.stderr()).toBe("");
    expect((await f.calls()).map((call) => call.args)).toEqual(["status --json"]);
    await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(f.handlerRemovedWhileHeld()).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const)("%s forces exit %s after startup cleanup despite an unrelated open handle", async (signal, code) => {
  const f = await fixture({ timeout: true, keepAlive: true });
  await f.gateEntered();
  const launcher = await f.startedPid();
  process.kill(f.child.pid as number, signal);
  expect(await f.exited).toEqual({ code, signal: null });
  expect(await f.closed).toEqual({ code, signal: null });
  expect(await stopped(launcher)).toBe(true);
  expect(await f.stderr()).toBe("");
  expect((await f.calls()).map((call) => call.args)).toEqual(["status --json"]);
  await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([false, true])(
  "SIGTERM during --bg removes only the applied setup (socket double: %s)",
  async (socketDouble) => {
    const f = await fixture({ phase: "bg", socketDouble });
    await f.gateEntered();
    const config = JSON.parse(await readFile(f.configPath, "utf8"));
    expect(config.Web[`${name}:443`].Handlers["/"].Proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await f.signal("SIGTERM");
    await f.releaseCleanup();
    expect(await f.closed).toEqual({ code: 0, signal: null });
    expect(await f.stderr()).toBe("");
    expect((await f.calls()).map((call) => call.args)).toEqual([
      "status --json",
      "serve status --json",
      `serve --bg --https=443 ${config.Web[`${name}:443`].Handlers["/"].Proxy}`,
      "serve status --json",
      "serve --https=443 off",
    ]);
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
    await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(f.stateDir, "server-url.json"), "utf8"))).toEqual({
      baseUrl: config.Web[`${name}:443`].Handlers["/"].Proxy,
    });
  },
);

test.each([false, true])(
  "a closed stdout pipe keeps serving and later SIGTERM cleans up (socket double: %s)",
  async (socketDouble) => {
    const f = await fixture({ phase: "bg", socketDouble, closedStdout: true });
    await f.gateEntered();
    await f.releaseCleanup();
    expect(await f.stdoutError()).toBe("EPIPE");
    expect(f.child.exitCode, await f.stderr()).toBeNull();
    expect((await stat(join(f.stateDir, "server.json"))).isFile()).toBe(true);
    process.kill(f.child.pid as number, "SIGTERM");
    expect(await f.closed).toEqual({ code: 0, signal: null });
    expect(await f.stderr()).toBe("");
    expect((await f.calls()).filter((call) => call.args === "serve --https=443 off")).toHaveLength(1);
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
    await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const)("%s before listening exits %s and kills the detached status call", async (signal, code) => {
  const f = await fixture({ timeout: true });
  await f.gateEntered();
  const fakePid = await f.startedPid();
  expect(fakePid).toBeGreaterThan(0);
  process.kill(f.child.pid as number, signal);
  expect(await f.closed).toEqual({ code, signal: null });
  await pollUntil(() => expect(() => process.kill(fakePid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" })));
  expect(await f.stderr()).toBe("");
  expect((await f.calls()).map((call) => call.args)).toEqual(["status --json"]);
  await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
  ["off", "SIGHUP", "SIGHUP"],
  ["off", "SIGTERM", "SIGINT"],
  ["close", "SIGHUP", "SIGHUP"],
  ["close", "SIGTERM", "SIGINT"],
] as const)("a second signal during %s (%s then %s) lets cleanup finish", async (phase, first, second) => {
  const f = await fixture({ phase, socketDouble: true });
  await f.ready();
  await f.signal(first, "group");
  await f.gateEntered();
  await f.signal(second, "group");
  await f.releaseCleanup();
  expect(await f.closed).toEqual({ code: 0, signal: null });
  expect(await f.stderr()).toBe("");
  expect((await f.calls()).filter((call) => call.args === "serve --https=443 off")).toHaveLength(1);
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
  await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["throw", "event"] as const)(
  "SIGHUP with failed removal and stderr %s still closes before reporting",
  async (stderrFailure) => {
    const f = await fixture({ stderrFailure, socketDouble: true });
    await f.ready();
    process.kill(f.child.pid as number, "SIGHUP");
    expect(await f.closed).toEqual({ code: 0, signal: null });
    await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.reports()).toEqual([{ discovery: false }]);
    expect((await f.calls()).filter((call) => call.args === "serve --https=443 off")).toHaveLength(1);
  },
);

test("teardown never signals a completed call's old pid", async () => {
  const f = await fixture({ socketDouble: true });
  await f.ready();
  // This owned sentinel stands in for a pid reused since an earlier fake exited.
  const sentinel = spawn(process.execPath, ["-e", 'process.stdin.on("data", () => process.stdout.write("alive\\n"))'], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { PATH: process.env.PATH, HOME: entryDir, LC_ALL: "C" },
  });
  const done = new Promise<void>((resolve) => sentinel.once("close", () => resolve()));
  onTestFinished(async () => {
    if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill("SIGKILL");
    await done;
  });
  await f.logOldPid(sentinel.pid as number);
  process.kill(f.child.pid as number, "SIGTERM");
  await f.closed;
  await f.cleanup();
  // An answer after teardown proves the owned sentinel is still running.
  const alive = once(sentinel.stdout, "data");
  sentinel.stdin.write("ping\n");
  expect((await alive)[0].toString()).toBe("alive\n");
  expect(sentinel.signalCode).toBeNull();
  expect(() => process.kill(sentinel.pid as number, 0)).not.toThrow();
});
