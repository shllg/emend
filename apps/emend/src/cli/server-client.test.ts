import * as childProcess from "node:child_process";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { testDb } from "../db/test-support.ts";
import { startServer } from "../server/serve.ts";
import { writeSecretFile } from "../state/files.ts";
import { discover, ensureServer } from "./server-client.ts";

const launchEnvs = new Map<string, { confinedEnv: NodeJS.ProcessEnv; suppliedEnvs: NodeJS.ProcessEnv[] }>();
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    // Keep fixture confinement after spies are restored too.
    spawn(node: string, args: string[], options: childProcess.SpawnOptions) {
      const launch = launchEnvs.get(args[0] ?? "");
      if (node !== process.execPath || !launch) throw new Error("unregistered test child");
      launch.suppliedEnvs.push({ ...options.env });
      return actual.spawn(node, args, {
        ...options,
        env: {
          ...launch.confinedEnv,
          EMEND_HOME: options.env?.EMEND_HOME,
        },
      });
    },
  };
});

function observeChildExit(entry: string, stateDir: string, nodeOptions = "--no-warnings") {
  // Observe production forwarding caller options; the child's allowlist must still exclude them.
  vi.stubEnv("NODE_OPTIONS", nodeOptions);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const expectedEnv = { ...process.env, EMEND_HOME: stateDir };
  const suppliedEnvs: NodeJS.ProcessEnv[] = [];
  launchEnvs.set(entry, { confinedEnv: { PATH: stateDir, HOME: stateDir, LC_ALL: "C" }, suppliedEnvs });
  onTestFinished(() => {
    launchEnvs.delete(entry);
    expect(suppliedEnvs.length).toBe(1);
    const [suppliedEnv] = suppliedEnvs;
    expect(suppliedEnv?.EMEND_HOME).toBe(stateDir);
    expect(suppliedEnv?.NODE_OPTIONS).toBe(nodeOptions);
    // Production inherits every other variable unchanged; never print caller names or values on failure.
    expect(Object.keys(suppliedEnv ?? {}).length).toBe(Object.keys(expectedEnv).length);
    expect(
      Object.entries(expectedEnv).every(
        ([key, value]) => Object.hasOwn(suppliedEnv ?? {}, key) && suppliedEnv?.[key] === value,
      ),
    ).toBe(true);
  });
  const spawn = childProcess.spawn;
  const exited = Promise.withResolvers<unknown[]>();
  void exited.promise.catch(() => {});
  vi.spyOn(childProcess, "spawn").mockImplementationOnce((...args) => {
    const child = spawn(...args);
    void once(child, "exit").then(exited.resolve, exited.reject);
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited.promise;
    });
    return child;
  });
  return exited.promise;
}

beforeEach(() => {
  onTestFinished(() => {
    try {
      expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
  const kill = process.kill;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal !== 0) throw new Error("Only process existence probes are allowed.");
    return kill(pid, signal);
  });
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
  onTestFinished(() => rm(stateDir, { recursive: true, force: true }));
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
  onTestFinished(() => fixture.cleanup());
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const stateDir = join(fixture.dir, "state-server");
    server = await startServer({ stateDir, port: 0 });
    const running = server;
    onTestFinished(() => running.close());
    expect(await ensureServer(stateDir)).toEqual({ url: server.url });
  } finally {
    await server?.close();
  }
});

test("ensureServer starts a detached server after a dead discovery pid", async () => {
  const fixture = await testDb();
  onTestFinished(() => fixture.cleanup());
  const stateDir = join(fixture.dir, "spawned");
  let pid: number | undefined;
  let url: string | undefined;
  let exited: Promise<unknown[]> | undefined;
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
    exited = observeChildExit(entry, stateDir);
    const result = await Promise.race([
      ensureServer(stateDir, { entry, timeoutMs: 60_000 }),
      exited.then(async ([code, signal]) => {
        const listenError = await readFile(join(stateDir, "listen-error"), "utf8").catch(() => "");
        if (listenError) throw new Error(`Synthetic child listen ${listenError}`);
        throw new Error(`Synthetic child exited before discovery (${code ?? signal})`);
      }),
    ]);
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
  }
});

test("the confined test child of a detached launch never runs the caller's NODE_OPTIONS preload", async () => {
  const fixture = await testDb();
  onTestFinished(() => fixture.cleanup());
  const stateDir = join(fixture.dir, "failed");
  const entry = join(fixture.dir, "exit.mjs");
  const started = join(stateDir, "entry-ran");
  const marker = join(fixture.dir, "preload-ran");
  const preload = join(fixture.dir, "preload.cjs");
  await writeFile(
    entry,
    `import { writeFileSync } from "node:fs"; import { join } from "node:path"; writeFileSync(join(process.env.EMEND_HOME, "entry-ran"), "ran"); process.exit(1);\n`,
  );
  await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  const exited = observeChildExit(entry, stateDir, `--require ${JSON.stringify(preload)}`);
  await expect(ensureServer(stateDir, { entry, timeoutMs: 150 })).rejects.toThrow("Could not start the emend server.");
  expect(await exited).toEqual([1, null]);
  await access(started);
  await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
