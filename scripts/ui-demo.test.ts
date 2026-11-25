import assert from "node:assert/strict";
import { type ChildProcess, fork, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildWeb, rebuild, startDemo, stop } from "./ui-demo.ts";

const recense = join(import.meta.dirname, "..", "apps", "recense");
const { build } = createRequire(join(recense, "package.json"))("esbuild");

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
  writeFileSync(file, JSON.stringify({ pid: 12345 }));
  await stop(top, port);
  assert(!existsSync(file));
  assert.deepEqual(calls, [0]);
  probe.mock.mockImplementation((_pid: number, signal?: string | number) => {
    assert.equal(signal, 0);
    throw Object.assign(new Error("Denied"), { code: "EPERM" });
  });
  writeFileSync(file, JSON.stringify({ pid: 12345, port, origin: "wrong" }));
  await assert.rejects(stop(top, port), /worktree's port/);
  assert(existsSync(file));
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
      await assert.rejects(startDemo(top, undefined, port), /already accepts connections/);
      phase("port-in-use refused");
    } finally {
      await listener.close();
    }

    function forkController() {
      const child = fork(join(import.meta.dirname, "fixtures", "ui-demo-controller.ts"), [
        top, String(port),
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
      assert.equal(state().reviewId, demo.reviewId);
      assert(!existsSync(join(demo.root, "app", "web", ".vite")));
      assert(!existsSync(join(demo.root, "app", "web", "stale.txt")));
      await assert.rejects(startDemo(top, undefined, port), /already has a live UI demo/);
      // A reused controller pid passes the liveness check but does not own the sealed server.
      const saved = readFileSync(stateFile);
      writeFileSync(stateFile, JSON.stringify({ ...state(), pid: process.pid }));
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
      }, port);
      assert(!existsSync(staging));
      assert.equal(origin, demo.origin);
      assert.equal(await indexHash(), sourceHash());
      assert.notEqual(sourceHash(), oldHash);
      assert.equal(state().build, oldBuild + 1);
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
      run.child.disconnect();
      assert.deepEqual(await run.exited, [130, null]);
      assert(!existsSync(next.root));
      assert(!existsSync(stateFile));
      phase("disconnected");
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
