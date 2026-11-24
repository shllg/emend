import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { LegacyStateInUseError, moveLegacyFolders, moveLegacyState } from "./legacy.ts";

let root: string;
let env: Record<string, string | undefined>;
const data = () => join(root, "data");
const config = () => join(root, "config");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "recense-legacy-"));
  env = { XDG_DATA_HOME: data(), XDG_CONFIG_HOME: config() };
  await mkdir(data(), { recursive: true });
  await mkdir(config(), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
async function legacyState(files: Record<string, string> = { "emend.db": "db", token: "t" }) {
  await mkdir(join(data(), "emend"));
  for (const [name, text] of Object.entries(files)) await writeFile(join(data(), "emend", name), text);
}

test("moves the state and config folders once, with the database and its sidecar files", async () => {
  await legacyState({ "emend.db": "db", "emend.db-wal": "wal", "emend.db-shm": "shm", "instance.json": "{}" });
  await mkdir(join(config(), "emend"));
  await writeFile(join(config(), "emend", "config.json"), "{}");
  expect(moveLegacyFolders(env, "linux", "/nowhere")).toEqual([join(data(), "recense"), join(config(), "recense")]);
  expect(await exists(join(data(), "emend"))).toBe(false);
  expect(await readdir(join(data(), "recense"))).toEqual([
    "instance.json",
    "recense.db",
    "recense.db-shm",
    "recense.db-wal",
  ]);
  expect(await readFile(join(data(), "recense", "recense.db-wal"), "utf8")).toBe("wal");
  expect(await readFile(join(config(), "recense", "config.json"), "utf8")).toBe("{}");
  expect(moveLegacyFolders(env, "linux", "/nowhere")).toEqual([]);
});

test("leaves a database that already has the new name, and a folder without one, alone", async () => {
  await legacyState({ "recense.db": "new", "emend.db": "old" });
  moveLegacyFolders(env, "linux", "/nowhere");
  expect(await readFile(join(data(), "recense", "recense.db"), "utf8")).toBe("new");
  expect(await readFile(join(data(), "recense", "emend.db"), "utf8")).toBe("old");
});

test("moves nothing when the new folder exists, and never deletes the old one", async () => {
  await legacyState();
  await mkdir(join(data(), "recense"));
  await writeFile(join(data(), "recense", "marker"), "m");
  expect(moveLegacyFolders(env, "linux", "/nowhere")).toEqual([]);
  expect(await readdir(join(data(), "emend"))).toEqual(["emend.db", "token"]);
  expect(await readdir(join(data(), "recense"))).toEqual(["marker"]);
});

test("does nothing when there is no old folder", () => {
  expect(moveLegacyFolders(env, "linux", "/nowhere")).toEqual([]);
});

test.each([["RECENSE_HOME"], ["EMEND_HOME"]])(
  "%s keeps the state folder in place and only the config folder moves",
  async (name) => {
    await legacyState();
    await mkdir(join(config(), "emend"));
    env[name] = join(root, "chosen");
    expect(moveLegacyFolders(env, "linux", "/nowhere")).toEqual([join(config(), "recense")]);
    expect(await exists(join(data(), "emend"))).toBe(true);
  },
);

test("uses Application Support on macOS", async () => {
  const home = join(root, "home");
  const support = join(home, "Library", "Application Support");
  await mkdir(join(support, "emend"), { recursive: true });
  expect(moveLegacyFolders({ XDG_CONFIG_HOME: config() }, "darwin", home)).toEqual([join(support, "recense")]);
});

test("refuses, and moves nothing, while the old server's process is alive", async () => {
  await legacyState({
    "emend.db": "db",
    "server.json": JSON.stringify({ pid: process.pid, url: "http://127.0.0.1:1" }),
  });
  await mkdir(join(config(), "emend"));
  expect(() => moveLegacyFolders(env, "linux", "/nowhere")).toThrow(LegacyStateInUseError);
  expect(moveLegacyState(env, "linux", "/nowhere")).toMatch(/still uses .*Stop it first.*Nothing was moved/);
  expect(await exists(join(data(), "emend", "emend.db"))).toBe(true);
  expect(await exists(join(data(), "recense"))).toBe(false);
  expect(await exists(join(config(), "recense"))).toBe(false);
});

test("a server record for a process that is gone does not block the move", async () => {
  // A pid far above the kernel's maximum names no process.
  await legacyState({ "emend.db": "db", "server.json": JSON.stringify({ pid: 2 ** 31 - 2 }) });
  expect(moveLegacyState(env, "linux", "/nowhere")).toBeUndefined();
  expect(await exists(join(data(), "recense", "recense.db"))).toBe(true);
});

test("an unreadable server record does not block the move", async () => {
  await legacyState({ "emend.db": "db", "server.json": "not json" });
  expect(moveLegacyState(env, "linux", "/nowhere")).toBeUndefined();
});

test("a test run never moves a folder outside the temporary directory", async () => {
  // The real home is not under the temporary directory; the guard skips the pair before it touches anything.
  const outside = {
    XDG_DATA_HOME: "/nonexistent-recense-data",
    XDG_CONFIG_HOME: "/nonexistent-recense-config",
    VITEST: "true",
  };
  expect(moveLegacyFolders(outside, "linux", "/nowhere")).toEqual([]);
});
