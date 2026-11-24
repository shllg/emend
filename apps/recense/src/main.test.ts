import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { run } from "./main.ts";

test("--version writes the version to stdout and succeeds", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["--version"], {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    env: process.env,
  });
  expect(stdout).toEqual(["recense 0.1.0\n"]);
  expect(stderr).toEqual([]);
  expect(code).toBe(0);
});

test("an unknown command writes to stderr and returns 2", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["nope"], {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    env: process.env,
  });
  expect(stderr).toEqual(["recense: unknown command nope\n"]);
  expect(stdout).toEqual([]);
  expect(code).toBe(2);
});

async function legacyFolders() {
  const root = await mkdtemp(join(tmpdir(), "recense-main-legacy-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const env = { XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config") };
  await mkdir(join(root, "data/emend"), { recursive: true });
  await mkdir(join(root, "config/emend"), { recursive: true });
  return { root, env };
}

test("the first command moves the old state and config folders, and --version leaves them", async () => {
  const { root, env } = await legacyFolders();
  await writeFile(join(root, "data/emend/emend.db"), "db");
  const stderr: string[] = [];
  const io = { stdout: () => {}, stderr: (s: string) => stderr.push(s), env };
  expect(await run(["--version"], io)).toBe(0);
  expect(await readdir(join(root, "data"))).toEqual(["emend"]);
  expect(await run(["nope"], io)).toBe(2);
  expect(await readdir(join(root, "data"))).toEqual(["recense"]);
  expect(await readdir(join(root, "config"))).toEqual(["recense"]);
  expect(await readdir(join(root, "data/recense"))).toEqual(["recense.db"]);
});

test("a command refuses while the old server runs, names it, and moves nothing", async () => {
  const { root, env } = await legacyFolders();
  await writeFile(join(root, "data/emend/server.json"), JSON.stringify({ pid: process.pid }));
  const stderr: string[] = [];
  expect(await run(["ls"], { stdout: () => {}, stderr: (s) => stderr.push(s), env })).toBe(1);
  expect(stderr.join("")).toMatch(/^recense: the emend server \(process \d+\) still uses .*Nothing was moved\.\n$/);
  expect(await readdir(join(root, "data"))).toEqual(["emend"]);
  expect(await readdir(join(root, "config"))).toEqual(["emend"]);
});
