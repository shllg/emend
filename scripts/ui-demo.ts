// A worktree's long-running copy of the screenshot round. Only its start process replaces the
// served build. The port, CLI, database and signed-in browser sessions survive a web rebuild.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:http";
import { constants, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type DemoRound, startSealedDemo } from "./screenshots/demo.ts";
import {
  assertSafePort, assertSealedPaths, canonicalPath, childEnvironment, currentProtectedStateDirs,
  sealedOrigin,
} from "./screenshots/safety.ts";
import { createSealedLifecycle } from "./screenshots/sealed.ts";
import { worktreePort } from "./ui-browser-mcp.ts";

const checkout = resolve(import.meta.dirname, "..");

interface DemoState {
  pid: number;
  port: number;
  origin: string;
  root: string;
  reviewId: string;
  build: number;
  result?: { request: string; error?: string };
}

const stateFile = (top: string) => join(top, ".wt", "ui-demo.json");
const webDist = (top: string) => join(top, "apps", "web", "dist");

function isAlive(pid: number, group = false): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid UI demo pid");
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

function readState(top: string): DemoState {
  return JSON.parse(readFileSync(stateFile(top), "utf8"));
}

function writeJson(file: string, value: object): void {
  const temp = `${file}.${randomUUID()}`;
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function runningDemo(top: string, port = worktreePort(top), state = readState(top)) {
  if (state.port !== port || state.origin !== sealedOrigin(port) || !isAlive(state.pid))
    throw new Error("Expected a live demo on this worktree's port");
  const { root } = state;
  const tmpDir = realpathSync(tmpdir());
  const env = childEnvironment(root, process.platform);
  assertSealedPaths({
    root, tmpDir, recenseHome: env.RECENSE_HOME, realStateDirs: currentProtectedStateDirs(),
  }, canonicalPath);
  const info = lstatSync(root);
  if (dirname(root) !== tmpDir || !basename(root).startsWith("recense-ui-demo-") ||
      !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("Expected a private UI demo folder");
  // A stale pid can be reused. Check that the controller still owns the live sealed server.
  const server = JSON.parse(readFileSync(join(env.RECENSE_HOME, "server.json"), "utf8"));
  if (server.url !== state.origin || !Number.isSafeInteger(server.pid) || server.pid <= 0)
    throw new Error("The UI demo process no longer owns this server");
  const parentPid = execFileSync("ps", ["-o", "ppid=", "-p", String(server.pid)], {
    cwd: root, env, encoding: "utf8",
  });
  if (Number(parentPid) !== state.pid)
    throw new Error("The UI demo process no longer owns this server");
  return { state, env };
}

function copyWeb(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true, filter: (path) => basename(path) !== ".vite" });
}

function servedIndex(origin: string): Promise<Buffer> {
  return new Promise((done, reject) => {
    const req = get(origin + "/", { agent: false, timeout: 2000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("error", reject);
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode === 200) done(Buffer.concat(chunks));
        else reject(new Error("Index unavailable"));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Index request timed out")));
  });
}

async function waitForIndex(origin: string, expected: Buffer): Promise<void> {
  const deadline = Date.now() + 10_000;
  do {
    const bytes = await servedIndex(origin).catch(() => undefined);
    if (bytes?.equals(expected)) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for the demo to serve the rebuilt index.html");
}

export async function startDemo(top: string, round?: DemoRound, port = worktreePort(top)) {
  assertSafePort(port);
  if (existsSync(stateFile(top)) && isAlive(readState(top).pid))
    throw new Error("This worktree already has a live UI demo");
  const cliDist = join(top, "apps", "recense", "dist");
  if (!existsSync(join(cliDist, "recense.mjs")) || !existsSync(join(webDist(top), "index.html")))
    throw new Error("Run pnpm build first.");

  const demo = await startSealedDemo({
    keep: false, port, out: join(top, ".wt", "ui"),
    entry(root) {
      const app = join(root, "app");
      cpSync(cliDist, app, { recursive: true, filter: (path) => path !== join(cliDist, "web") });
      copyWeb(webDist(top), join(app, "web"));
      return join(app, "recense.mjs");
    },
  }, round);
  const { root, origin, reviewId } = demo;
  const state: DemoState = { pid: process.pid, port, root, origin, reviewId, build: 0 };

  // The requester holds rebuild/ until it receives its result. Take ownership of the complete
  // build before the first await, so even a requester timeout cannot remove files being installed.
  const staging = join(root, "rebuild");
  const ready = join(staging, "ready");
  const incoming = join(root, "incoming-web");
  const previous = join(root, "previous-web");
  const web = join(root, "app", "web");
  async function install() {
    const request = readFileSync(ready, "utf8");
    rmSync(ready);
    try {
      renameSync(join(staging, "web"), incoming);
      const expected = readFileSync(join(incoming, "index.html"));
      // The server caches pub-frame.css. Stop it before exchanging the web directories.
      const cli = await demo.restart(() => {
        renameSync(web, previous);
        renameSync(incoming, web);
      });
      await waitForIndex(origin, expected);
      const reviews = JSON.parse(await cli(["ls", "--json"], root, 10_000));
      if (!reviews.items.some((item: { id: string }) => item.id === reviewId))
        throw new Error("The demo review is missing after restart");
      rmSync(previous, { recursive: true });
      state.build++;
      state.result = { request };
    } catch (error) {
      if (existsSync(previous)) {
        await demo.restart(() => {
          rmSync(web, { force: true, recursive: true });
          renameSync(previous, web);
        });
      }
      rmSync(incoming, { force: true, recursive: true });
      state.result = { request, error: error instanceof Error ? error.message : String(error) };
    }
    writeJson(stateFile(top), state);
  }

  let installing: Promise<void> | undefined;
  let poll: NodeJS.Timeout | undefined;
  function pollRebuild() {
    if (installing || !existsSync(ready)) return;
    installing = install().catch(async (error) => {
      console.error("Could not recover the UI demo:", error.message);
      await stop();
      process.exitCode = 1;
    }).finally(() => { installing = undefined; });
  }
  function forgetState() {
    if (existsSync(stateFile(top)) && readState(top).root === root) rmSync(stateFile(top));
  }
  async function stop() {
    clearInterval(poll);
    await demo.stop();
    forgetState();
    process.off("exit", forgetState);
  }
  try {
    if (demo.browser) {
      demo.browser.check();
      await demo.browser.close();
    }
    poll = setInterval(pollRebuild, 200).unref();
    process.once("exit", forgetState);
    writeJson(stateFile(top), state);
    return { root, origin, reviewId, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function stop(top: string, port?: number): Promise<void> {
  const file = stateFile(top);
  if (!lstatSync(file, { throwIfNoEntry: false })) {
    console.log("No UI demo runs in this worktree.");
    return;
  }
  const state = readState(top);
  if (!isAlive(state.pid)) {
    rmSync(file);
    return;
  }
  runningDemo(top, port, state);
  process.kill(state.pid, "SIGINT");
  const deadline = Date.now() + 15_000;
  do {
    if (!isAlive(state.pid) && !existsSync(file)) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for the UI demo to exit and remove its state file");
}

export function buildWeb(
  top: string, signal: AbortSignal, timeout = 5 * 60_000, staging?: string,
): Promise<void> {
  return new Promise((done, reject) => {
    // EOF before publication means the requester died. Only start pnpm after recording the group.
    // Descriptor 3 preserves the checkout build's original stdin.
    const child = spawn("sh", ["-c", "read -r ready && exec pnpm --dir apps/web build <&3 3<&-"], {
      cwd: top, env: process.env, stdio: ["pipe", "inherit", "inherit", 0], detached: true,
    });
    const killBuild = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killBuild();
    }, timeout);
    signal.addEventListener("abort", killBuild, { once: true });
    if (signal.aborted) killBuild();
    child.once("error", reject);
    child.once("close", (code, cause) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", killBuild);
      if (timedOut) reject(new Error(`Web build timed out after ${timeout} ms`));
      else if (code !== 0) reject(new Error(`Web build exited with ${cause ?? code}`));
      else done();
    });
    const gate = child.stdin!;
    gate.once("error", reject);
    try {
      if (staging && child.pid)
        writeJson(join(staging, "owner"), { pid: process.pid, group: child.pid });
      gate.end("ready\n");
    } catch (error) {
      gate.destroy();
      reject(error);
    }
  });
}

function lockOwner(staging: string) {
  let record;
  try {
    record = JSON.parse(readFileSync(join(staging, "owner"), "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const valid = (id: number) => Number.isSafeInteger(id) && id > 0 && id <= 0x7fffffff;
  // Older demos recorded just the requester's pid.
  const pid = typeof record === "number" ? record : record?.pid;
  return {
    pid: valid(pid) ? pid : undefined,
    group: valid(record?.group) ? record.group : undefined,
  };
}

function takeRebuildLock(staging: string) {
  const candidate = `${staging}.${randomUUID()}`;
  mkdirSync(candidate, { mode: 0o700 });
  try {
    writeJson(join(candidate, "owner"), { pid: process.pid });
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(candidate, staging);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
        const info = lstatSync(staging, { throwIfNoEntry: false, bigint: true });
        const owner = lockOwner(staging);
        if (owner?.pid && isAlive(owner.pid))
          throw new Error(`Another rebuild is running (pid ${owner.pid})`);
        // The requester could have published its group just before it died.
        const group = owner?.group ?? lockOwner(staging)?.group;
        if (group && isAlive(group, true)) {
          const name = `A previous rebuild's web build (process group ${group})`;
          throw new Error(`${name} is still running`);
        }
        if (attempt) throw new Error("Could not acquire the rebuild lock after retrying");
        if (!info || lstatSync(staging, { throwIfNoEntry: false, bigint: true })?.ino !== info.ino)
          continue;
        // Both contenders for this stale inode use the same destination. Keep it nonempty
        // until demo cleanup so a late contender cannot move the next writer's lock.
        try {
          renameSync(staging, `${staging}.stale.${info.ino}`);
        } catch (moveError) {
          const code = (moveError as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw moveError;
        }
      }
    }
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
  return () => {
    // Unpublish the whole lock before deleting its owner and build files.
    if (existsSync(staging)) renameSync(staging, candidate);
    rmSync(candidate, { recursive: true, force: true });
  };
}

export async function rebuild(
  top: string,
  build?: (top: string, signal: AbortSignal) => void | Promise<void>,
  port = worktreePort(top),
): Promise<string> {
  const { state } = runningDemo(top, port);
  const staging = join(state.root, "rebuild");
  const release = takeRebuildLock(staging);
  const controller = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => {
    try {
      controller.abort();
      release();
    } finally {
      process.exit(128 + constants.signals[signal]);
    }
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, interrupt);
  try {
    if (build) await build(top, controller.signal);
    else await buildWeb(top, controller.signal, undefined, staging);
    copyWeb(webDist(top), join(staging, "web"));
    const current = runningDemo(top, port).state;
    if (current.root !== state.root || current.pid !== state.pid)
      throw new Error("The UI demo changed during the build");
    const request = randomUUID();
    // Publish the request only after its ID is fully written for the controller's next poll.
    const pending = join(staging, "request");
    writeFileSync(pending, request, { mode: 0o600 });
    renameSync(pending, join(staging, "ready"));
    const deadline = Date.now() + 45_000;
    do {
      await delay(100);
      const ack = readState(top);
      if (ack.root !== state.root || !isAlive(state.pid))
        throw new Error("The UI demo stopped during rebuild");
      if (ack.result?.request === request) {
        if (ack.result.error) throw new Error(ack.result.error);
        if (ack.build !== state.build + 1 || ack.reviewId !== state.reviewId)
          throw new Error("Unexpected demo rebuild result");
        return state.origin;
      }
    } while (Date.now() < deadline);
    throw new Error("Timed out waiting for the UI demo to restart and verify the rebuilt index.html");
  } finally {
    for (const signal of signals) process.off(signal, interrupt);
    release();
  }
}

async function pair(top: string): Promise<string> {
  const { state, env } = runningDemo(top);
  const sealed = createSealedLifecycle("ui-demo pair");
  try {
    const entry = join(state.root, "app", "recense.mjs");
    return await sealed.pairingLink(entry, state.root, env, state.origin);
  } finally {
    await sealed.cleanup();
  }
}

if (import.meta.main) {
  const [command, ...extra] = process.argv.slice(2);
  try {
    if (extra.length || !["start", "rebuild", "pair", "stop"].includes(command)) {
      console.error("Usage: node scripts/ui-demo.ts <start | rebuild | pair | stop>");
      process.exitCode = 2;
    } else if (command === "start") {
      const demo = await startDemo(checkout);
      console.log(`origin: ${demo.origin}\nreview: ${demo.origin}/r/${demo.reviewId}`);
    } else if (command === "rebuild") console.log(await rebuild(checkout));
    else if (command === "stop") await stop(checkout);
    else console.log(await pair(checkout));
  } catch (error) {
    console.error(`ui-demo: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
