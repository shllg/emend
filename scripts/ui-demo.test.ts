import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, fork, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync, writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildWeb, rebuild, startDemo, stop } from "./ui-demo.ts";

const recense = join(import.meta.dirname, "..", "apps", "recense");
const { build } = createRequire(join(recense, "package.json"))("esbuild");

function startTime(pid: number) {
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, encoding: "utf8",
  }).trim();
}

function writeWeb(dist: string, version: string) {
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), `<!doctype html><title>${version}</title>`);
  writeFileSync(join(dist, "assets", "app.js"), `document.title = '${version}'`);
  writeFileSync(join(dist, "pub-frame.css"), `/* ${version} */`);
}

async function listen() {
  const listener = createServer((socket) => socket.end());
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address === "object");
  return {
    port: address.port,
    close: () => new Promise<void>((done, reject) => {
      listener.close((error) => error ? reject(error) : done());
    }),
  };
}

test("stop handles absent and stale state and refuses a live pid without ownership", async (t) => {
  const top = mkdtempSync(join(tmpdir(), "recense-ui-stop-test-"));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  mkdirSync(join(top, ".wt"));
  const file = join(top, ".wt", "ui-demo.json");
  const port = 40000;
  const calls: (string | number | undefined)[] = [];
  const probe = t.mock.method(process, "kill", (_pid: number, signal?: string | number) => {
    calls.push(signal);
    assert.equal(signal, 0);
    throw Object.assign(new Error("Gone"), { code: "ESRCH" });
  });
  const log = t.mock.method(console, "log", () => {});
  await stop(top, port);
  assert.match(log.mock.calls[0].arguments.join(" "), /no UI demo runs/i);
  assert.deepEqual(calls, []);
  const stale = { phase: "starting", pid: 12345, started: "previous start", port };
  writeFileSync(file, JSON.stringify(stale));
  await stop(top, port);
  assert(!existsSync(file));
  assert.deepEqual(calls, [0]);
  assert.match(log.mock.calls[1].arguments.join(" "), /cleaned up a stale UI demo/i);
  probe.mock.mockImplementation((_pid: number, signal?: string | number) => {
    assert.equal(signal, 0);
    throw Object.assign(new Error("Denied"), { code: "EPERM" });
  });
  const reused = { ...stale, pid: process.pid };
  writeFileSync(file, JSON.stringify(reused));
  await stop(top, port);
  assert(!existsSync(file));
  writeFileSync(file, JSON.stringify(reused));
  await assert.rejects(startDemo(top, undefined, port), /Run pnpm build first/);
  assert(!existsSync(file));

  writeFileSync(file, JSON.stringify({ ...reused, root: top }));
  await assert.rejects(stop(top, port), /private UI demo folder/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...reused, root: top });

  const root = mkdtempSync(join(realpathSync(tmpdir()), "recense-ui-demo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "recense"));
  writeFileSync(join(root, "recense", "server.json"), JSON.stringify({ pid: process.pid }));
  writeFileSync(file, JSON.stringify({ ...stale, root }));
  await stop(top, port);
  assert(!existsSync(root));
  assert(!existsSync(file));
  writeFileSync(file, JSON.stringify({ ...stale, root }));
  await stop(top, port);
  assert(!existsSync(file));

  writeFileSync(file, JSON.stringify({
    phase: "running", pid: process.pid, started: startTime(process.pid), port, origin: "wrong",
    root, reviewId: "demo", build: 0,
  }));
  await assert.rejects(stop(top, port), /worktree's port/);
  assert(existsSync(file));
});

test("stop removes the starting record when SIGINT exits the controller directly", async (t) => {
  const top = mkdtempSync(join(tmpdir(), "recense-ui-stop-test-"));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  mkdirSync(join(top, ".wt"));
  const file = join(top, ".wt", "ui-demo.json");
  const port = 40000;
  const child = spawn(process.execPath, [
    "-e", "setInterval(() => {}, 60_000); process.send('ready')",
  ], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exited = once(child, "exit");
  try {
    const [message] = await Promise.race([once(child, "message"), exited]);
    assert.equal(message, "ready");
    assert(child.pid);
    writeFileSync(file, JSON.stringify({
      phase: "starting", pid: child.pid, started: startTime(child.pid), port,
    }));
    const began = performance.now();
    await stop(top, port);
    assert(performance.now() - began < 5000, "stop kept waiting after the controller exited");
    assert.deepEqual(await exited, [null, "SIGINT"]);
    assert(!existsSync(file));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

test("stale cleanup retains an unreaped server's state and succeeds on retry", async (t) => {
  const tmpDir = realpathSync(tmpdir());
  const top = mkdtempSync(join(tmpDir, "recense-ui-stop-test-"));
  const root = mkdtempSync(join(tmpDir, "recense-ui-demo-"));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const port = 40000;
  mkdirSync(join(top, ".wt"));
  mkdirSync(join(root, "recense"));
  const file = join(top, ".wt", "ui-demo.json");
  writeFileSync(file, JSON.stringify({
    phase: "starting", pid: process.pid, started: "previous start", port, root,
  }));
  const server = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setTimeout(process.exit, 10_000, 1); process.send('ready')",
    join(root, "app", "recense.mjs"),
  ], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exited = once(server, "exit");
  try {
    const [message] = await Promise.race([once(server, "message"), exited]);
    assert.equal(message, "ready");
    writeFileSync(join(root, "recense", "server.json"), JSON.stringify({ pid: server.pid }));
    // Advance past the grace period between deadline checks.
    let now = Date.now();
    const clock = t.mock.method(Date, "now", () => (now += 10_001));
    const kill = process.kill.bind(process);
    let keepAlive = true;
    const signals = t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal !== 0) assert.equal(pid, server.pid);
      if (signal === "SIGKILL") {
        if (keepAlive) return true;
        clock.mock.restore();
      }
      return kill(pid, signal);
    });
    const saved = readFileSync(file, "utf8");
    await assert.rejects(stop(top, port), {
      message: `Timed out waiting for UI demo server pid ${server.pid} to exit after SIGKILL`,
    });
    assert(existsSync(root));
    assert.equal(readFileSync(file, "utf8"), saved);
    keepAlive = false;
    signals.mock.resetCalls();
    await stop(top, port);
    assert.deepEqual(signals.mock.calls.map((call) => call.arguments).filter(([, sig]) => sig), [
      [server.pid, "SIGTERM"], [server.pid, "SIGKILL"],
    ]);
    assert.deepEqual(await exited, [null, "SIGKILL"]);
    assert(!existsSync(root));
    assert(!existsSync(file));
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    await exited;
  }
});

test("the checkout build records its group before running and kills it on timeout", async (t) => {
  const top = mkdtempSync(join(tmpdir(), "recense-web-build-test-"));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const pnpm = join(top, "pnpm");
  const path = process.env.PATH;
  try {
    process.env.PATH = `${top}:/usr/bin:/bin`;
    writeFileSync(pnpm, '#!/bin/sh\ncp owner started && echo "$$" > pid\n', { mode: 0o700 });
    await buildWeb(top, new AbortController().signal, 10_000, top);
    assert.deepEqual(JSON.parse(readFileSync(join(top, "started"), "utf8")), {
      pid: process.pid, group: Number(readFileSync(join(top, "pid"), "utf8")),
    });
    writeFileSync(pnpm, "#!/bin/sh\nexec sleep 60\n");
    await assert.rejects(buildWeb(top, new AbortController().signal, 100), /timed out/);
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
});

test("the demo refuses unsafe ports, rebuilds and stops", { timeout: 120_000 }, async (t) => {
  const tmpDir = realpathSync(tmpdir());
  const top = mkdtempSync(join(tmpDir, "recense-demo-test-"));
  let lastPhase = "setup";
  let controller: ChildProcess | undefined;
  function phase(name: string) {
    lastPhase = name;
    t.diagnostic(name);
  }
  // The runner can time out while the test body is still waiting on a live resource.
  const watchdog = setTimeout(() => {
    const resources = JSON.stringify(process.getActiveResourcesInfo());
    writeSync(2, `UI demo stalled after ${lastPhase}. Active resources: ${resources}\n`);
    if (controller && controller.exitCode === null && controller.signalCode === null)
      controller.kill("SIGINT");
    process.exit(1);
  }, 150_000).unref();
  try {
    const wt = join(top, ".wt");
    const cliDist = join(top, "apps", "recense", "dist");
    const web = join(top, "apps", "web", "dist");
    mkdirSync(wt);
    writeFileSync(join(top, ".git"), "gitdir: synthetic");
    const stateFile = join(wt, "ui-demo.json");
    const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
    await assert.rejects(startDemo(top, undefined, 3636), /3636 is reserved/);

    const listener = await listen();
    const { port } = listener;
    try {
      await assert.rejects(startDemo(top, undefined, port), /Run pnpm build first/);
      phase("refusals done");
      // CI has no checkout build. Use the CLI and worker entries from apps/recense/build.ts.
      await build({
        entryPoints: {
          recense: join(recense, "src", "cli.ts"),
          "publish-worker": join(recense, "src", "server", "publish", "worker.ts"),
        },
        outdir: cliDist,
        outExtension: { ".js": ".mjs" },
        bundle: true,
        platform: "node",
        target: "node24",
        format: "esm",
        external: ["node:*"],
      });
      phase("CLI bundled");
      writeWeb(web, "first");
      mkdirSync(join(web, ".vite"));
      writeFileSync(join(web, ".vite", "manifest.json"), "{}");
      mkdirSync(join(cliDist, "web"));
      writeFileSync(join(cliDist, "web", "stale.txt"), "stale");
      // Two starts contend after the first clears a stale record and before it can claim its own.
      writeFileSync(stateFile, JSON.stringify({
        phase: "starting", pid: process.pid, started: "previous start", port,
      }));
      await Promise.all([
        assert.rejects(startDemo(top, undefined, port), /already has a live UI demo/),
        assert.rejects(startDemo(top, undefined, port), /already accepts connections/),
      ]);
      assert(!existsSync(stateFile));
      phase("port-in-use refused");
    } finally {
      await listener.close();
    }

    function forkController(...args: string[]) {
      const child = fork(join(import.meta.dirname, "fixtures", "ui-demo-controller.ts"), [
        top, String(port), ...args,
      ], { execArgv: [] });
      controller = child;
      const exited = once(child, "exit");
      const ready = Promise.race([
        once(child, "message"),
        exited.then(([code]) => { throw new Error(`Demo exited before publishing: ${code}`); }),
      ]);
      return { child, ready, exited };
    }
    let run = forkController();
    try {
      const [demo] = await run.ready;
      phase("round published");
      const indexHash = async () => {
        const response = await fetch(demo.origin, {
          redirect: "error", signal: AbortSignal.timeout(3000),
        });
        assert.equal(response.status, 200);
        return createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
      };
      const sourceHash = () =>
        createHash("sha256").update(readFileSync(join(web, "index.html"))).digest("hex");
      assert.equal(statSync(stateFile).mode & 0o777, 0o600);
      assert.equal(state().phase, "running");
      assert.equal(state().reviewId, demo.reviewId);
      assert(!existsSync(join(demo.root, "app", "web", ".vite")));
      assert(!existsSync(join(demo.root, "app", "web", "stale.txt")));
      await assert.rejects(startDemo(top, undefined, port), /already has a live UI demo/);
      // Even a live controller must own the sealed server on its port.
      const saved = readFileSync(stateFile);
      writeFileSync(stateFile, JSON.stringify({
        ...state(), pid: process.pid, started: startTime(process.pid),
      }));
      const kill = process.kill.bind(process);
      const signals = t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | 0) => {
        assert.equal(signal, 0);
        return kill(pid, signal);
      });
      try {
        await assert.rejects(stop(top, port), /no longer owns this server/);
        assert.equal(state().pid, process.pid);
      } finally {
        signals.mock.restore();
        writeFileSync(stateFile, saved);
      }
      const oldHash = await indexHash();
      assert.equal(oldHash, sourceHash());
      const oldBuild = state().build;
      const staging = join(demo.root, "rebuild");
      const owner = join(staging, "owner");
      const readOwner = () => JSON.parse(readFileSync(owner, "utf8"));
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(owner, String(process.pid));
      const unexpected = () => assert.fail("live lock allowed another build");
      await assert.rejects(rebuild(top, unexpected, port), {
        message: `Another rebuild is running (pid ${process.pid})`,
      });
      assert.equal(readFileSync(owner, "utf8"), String(process.pid));
      for (const invalid of ["not a pid", "0", undefined]) {
        if (invalid !== undefined) writeFileSync(owner, invalid);
        writeFileSync(join(staging, "incomplete"), "stale");
        await assert.rejects(rebuild(top, () => {
          assert.deepEqual(readOwner(), { pid: process.pid });
          assert(!existsSync(join(staging, "incomplete")));
          throw new Error("injected build failure");
        }, port), /injected build failure/);
        assert(!existsSync(staging));
        mkdirSync(staging, { mode: 0o700 });
      }
      const dead = spawnSync(process.execPath, ["-e", ""]);
      assert.equal(dead.status, 0);
      const sleeper = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      const slept = once(sleeper, "exit");
      try {
        assert(sleeper.pid);
        const record = { pid: dead.pid, group: sleeper.pid };
        writeFileSync(owner, JSON.stringify(record));
        await assert.rejects(rebuild(top, unexpected, port), {
          message: `A previous rebuild's web build (process group ${sleeper.pid}) is still running`,
        });
        assert.deepEqual(readOwner(), record);
      } finally {
        sleeper.kill("SIGKILL");
        await slept;
      }
      const origin = await rebuild(top, async () => {
        assert.deepEqual(readOwner(), { pid: process.pid });
        writeWeb(web, "second");
        assert.equal(await indexHash(), oldHash, "checkout builds cannot change the served copy");
        const interrupted = randomUUID();
        writeWeb(join(staging, "web"), "interrupted");
        writeFileSync(join(staging, "request"), interrupted, { mode: 0o600 });
        renameSync(join(staging, "request"), join(staging, "ready"));
        const deadline = Date.now() + 45_000;
        while (state().result?.request !== interrupted) {
          assert(Date.now() < deadline, "the interrupted request was never acknowledged");
          await delay(100);
        }
        assert.equal(state().result.error, undefined);
      }, port);
      assert(!existsSync(staging));
      assert.equal(origin, demo.origin);
      assert.equal(await indexHash(), sourceHash());
      assert.notEqual(sourceHash(), oldHash);
      assert.equal(state().build, oldBuild + 2);
      assert.equal(state().reviewId, demo.reviewId);
      assert(!existsSync(join(demo.root, "app", "web", ".vite")));
      phase("rebuilt");
      const interrupts = [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]] as const;
      for (const [signal, status] of interrupts) {
        const module = new URL("./ui-demo.ts", import.meta.url).href;
        const script = `
          const { rebuild } = await import(process.argv[1]);
          await rebuild(process.argv[2], async (_, signal) => {
            const timer = setInterval(() => {}, 1000);
            signal.addEventListener("abort", () => clearInterval(timer));
            process.send("building");
            await new Promise(() => {});
          }, Number(process.argv[3]));
        `;
        const writer = spawn(process.execPath, [
          "--input-type=module", "-e", script, module, top, String(port),
        ], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
        const ended = once(writer, "exit");
        try {
          const [message] = await Promise.race([once(writer, "message"), ended]);
          assert.equal(message, "building");
          assert.deepEqual(readOwner(), { pid: writer.pid });
          writer.kill(signal);
          assert.deepEqual(await ended, [status, null]);
          assert(!existsSync(staging));
        } finally {
          if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
          await ended;
        }
      }
      await stop(top, port);
      assert.deepEqual(await run.exited, [130, null]);
      assert(!existsSync(demo.root));
      assert(!existsSync(stateFile));
      phase("stopped");
      run = forkController();
      const [next] = await run.ready;
      const replacement = { phase: "starting", pid: run.child.pid, started: "other start", port };
      writeFileSync(stateFile, JSON.stringify(replacement));
      run.child.disconnect();
      assert.deepEqual(await run.exited, [130, null]);
      assert(!existsSync(next.root));
      assert.deepEqual(state(), replacement);
      await stop(top, port);
      assert(!existsSync(stateFile));
      phase("disconnected");

      run = forkController("hold");
      const [starting] = await run.ready;
      assert.equal(state().phase, "starting");
      assert.equal(state().root, starting.root);
      assert.equal(state().pid, run.child.pid);
      assert(existsSync(starting.root));
      await assert.rejects(startDemo(top, undefined, port), /already has a live UI demo/);
      await stop(top, port);
      assert.deepEqual(await run.exited, [130, null]);
      assert(!existsSync(starting.root));
      assert(!existsSync(stateFile));
      phase("stopped during start");

      run = forkController();
      const [orphan] = await run.ready;
      const serverFile = join(orphan.root, "recense", "server.json");
      const { pid } = JSON.parse(readFileSync(serverFile, "utf8"));
      assert(run.child.kill("SIGKILL"));
      assert.deepEqual(await run.exited, [null, "SIGKILL"]);
      try {
        await stop(top, port);
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        assert(!existsSync(orphan.root));
        assert(!existsSync(stateFile));
      } finally {
        const args = spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], {
          encoding: "utf8", env: { PATH: "/usr/bin:/bin" },
        });
        if (args.stdout?.includes(join(orphan.root, "app", "recense.mjs")))
          process.kill(pid, "SIGKILL");
        rmSync(orphan.root, { recursive: true, force: true });
      }
      phase("cleaned up after hard exit");
    } finally {
      const { child, exited } = run;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    }
  } finally {
    clearTimeout(watchdog);
    rmSync(top, { recursive: true, force: true });
  }
});
