import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  allocatePort,
  busyPorts,
  lockPath,
  PORT_MAX,
  PORT_MIN,
  portRange,
  readRegistry,
  registryPath,
  setPortRangeForTests,
  stateDir,
  withRegistry,
} from "./registry.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  deadPid,
  type Fixture,
  listenOn,
  makeFixture,
  makeTestEnv,
  runWt,
  type TestEnv,
  testPortRange,
} from "./test-support.ts";
import { WtError } from "./validate.ts";

let env: TestEnv;
let fx: Fixture;
let repo: Repo;

before(() => {
  env = makeTestEnv();
  fx = makeFixture(env);
  repo = resolveRepo(fx.main);
});
after(() => env.cleanup());

const entry = (port: number) => ({
  path: `/nowhere/${port}`,
  port,
  mode: "github" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
});

test("registry survives concurrent writers", async () => {
  const here = pathToFileURL(import.meta.dirname).href;
  const code = `
    import { allocatePort, withRegistry } from "${here}/registry.ts";
    import { resolveRepo } from "${here}/repo.ts";
    const repo = resolveRepo(process.argv[1]);
    const tag = process.argv[2];
    for (let i = 0; i < 5; i++) {
      withRegistry(repo, (r) => {
        const port = allocatePort(r, new Set());
        r.worktrees[tag + "-" + i] = { path: "/nowhere", port, mode: "github", createdAt: "t" };
      });
    }`;
  const args = (tag: string) => ["--input-type=module", "-e", code, fx.main, tag];
  const [a, b] = await Promise.all([
    runWt(process.execPath, args("a"), { cwd: fx.main }),
    runWt(process.execPath, args("b"), { cwd: fx.main }),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const data = JSON.parse(readFileSync(registryPath(repo), "utf8"));
  const ports = Object.values(data.worktrees).map((w) => (w as { port: number }).port);
  assert.equal(ports.length, 10);
  assert.equal(new Set(ports).size, 10);
  assert.equal(data.version, 1);
  withRegistry(repo, (r) => {
    r.worktrees = {};
  });
});

test("stale lock is replaced", () => {
  mkdirSync(dirname(lockPath(repo)), { recursive: true });
  writeFileSync(lockPath(repo), `${deadPid()}\n`);
  const result = withRegistry(repo, (r) => Object.keys(r.worktrees).length);
  assert.equal(result, 0);
});

test("a symlinked registry lock is never read through or reaped", (t) => {
  const lock = lockPath(repo);
  mkdirSync(dirname(lock), { recursive: true });
  const before = readdirSync(dirname(lock));
  const outside = join(env.root, "outside-registry-lock");
  const content = `${deadPid()}\n`;
  writeFileSync(outside, content);
  symlinkSync(outside, lock);
  let now = 0;
  const clock = t.mock.method(Date, "now", () => (now += 31_000));
  const read = t.mock.method(fs, "readSync");
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => withRegistry(repo, () => assert.fail("must not run")),
      (error) =>
        error instanceof WtError &&
        error.code === 69 &&
        error.message === "Another bin/wt or bin/findings call holds the registry lock. Try again in a moment.",
    );
    assert.equal(read.mock.callCount(), 0);
    assert.equal(lstatSync(lock).isSymbolicLink(), true);
    assert.equal(readFileSync(outside, "utf8"), content);
    assert.deepEqual(readdirSync(dirname(lock)).sort(), [...before, "lock"].sort());
  } finally {
    clock.mock.restore();
    read.mock.restore();
    syncBuiltinESMExports();
    rmSync(lock, { force: true });
    rmSync(outside, { force: true });
  }
});

test("a FIFO registry lock times out without blocking", async (t) => {
  const mkfifo = env.realPath
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "mkfifo"))
    .find(existsSync);
  if (!mkfifo) return t.skip("mkfifo is unavailable");
  const lock = lockPath(repo);
  mkdirSync(dirname(lock), { recursive: true });
  const before = readdirSync(dirname(lock));
  const made = spawnSync(mkfifo, [lock], { encoding: "utf8", timeout: 5000 });
  assert.equal(made.status, 0, made.stderr);
  const script = `
    import { withRegistry } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "registry.ts")).href)};
    let now = 0;
    Date.now = () => (now += 31_000);
    try {
      withRegistry(${JSON.stringify(repo)}, () => { throw new Error("must not run"); });
    } catch (error) {
      process.stderr.write(error.message + "\\n");
      process.exitCode = error.code ?? 1;
    }
  `;
  try {
    const result = await runWt(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fx.main,
      timeoutMs: 5000,
    });
    assert.equal(result.code, 69, result.stderr);
    assert.equal(
      result.stderr,
      "Another bin/wt or bin/findings call holds the registry lock. Try again in a moment.\n",
    );
    assert.equal(lstatSync(lock).isFIFO(), true);
    assert.deepEqual(readdirSync(dirname(lock)).sort(), [...before, "lock"].sort());
  } finally {
    rmSync(lock, { force: true });
  }
});

test("a failing callback writes nothing and releases the lock", () => {
  assert.throws(
    () =>
      withRegistry(repo, (r) => {
        r.worktrees.x = entry(portRange().min);
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(
    withRegistry(repo, (r) => Object.keys(r.worktrees).length),
    0,
  );
});

test("withRegistry is not re-entrant", () => {
  assert.throws(() => withRegistry(repo, () => withRegistry(repo, () => 1)), /re-entrant/);
  assert.equal(
    withRegistry(repo, () => 1),
    1,
  );
});

test("a corrupt registry is refused and left alone", () => {
  writeFileSync(registryPath(repo), "{not json");
  assert.throws(
    () => withRegistry(repo, () => 1),
    (e) => e instanceof WtError && e.code === 1,
  );
  assert.equal(readFileSync(registryPath(repo), "utf8"), "{not json");
  writeFileSync(registryPath(repo), JSON.stringify({ version: 1, worktrees: {} }));
});

test("a legacy registry with reservations and task keys loads, and a write keeps it valid", () => {
  writeFileSync(
    registryPath(repo),
    JSON.stringify({
      version: 1,
      worktrees: { old: { ...entry(PORT_MIN), task: "014" } },
      reservations: { "014": { branch: "recense-task-014-x", slug: "x", reservedAt: "2020-01-01T00:00:00Z" } },
    }),
  );
  assert.equal(readRegistry(repo).worktrees.old?.port, PORT_MIN);
  withRegistry(repo, (r) => {
    r.worktrees.new = entry(PORT_MIN + 1);
  });
  assert.deepEqual(Object.keys(readRegistry(repo).worktrees), ["old", "new"]);
  // a registry without the key loads as well
  writeFileSync(registryPath(repo), JSON.stringify({ version: 1, worktrees: {} }));
  assert.deepEqual(readRegistry(repo).worktrees, {});
  writeFileSync(registryPath(repo), JSON.stringify({ version: 1, worktrees: {} }));
});

test("registry refuses invalid finding id lists", () => {
  const isolated = { ...repo, commonDir: join(env.root, "invalid-finding-ids") };
  const path = registryPath(isolated);
  mkdirSync(dirname(path), { recursive: true });
  const id = "f-0123456789ab";
  for (const findings of [null, id, [], [42], ["f-ABCDEF012345"], [id, id]]) {
    const data = JSON.stringify({ version: 1, worktrees: { fixer: { ...entry(PORT_MIN), findings } } });
    writeFileSync(path, data);
    assert.throws(
      () => readRegistry(isolated),
      (e) => e instanceof WtError && e.code === 1 && e.message.includes("Nothing was changed."),
    );
    assert.equal(readFileSync(path, "utf8"), data);
  }
});

test("allocatePort takes the lowest port neither registered nor busy", () => {
  const { min, max } = portRange();
  const r = { version: 1 as const, worktrees: { a: entry(min), b: entry(min + 2) } };
  assert.equal(allocatePort(r, new Set()), min + 1);
  assert.equal(allocatePort(r, new Set([min + 1, min + 3])), min + 4);
  const full = { version: 1 as const, worktrees: {} as Record<string, ReturnType<typeof entry>> };
  for (let p = min; p <= max; p++) full.worktrees[`b${p}`] = entry(p);
  assert.throws(
    () => allocatePort(full, new Set()),
    (e) => e instanceof WtError && e.code === 69,
  );
});

test("the real range is 3637 to 3656 once the test seam is cleared", () => {
  setPortRangeForTests(null);
  try {
    assert.deepEqual(portRange(), { min: PORT_MIN, max: PORT_MAX });
    assert.equal(allocatePort({ version: 1, worktrees: {} }, new Set([3637])), 3638);
  } finally {
    setPortRangeForTests(testPortRange());
  }
});

test("busyPorts finds a listener in the test range", async () => {
  const { min } = portRange();
  const server = await listenOn(min + 5); // the range is this process's own, so a bind failure is a real failure
  try {
    const busy = await busyPorts();
    assert.ok(busy.has(min + 5));
    assert.equal(busy.has(min + 6), false);
  } finally {
    await server.close();
  }
});

test("the folder of the name before the rename moves to the new name once, with its content", () => {
  const folder = join(env.root, "old-state-repo");
  mkdirSync(join(folder, "emend-wt"), { recursive: true });
  writeFileSync(join(folder, "emend-wt", "registry.json"), "{}");
  const fake = { commonDir: folder } as Repo;
  assert.equal(stateDir(fake), join(folder, "recense-wt"));
  assert.equal(readFileSync(join(folder, "recense-wt", "registry.json"), "utf8"), "{}");
  assert.equal(existsSync(join(folder, "emend-wt")), false);
  // A second call, and a call when both exist, change nothing.
  mkdirSync(join(folder, "emend-wt"));
  assert.equal(stateDir(fake), join(folder, "recense-wt"));
  assert.equal(existsSync(join(folder, "emend-wt")), true);
  assert.equal(readdirSync(join(folder, "recense-wt")).join(), "registry.json");
});
