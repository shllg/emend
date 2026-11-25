// A worktree's long-running copy of the screenshot round. Only its start process replaces the
// served build. The port, CLI, database and signed-in browser sessions survive a web rebuild.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type DemoRound, startSealedDemo } from "./screenshots/demo.ts";
import {
  assertSealedPaths, canonicalPath, childEnvironment, currentProtectedStateDirs, sealedOrigin,
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

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid UI demo pid");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function readState(top: string): DemoState {
  return JSON.parse(readFileSync(stateFile(top), "utf8"));
}

function saveState(top: string, state: DemoState): void {
  const file = stateFile(top);
  const temp = `${file}.${randomUUID()}`;
  try {
    writeFileSync(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function runningDemo(top: string) {
  const port = worktreePort(top);
  const state = readState(top);
  if (state.port !== port || state.origin !== sealedOrigin(port) || !isAlive(state.pid))
    throw new Error("Expected a live demo on this worktree's port");
  const { root } = state;
  const tmpDir = realpathSync(tmpdir());
  const env = childEnvironment(root, process.platform);
  assertSealedPaths({ root, tmpDir, recenseHome: env.RECENSE_HOME, realStateDirs: currentProtectedStateDirs() }, canonicalPath);
  const info = lstatSync(root);
  if (dirname(root) !== tmpDir || !basename(root).startsWith("recense-ui-demo-") || !info.isDirectory() ||
      info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("Expected a private UI demo folder");
  // A stale pid can be reused. Check that the controller still owns the live sealed server.
  const server = JSON.parse(readFileSync(join(env.RECENSE_HOME, "server.json"), "utf8"));
  if (server.url !== state.origin || !Number.isSafeInteger(server.pid) || server.pid <= 0 ||
      Number(execFileSync("ps", ["-o", "ppid=", "-p", String(server.pid)], { cwd: root, env, encoding: "utf8" })) !== state.pid)
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
      res.on("end", () => res.statusCode === 200 ? done(Buffer.concat(chunks)) : reject(new Error("Index unavailable")));
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

export async function startDemo(top: string, round?: DemoRound) {
  const port = worktreePort(top);
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
    saveState(top, state);
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
    saveState(top, state);
    return { root, origin, reviewId, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

function buildWeb(top: string): void {
  // Only the checkout build inherits the parent environment. Every sealed child gets childEnvironment.
  execFileSync("pnpm", ["--dir", "apps/web", "build"], { cwd: top, env: process.env, stdio: "inherit" });
}

export async function rebuild(top: string, build: (top: string) => void | Promise<void> = buildWeb): Promise<string> {
  const { state } = runningDemo(top);
  const staging = join(state.root, "rebuild");
  mkdirSync(staging, { mode: 0o700 }); // Only one writer may build from this worktree at a time.
  try {
    await build(top);
    copyWeb(webDist(top), join(staging, "web"));
    const current = runningDemo(top).state;
    if (current.root !== state.root || current.pid !== state.pid) throw new Error("The UI demo changed during the build");
    const request = randomUUID();
    // Publish the request only after its ID is fully written for the controller's next poll.
    const pending = join(staging, "request");
    writeFileSync(pending, request, { mode: 0o600 });
    renameSync(pending, join(staging, "ready"));
    const deadline = Date.now() + 45_000;
    do {
      await delay(100);
      const ack = readState(top);
      if (ack.root !== state.root || !isAlive(state.pid)) throw new Error("The UI demo stopped during rebuild");
      if (ack.result?.request === request) {
        if (ack.result.error) throw new Error(ack.result.error);
        if (ack.build !== state.build + 1 || ack.reviewId !== state.reviewId) throw new Error("Unexpected demo rebuild result");
        return state.origin;
      }
    } while (Date.now() < deadline);
    throw new Error("Timed out waiting for the UI demo to restart and verify the rebuilt index.html");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function pair(top: string): Promise<string> {
  const { state, env } = runningDemo(top);
  const sealed = createSealedLifecycle("ui-demo pair");
  try {
    return await sealed.pairingLink(join(state.root, "app", "recense.mjs"), state.root, env, state.origin);
  } finally {
    await sealed.cleanup();
  }
}

if (import.meta.main) {
  const [command, ...extra] = process.argv.slice(2);
  try {
    if (extra.length || !["start", "rebuild", "pair"].includes(command)) {
      console.error("Usage: node scripts/ui-demo.ts <start | rebuild | pair>");
      process.exitCode = 2;
    } else if (command === "start") {
      const demo = await startDemo(checkout);
      console.log(`origin: ${demo.origin}\nreview: ${demo.origin}/r/${demo.reviewId}`);
    } else if (command === "rebuild") console.log(await rebuild(checkout));
    else console.log(await pair(checkout));
  } catch (error) {
    console.error(`ui-demo: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
