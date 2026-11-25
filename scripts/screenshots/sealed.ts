// Shared sealed lifecycle for screenshots and performance measurements.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, DESKTOP, findChromium, type Page, type Viewport } from "./browser.ts";
import {
  assertOutputFolder,
  assertTempParent,
  assertPortAvailable,
  assertProfileUsed,
  assertSealedPaths,
  canonicalPath,
  childEnvironment,
  currentProtectedStateDirs,
  maySignalGroup,
  parsePairingLink,
  sealedOrigin,
} from "./safety.ts";

export function createSealedLifecycle(label: string) {
  // Every child, with whether it leads its own process group (Chromium does, so its helpers die too).
  const children = new Map<ChildProcess, boolean>();
  let root: string | undefined;
  let keep = false;
  const extraRoots: string[] = [];
  let cleaning: Promise<void> | undefined;
  let aborted = false;
  const removeListeners: (() => void)[] = [];

  function assertRunning(): void {
    if (aborted) throw new Error("The run is ending");
  }

  function track(child: ChildProcess, group = false): void {
    children.set(child, group);
    child.once("close", () => children.delete(child));
    // The kernel keeps the group number reserved while members remain, so one sweep from the leader's
    // own exit reaches helpers left behind; after it the group is never signalled again. If no member
    // is left, the number is free after the reap, but the sweep runs in the same tick and process ids
    // are handed out in rising order, so a reuse would need a full wrap first.
    if (group)
      child.once("exit", () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // No member left.
        }
        sweptGroups.add(child);
      });
    // A child that appears after cleanup began is never left running.
    if (aborted) signalChild(child, "SIGKILL");
  }

  // Groups already swept from their leader's exit: never signalled again (the number may be reused).
  const sweptGroups = new WeakSet<ChildProcess>();

  function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (children.get(child) && child.pid) {
        if (maySignalGroup(child, sweptGroups.has(child))) process.kill(-child.pid, signal);
      } else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } catch {
      // Already gone.
    }
  }

  function removeRoot(): void {
    if (keep) return;
    for (const folder of [root, ...extraRoots]) {
      if (!folder) continue;
      try {
        rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        console.error(`${label}: could not remove ${folder}`);
      }
    }
  }

  /** Resolves when every tracked child has exited, or after `ms`, whichever is first. */
  async function childrenExited(ms: number): Promise<void> {
    const exited = [...children.keys()].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", () => resolve());
        }),
    );
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(exited),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }

  async function doCleanup(): Promise<void> {
    aborted = true;
    for (const child of children.keys()) signalChild(child, "SIGTERM");
    await childrenExited(4000);
    // Kill whatever is left, and sweep each process group once more for helpers.
    for (const child of children.keys()) signalChild(child, "SIGKILL");
    await childrenExited(5000);
    removeRoot();
    for (const remove of removeListeners) remove();
    if (keep) for (const folder of [root, ...extraRoots]) if (folder) console.log(`Kept the sealed folder: ${folder}`);
  }

  /** One cleanup for the whole process: every caller awaits the same promise. */
  const cleanup = (): Promise<void> => {
    cleaning ??= doCleanup();
    return cleaning;
  };

  // One exit decision: the first reason wins (signal, fatal error or success), and the process exits
  // once, after cleanup finished.
  let exitCode: number | undefined;
  let exiting = false;
  function terminate(code: number): void {
    exitCode ??= code;
    if (exiting) return;
    exiting = true;
    void cleanup().finally(() => process.exit(exitCode));
  }

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    const handler = () => terminate(code);
    process.on(signal, handler);
    removeListeners.push(() => process.off(signal, handler));
  }
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    const handler = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${label}: ${event}: ${message}`);
      terminate(1);
    };
    process.on(event, handler);
    removeListeners.push(() => process.off(event, handler));
  }
  // A synchronous last resort if the process ends without the async cleanup having finished.
  const onExit = () => {
    for (const child of children.keys()) signalChild(child, "SIGKILL");
    removeRoot();
  };
  process.on("exit", onExit);
  removeListeners.push(() => process.off("exit", onExit));

  function step(text: string): void {
    console.log(`- ${text}`);
  }

  interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
  }

  function run(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; input?: string; timeoutMs?: number; group?: boolean },
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      assertRunning();
      // A command that must not outlive cleanup (the pty and what runs under it) gets its own group.
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: options.group === true,
      });
      track(child, options.group === true);
      // A command that never ends is killed; the caller reports the exit code only.
      const timer = setTimeout(() => signalChild(child, "SIGKILL"), options.timeoutMs ?? 120_000);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(options.input ?? "");
    });
  }

  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
  }

  function createRoot(out: string, identity: { name: string; email: string }) {
    // ---- The sealed root --------------------------------------------------------------------
    const realStateDirs = currentProtectedStateDirs();
    assertOutputFolder(out, realStateDirs, canonicalPath);
    const tmpDir = realpathSync(tmpdir());
    assertTempParent(tmpDir, realStateDirs, canonicalPath);
    root = mkdtempSync(join(tmpDir, `recense-${label}-`));
    const sealedRoot = root;
    const env = childEnvironment(sealedRoot, process.platform);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR"])
      mkdirSync(env[key] as string, { recursive: true });
    mkdirSync(env.XDG_RUNTIME_DIR as string, { recursive: true, mode: 0o700 });
    mkdirSync(env.RECENSE_HOME as string, { recursive: true, mode: 0o700 });
    assertSealedPaths(
      {
        root: sealedRoot,
        tmpDir,
        recenseHome: env.RECENSE_HOME as string,
        realStateDirs,
      },
      canonicalPath,
    );
    writeFileSync(
      env.GIT_CONFIG_GLOBAL as string,
      `[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n` +
        "[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n",
    );

    return { sealedRoot, env, realStateDirs, tmpDir };
  }
  function git(cwd: string, env: Record<string, string>, ...args: string[]): string {
    assertRunning();
    return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }
  async function startServer(
    entry: string,
    sealedRoot: string,
    env: Record<string, string>,
    instanceId: string,
    probeOnly = false,
    fixedPort?: number,
  ) {
    const port = fixedPort ?? await freePort();
    const origin = sealedOrigin(port);
    writeFileSync(join(env.RECENSE_HOME as string, "instance.json"), JSON.stringify({ id: instanceId, name: "laptop" }), {
      mode: 0o600,
    });

    async function launch() {
      await assertPortAvailable(port);
      // ---- The server -------------------------------------------------------------------------
      step("starting a sealed server");
      assertRunning();
      const server = spawn(process.execPath, [entry, "serve", "--port", String(port)], {
        cwd: sealedRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      track(server);
      const exited = new Promise<void>((done) => server.once("exit", () => done()));
      async function stopServer() {
        signalChild(server, "SIGTERM");
        const force = setTimeout(() => signalChild(server, "SIGKILL"), 4000);
        let deadline: NodeJS.Timeout | undefined;
        try {
          if (server.pid) {
            await Promise.race([
              exited,
              new Promise<never>((_, reject) => {
                deadline = setTimeout(() => reject(new Error("The sealed server did not exit after SIGKILL")), 9000);
              }),
            ]);
          }
        } finally {
          clearTimeout(force);
          clearTimeout(deadline);
          // A descendant can keep the write ends open after the server exits.
          server.stdout.destroy();
          server.stderr.destroy();
        }
      }
      let spawnError: Error | undefined;
      server.once("error", (error) => { spawnError = error; });
      let serverLog = "";
      server.stdout.setEncoding("utf8").on("data", (chunk: string) => (serverLog += chunk));
      server.stderr.setEncoding("utf8").on("data", (chunk: string) => (serverLog += chunk));
      const serverAlive = () => {
        if (spawnError) throw spawnError;
        if (server.exitCode !== null || server.signalCode !== null)
          throw new Error(`The sealed server stopped: ${serverLog.trim().slice(-300)}`);
      };
      try {
        if (!probeOnly)
          for (let i = 0; ; i++) {
            serverAlive();
            if (serverLog.includes(`recense is serving ${origin}`)) break;
            if (i > 300) throw new Error("The sealed server did not start");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        // node:http to the literal loopback address: no redirects, no proxy environment, no resolver.
        const probeStatus = () =>
          new Promise<number>((resolve, reject) => {
            const probe = request(
              { host: "127.0.0.1", port, path: "/api/v1/capabilities", method: "GET", agent: false, timeout: 10_000 },
              (response) => {
                response.resume();
                resolve(response.statusCode ?? 0);
              },
            );
            probe.once("timeout", () => probe.destroy(new Error("The sealed server did not answer")));
            probe.once("error", reject);
            probe.end();
          });
        let status = 0;
        if (probeOnly) {
          for (let attempt = 0; attempt <= 300; attempt++) {
            serverAlive();
            status = await probeStatus().catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ECONNREFUSED") return 0;
              throw error;
            });
            if (status === 200) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        } else status = await probeStatus();
        if (status !== 200) throw new Error("The sealed server does not answer");
        const record = JSON.parse(readFileSync(join(env.RECENSE_HOME as string, "server.json"), "utf8")) as { url?: string };
        if (new URL(record.url ?? "http://invalid").origin !== origin)
          throw new Error("The sealed server record names another URL");
      } catch (error) {
        await stopServer();
        throw error;
      }

      const cli = async (args: string[], cwd: string, timeoutMs?: number): Promise<string> => {
        serverAlive();
        const result = await run(process.execPath, [entry, ...args], { cwd, env, ...(timeoutMs ? { timeoutMs } : {}) });
        if (result.code !== 0) throw new Error(`recense ${args[0]} failed: ${result.stderr.trim().slice(0, 300)}`);
        return result.stdout;
      };
      return { cli, serverAlive, stopServer };
    }
    let running = await launch();
    return {
      port, origin,
      cli: (...args: Parameters<typeof running.cli>) => running.cli(...args),
      serverAlive: () => running.serverAlive(),
      async restart(beforeStart?: () => void) {
        await running.stopServer();
        assertRunning();
        beforeStart?.();
        running = await launch();
        return running.cli;
      },
    };
  }
  async function pairingLink(entry: string, sealedRoot: string, env: Record<string, string>, origin: string) {
    const pairCommand = [process.execPath, entry, "pair"];
    const quoted = pairCommand.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
    const scriptArgs =
      process.platform === "darwin" ? ["-q", "/dev/null", ...pairCommand] : ["-qec", quoted, "/dev/null"];
    const paired = await run("script", scriptArgs, { cwd: sealedRoot, env, timeoutMs: 60_000, group: true });
    if (paired.code !== 0) throw new Error(`The pairing command exited with code ${paired.code}`);
    return parsePairingLink(paired.stdout, origin);
  }
  async function signIn(
    entry: string,
    sealedRoot: string,
    env: Record<string, string>,
    server: Awaited<ReturnType<typeof startServer>>,
    chromium?: string,
    viewport: Viewport = DESKTOP,
    preserveMotion = false,
  ) {
    const { port, origin, serverAlive } = server;
    // ---- Sign in ----------------------------------------------------------------------------
    step("signing in through a pty");
    serverAlive();
    const link = await pairingLink(entry, sealedRoot, env, origin);

    step("starting a sealed browser");
    assertRunning();
    const executable = findChromium(chromium, process.platform);
    const browser = await Browser.launch({
      executable,
      preserveMotion,
      profile: join(sealedRoot, "chromium"),
      env,
      port,
      platform: process.platform,
      onSpawn: (child) => track(child, true),
    });
    // Chromium answered on the pipe, so it has started; before any page opens the sealed origin, it
    // must have used the throwaway profile folder.
    assertProfileUsed(join(sealedRoot, "chromium"));
    const desktop = await browser.newPage(viewport);
    await desktop.goto(link);
    await desktop.waitFor("location.pathname === '/'", "the signed-in inbox");
    await desktop.settle("the empty inbox");

    return { browser, desktop };
  }
  return {
    cleanup,
    createRoot,
    startServer,
    pairingLink,
    signIn,
    run,
    git,
    track,
    assertRunning,
    setKeep(value: boolean) {
      keep = value;
    },
    // Register immediately after mkdtemp, before export or build can fail.
    addRoot(folder: string) {
      assertRunning();
      extraRoots.push(folder);
    },
    finish(error?: Error) {
      if (error && exitCode === undefined) console.error(`${label}: ${error.message}`);
      terminate(error ? 1 : 0);
    },
  };
}

export async function api(page: Page, method: string, path: string, body?: unknown) {
  const result = await page.eval<{ status: number; text: string }>(
    `(async () => { const response = await fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, ` +
      `headers: { 'content-type': 'application/json' }${body === undefined ? "" : `, body: ${JSON.stringify(JSON.stringify(body))}`} }); ` +
      "return { status: response.status, text: await response.text() }; })()",
  );
  if (result.status >= 300)
    throw new Error(`${method} ${path} answered ${result.status}: ${result.text.slice(0, 300)}`);
  return result.text ? (JSON.parse(result.text) as Record<string, unknown>) : {};
}
