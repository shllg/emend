import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
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

test("a command refuses while an old process holds the database, names it, and moves nothing", async () => {
  const { root, env } = await legacyFolders();
  await writeFile(join(root, "data/emend/emend.db"), "db");
  const stderr: string[] = [];
  const fd = openSync(join(root, "data/emend/emend.db"), "r");
  try {
    expect(await run(["ls"], { stdout: () => {}, stderr: (s) => stderr.push(s), env })).toBe(1);
  } finally {
    closeSync(fd);
  }
  expect(stderr.join("")).toMatch(/^recense: an old emend process \(pid \d+\) still uses .*Nothing was moved\.\n$/);
  expect(await readdir(join(root, "data"))).toEqual(["emend"]);
  expect(await readdir(join(root, "config"))).toEqual(["emend"]);
});

test("a stale server record does not block a command: the old files move", async () => {
  const { root, env } = await legacyFolders();
  await writeFile(join(root, "data/emend/emend.db"), "db");
  await writeFile(join(root, "data/emend/server.json"), JSON.stringify({ pid: process.pid }));
  expect(await run(["nope"], { stdout: () => {}, stderr: () => {}, env })).toBe(2);
  expect(await readdir(join(root, "data"))).toEqual(["recense"]);
});

test("stop reaches the old server before anything moves, and a stale record does not block it", async () => {
  const { root, env } = await legacyFolders();
  await writeFile(join(root, "data/emend/emend.db"), "db");
  await chmod(join(root, "data/emend"), 0o700);
  // The record names this live process, whose pid stands in for a reused one; nothing listens on its port.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  await writeFile(
    join(root, "data/emend/server.json"),
    JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${port}`, key: "k".repeat(43) }),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout: (s: string) => stdout.push(s),
    stderr: (s: string) => stderr.push(s),
    env,
    service: { platform: "freebsd" },
  };
  expect(await run(["stop"], io)).toBe(0);
  expect(stdout.join("")).toContain("no recense server is running");
  expect(stderr).toEqual([]);
  expect(await readdir(join(root, "data"))).toEqual(["emend"]);
  expect(await readdir(join(root, "config"))).toEqual(["emend"]);
});

test("status --line stays silent: no note when both folders exist, no refusal text", async () => {
  const { root, env } = await legacyFolders();
  await writeFile(join(root, "data/emend/emend.db"), "db");
  await mkdir(join(root, "data/recense"));
  const stderr: string[] = [];
  expect(await run(["status", "--line"], { stdout: () => {}, stderr: (s) => stderr.push(s), env })).toBe(0);
  expect(stderr).toEqual([]);
  // Another command prints the note once.
  expect(await run(["nope"], { stdout: () => {}, stderr: (s) => stderr.push(s), env })).toBe(2);
  expect(stderr.filter((line) => line.includes("still holds emend.db"))).toHaveLength(1);
});
