import * as childProcess from "node:child_process";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { testDb } from "../db/test-support.ts";
import { startServer } from "../server/serve.ts";
import { writeSecretFile } from "../state/files.ts";
import { discover, ensureServer } from "./server-client.ts";

vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()) }));

function observeChildExit() {
  const spawn = childProcess.spawn;
  const exited = Promise.withResolvers<unknown[]>();
  void exited.promise.catch(() => {});
  vi.spyOn(childProcess, "spawn").mockImplementationOnce((...args) => {
    const child = spawn(...args);
    void once(child, "exit").then(exited.resolve, exited.reject);
    return child;
  });
  return exited.promise;
}

beforeEach(() => {
  const kill = process.kill;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal !== 0) throw new Error("Only process existence probes are allowed.");
    return kill(pid, signal);
  });
});
afterEach(() => {
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  vi.restoreAllMocks();
});

test.each([
  ["./server-client.ts", "discover"],
  ["./http.ts", "apiRequest"],
])("%s loads in a fresh module graph", async (entry, exported) => {
  const stateDir = await mkdtemp(join(process.env.EMEND_HOME as string, "module-load-"));
  try {
    const source = new URL(entry, import.meta.url).href;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const loaded = await import(${JSON.stringify(source)}); if (typeof loaded[${JSON.stringify(exported)}] !== "function") process.exitCode = 1;`,
      ],
      {
        cwd: stateDir,
        env: { PATH: process.env.PATH, HOME: stateDir, EMEND_HOME: stateDir, LC_ALL: "C" },
        timeout: 10000,
      },
    );
    expect(stdout).toBe("");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a wrong proof never reads an endless capabilities body", async () => {
  const stateDir = await mkdtemp(join(process.env.EMEND_HOME as string, "discovery-proof-"));
  try {
    await writeFile(
      join(stateDir, "server.json"),
      JSON.stringify({
        pid: process.pid,
        url: "http://127.0.0.1:3636",
        key: randomBytes(32).toString("base64url"),
      }),
    );
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    expect(await discover(stateDir, 500)).toBeNull();
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("ensureServer reuses a live server with valid capabilities", async () => {
  const fixture = await testDb();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const stateDir = join(fixture.dir, "state-server");
    server = await startServer({ stateDir, port: 0 });
    expect(await ensureServer(stateDir)).toEqual({ url: server.url });
  } finally {
    await server?.close();
    await fixture.cleanup();
  }
});

async function withLaunchEnv<T>(dir: string, launch: () => Promise<T>): Promise<T> {
  const home = join(dir, "home");
  await mkdir(home, { mode: 0o700 });
  const previous = { ...process.env };
  const env = {
    ...(previous.PATH !== undefined ? { PATH: previous.PATH } : {}),
    ...(previous.TMPDIR !== undefined ? { TMPDIR: previous.TMPDIR } : {}),
    HOME: home,
    LC_ALL: "C",
  };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    return await launch();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

test("ensureServer starts a detached server after a dead discovery pid", async () => {
  const fixture = await testDb();
  const stateDir = join(fixture.dir, "spawned");
  const exited = observeChildExit();
  let pid: number | undefined;
  let url: string | undefined;
  try {
    await mkdir(stateDir, { mode: 0o700 });
    writeSecretFile(
      join(stateDir, "server.json"),
      JSON.stringify({ pid: 2147483647, url: "http://127.0.0.1:1", port: 1, startedAt: new Date().toISOString() }),
    );
    // A self-contained synthetic entry avoids source-loader or package resolution differences.
    const entry = join(fixture.dir, "entry.mjs");
    await writeFile(
      entry,
      `import { createServer } from 'node:http';\nimport { randomBytes, createHmac } from 'node:crypto';\nconst key = randomBytes(32).toString('base64url');\nimport { writeFileSync, unlinkSync } from 'node:fs';\nimport { join } from 'node:path';\nif (process.argv[2] !== 'serve') process.exit(2);\nconst path = join(process.env.EMEND_HOME, 'server.json');\nconst server = createServer((req,res) => { if (req.url === '/stop') { res.once('finish', () => { server.closeAllConnections(); server.close(() => { unlinkSync(path); process.exit(0); }); }); res.end(); return; } const challenge = req.headers['x-emend-challenge']; if (typeof challenge === 'string') res.setHeader('X-Emend-Proof',createHmac('sha256',Buffer.from(key,'base64url')).update(challenge).digest('base64url')); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({api:1,version:'0.1.0',features:[]})); });\nserver.on('error', (error) => { writeFileSync(join(process.env.EMEND_HOME, 'listen-error'), error.code); process.exit(1); });\nserver.listen(0,'127.0.0.1', () => { const port = server.address().port; writeFileSync(path, JSON.stringify({key,pid:process.pid,url:'http://127.0.0.1:'+port,port,startedAt:new Date().toISOString()}), {mode:0o600}); });\nprocess.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => { unlinkSync(path); process.exit(0); }); });\nsetTimeout(() => process.exit(0), 10000).unref();\n`,
    );
    const result = await withLaunchEnv(fixture.dir, () =>
      Promise.race([
        ensureServer(stateDir, { entry, timeoutMs: 60_000 }),
        exited.then(async ([code, signal]) => {
          const listenError = await readFile(join(stateDir, "listen-error"), "utf8").catch(() => "");
          if (listenError) throw new Error(`Synthetic child listen ${listenError}`);
          throw new Error(`Synthetic child exited before discovery (${code ?? signal})`);
        }),
      ]),
    );
    pid = JSON.parse(await readFile(join(stateDir, "server.json"), "utf8")).pid;
    url = result.url;
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(pid).not.toBe(process.pid);
  } finally {
    if (url) {
      await fetch(`${url}/stop`, { method: "POST" });
      expect(await exited).toEqual([0, null]);
      await expect(readFile(join(stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await fixture.cleanup();
  }
});

test("a detached child that exits before discovery ignores the caller's NODE_OPTIONS preload", async () => {
  const fixture = await testDb();
  const previous = process.env.NODE_OPTIONS;
  try {
    const entry = join(fixture.dir, "exit.mjs");
    const started = join(fixture.dir, "entry-ran");
    const marker = join(fixture.dir, "preload-ran");
    const preload = join(fixture.dir, "preload.cjs");
    await writeFile(
      entry,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(started)}, "ran"); process.exit(1);\n`,
    );
    await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
    const exited = observeChildExit();
    await expect(
      withLaunchEnv(fixture.dir, () => ensureServer(join(fixture.dir, "failed"), { entry, timeoutMs: 150 })),
    ).rejects.toThrow("Could not start the emend server.");
    expect(await exited).toEqual([1, null]);
    await access(started);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    await fixture.cleanup();
  }
});
