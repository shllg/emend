import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  applyLegacyPlan,
  findHolders,
  LegacyStateInUseError,
  LegacyStateUnverifiableError,
  legacyServerFolder,
  moveLegacyState as moveStateWithProbe,
  moveLegacyFolders as moveWithProbe,
  planLegacyMove,
} from "./legacy.ts";

let root: string;
let env: Record<string, string | undefined>;
// No process holds the files unless a test says so.
const none = { probe: () => [] };
const moveLegacyFolders = (env: Record<string, string | undefined>, platform: string, home: string) =>
  moveWithProbe(env, platform, home, none);
const moveLegacyState = (env: Record<string, string | undefined>, platform: string, home: string) =>
  moveStateWithProbe(env, platform, home, none);
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

test("a default run moves the state and config folders once, with the database and its sidecar files", async () => {
  await legacyState({ "emend.db": "db", "emend.db-wal": "wal", "emend.db-shm": "shm", "instance.json": "{}" });
  await mkdir(join(config(), "emend"));
  await writeFile(join(config(), "emend", "config.json"), "{}");
  expect(moveLegacyFolders(env, "linux", "/nowhere")).toEqual([
    join(data(), "recense"),
    join(config(), "recense"),
    join(data(), "recense", "recense.db"),
  ]);
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

test("leaves an old database alone when the new one already exists", async () => {
  const chosen = join(root, "chosen");
  await mkdir(chosen);
  await writeFile(join(chosen, "recense.db"), "new");
  await writeFile(join(chosen, "emend.db"), "old");
  expect(moveLegacyFolders({ ...env, RECENSE_HOME: chosen }, "linux", "/nowhere")).toEqual([]);
  expect(await readFile(join(chosen, "recense.db"), "utf8")).toBe("new");
  expect(await readFile(join(chosen, "emend.db"), "utf8")).toBe("old");
});

test("moves nothing when the new folder exists, and never deletes the old one", async () => {
  await legacyState();
  await mkdir(join(data(), "recense"));
  await writeFile(join(data(), "recense", "marker"), "m");
  expect(moveLegacyFolders(env, "linux", "/nowhere")).toEqual([]);
  expect(await readdir(join(data(), "emend"))).toEqual(["emend.db", "token"]);
  expect(await readdir(join(data(), "recense"))).toEqual(["marker"]);
});

test("both state folders: one note, and the note is not an error", async () => {
  await legacyState();
  await mkdir(join(data(), "recense"));
  const result = moveLegacyState(env, "linux", "/nowhere");
  expect(result.refusal).toBeUndefined();
  expect(result.note).toContain(join(data(), "emend"));
  expect(result.note).toContain("still holds emend.db next to");
  // An old folder without a database says nothing.
  await rm(join(data(), "emend", "emend.db"));
  expect(moveLegacyState(env, "linux", "/nowhere")).toEqual({});
});

test("does nothing when there is no old folder", () => {
  expect(moveLegacyFolders(env, "linux", "/nowhere")).toEqual([]);
});

test.each([["RECENSE_HOME"], ["EMEND_HOME"]])(
  "%s keeps the folders in place, renames the database inside the chosen folder, and moves no config",
  async (name) => {
    await legacyState();
    await mkdir(join(config(), "emend"));
    const chosen = join(root, "chosen");
    await mkdir(chosen);
    await writeFile(join(chosen, "emend.db"), "chosen db");
    await writeFile(join(chosen, "emend.db-wal"), "chosen wal");
    env[name] = chosen;
    expect(moveLegacyFolders(env, "linux", "/nowhere")).toEqual([join(chosen, "recense.db")]);
    expect(await readFile(join(chosen, "recense.db"), "utf8")).toBe("chosen db");
    expect(await readFile(join(chosen, "recense.db-wal"), "utf8")).toBe("chosen wal");
    expect(await exists(join(chosen, "emend.db"))).toBe(false);
    // The default folders are not touched, so a worktree or a dev run never moves the owner's real ones.
    expect(await exists(join(data(), "emend"))).toBe(true);
    expect(await exists(join(config(), "emend"))).toBe(true);
    expect(await exists(join(config(), "recense"))).toBe(false);
  },
);

test("a crash between the renames resumes from what is left", async () => {
  const chosen = join(root, "chosen");
  await mkdir(chosen);
  await writeFile(join(chosen, "recense.db-wal"), "wal moved before the crash");
  await writeFile(join(chosen, "emend.db"), "db");
  expect(moveLegacyFolders({ ...env, RECENSE_HOME: chosen }, "linux", "/nowhere")).toEqual([
    join(chosen, "recense.db"),
  ]);
  expect(await readFile(join(chosen, "recense.db"), "utf8")).toBe("db");
  expect(await readFile(join(chosen, "recense.db-wal"), "utf8")).toBe("wal moved before the crash");
});

test("the loser of two concurrent starts finds the work done and succeeds", async () => {
  await legacyState({ "emend.db": "db", "emend.db-wal": "wal" });
  await mkdir(join(config(), "emend"));
  const plan = planLegacyMove(env, "linux", "/nowhere", none);
  applyLegacyPlan(plan);
  // The second start made its plan before the first finished; its sources are gone and its targets exist.
  expect(() => applyLegacyPlan(plan)).not.toThrow();
  expect(await readFile(join(data(), "recense", "recense.db"), "utf8")).toBe("db");
});

test("uses Application Support on macOS", async () => {
  const home = join(root, "home");
  const support = join(home, "Library", "Application Support");
  await mkdir(join(support, "emend"), { recursive: true });
  expect(moveLegacyFolders({ XDG_CONFIG_HOME: config() }, "darwin", home)).toEqual([join(support, "recense")]);
});

test("refuses, and moves nothing, while a process holds the old database", async () => {
  await legacyState({ "emend.db": "db" });
  await mkdir(join(config(), "emend"));
  const probe = () => [4242];
  expect(() => planLegacyMove(env, "linux", "/nowhere", { probe })).toThrow(LegacyStateInUseError);
  const result = moveStateWithProbe(env, "linux", "/nowhere", { probe });
  expect(result.refusal).toMatch(/pid 4242.*still uses .*Stop it first.*Nothing was moved/);
  expect(await exists(join(data(), "emend", "emend.db"))).toBe(true);
  expect(await exists(join(data(), "recense"))).toBe(false);
  expect(await exists(join(config(), "recense"))).toBe(false);
  // The service about to stop may hold it.
  expect(planLegacyMove(env, "linux", "/nowhere", { probe, ignorePids: [4242] }).database).toBeDefined();
});

test("the probe sees the old files by their real paths", async () => {
  await legacyState({ "emend.db": "db" });
  let seen: string[] = [];
  const link = join(root, "link");
  await symlink(data(), link);
  planLegacyMove({ ...env, XDG_DATA_HOME: link }, "linux", "/nowhere", {
    probe: (files) => {
      seen = files;
      return [];
    },
  });
  expect(seen).toEqual([join(await realpathOf(data()), "emend", "emend.db")]);
});

async function realpathOf(path: string) {
  return (await import("node:fs/promises")).realpath(path);
}

test("a platform that cannot tell refuses with a way out", async () => {
  await legacyState({ "emend.db": "db" });
  const probe = () => "unknown" as const;
  expect(() => planLegacyMove(env, "linux", "/nowhere", { probe })).toThrow(LegacyStateUnverifiableError);
  expect(moveStateWithProbe(env, "linux", "/nowhere", { probe }).refusal).toMatch(/cannot check.*rename emend\.db/);
  expect(await exists(join(data(), "emend", "emend.db"))).toBe(true);
  // With no database there is nothing a holder could hold.
  await rm(join(data(), "emend", "emend.db"));
  expect(() => planLegacyMove(env, "linux", "/nowhere", { probe })).not.toThrow();
});

test.skipIf(process.platform !== "linux")(
  "on Linux an open file descriptor of this process counts as a holder",
  async () => {
    await legacyState({ "emend.db": "db" });
    const path = join(data(), "emend", "emend.db");
    const fd = openSync(path, "r");
    try {
      expect(findHolders([path], "linux")).toContain(process.pid);
      // The default probe, not an injected one.
      expect(moveStateWithProbe(env, "linux", "/nowhere").refusal).toContain(`pid ${process.pid}`);
      expect(await exists(path)).toBe(true);
    } finally {
      closeSync(fd);
    }
    expect(findHolders([path], "linux")).not.toContain(process.pid);
    expect(moveStateWithProbe(env, "linux", "/nowhere").refusal).toBeUndefined();
  },
);

test("a stale server record whose process id was reused does not block the move", async () => {
  await legacyState({
    "emend.db": "db",
    "server.json": JSON.stringify({ pid: process.pid, url: "http://127.0.0.1:1" }),
  });
  expect(moveLegacyState(env, "linux", "/nowhere")).toEqual({});
  expect(await exists(join(data(), "recense", "recense.db"))).toBe(true);
});

test("legacyServerFolder names the old folder only while the new one is missing and a server record is there", async () => {
  expect(legacyServerFolder(env, "linux", "/nowhere")).toBeUndefined();
  await legacyState({ "server.json": "{}" });
  expect(legacyServerFolder(env, "linux", "/nowhere")).toBe(join(data(), "emend"));
  expect(legacyServerFolder({ ...env, RECENSE_HOME: join(root, "x") }, "linux", "/nowhere")).toBeUndefined();
  await mkdir(join(data(), "recense"));
  expect(legacyServerFolder(env, "linux", "/nowhere")).toBeUndefined();
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

test("the guard checks real paths: a temporary link to a folder outside the temporary directory is not moved", async () => {
  const outside = await mkdtemp(join("/var/tmp", "recense-legacy-outside-"));
  try {
    await mkdir(join(outside, "emend"));
    await writeFile(join(outside, "emend", "emend.db"), "db");
    await symlink(outside, join(root, "linked-data"));
    expect(moveLegacyFolders({ ...env, XDG_DATA_HOME: join(root, "linked-data") }, "linux", "/nowhere")).toEqual([]);
    expect(await exists(join(outside, "emend", "emend.db"))).toBe(true);
    expect(await exists(join(outside, "recense"))).toBe(false);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
