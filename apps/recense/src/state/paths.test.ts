import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { configDir, defaultConfigDir, defaultStateDir, stateDir } from "./paths.ts";

test("RECENSE_HOME wins on every platform", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    expect(stateDir({ RECENSE_HOME: "/state", XDG_DATA_HOME: "/data" }, platform, "/u")).toBe("/state");
  }
});

test("Linux and other platforms use XDG data with a home fallback", () => {
  expect(stateDir({ XDG_DATA_HOME: "/data" }, "linux", "/u")).toBe("/data/recense");
  expect(stateDir({}, "linux", "/u")).toBe("/u/.local/share/recense");
  expect(stateDir({}, "freebsd", "/u")).toBe("/u/.local/share/recense");
});

test("macOS uses Application Support even when XDG is set", () => {
  expect(stateDir({ XDG_DATA_HOME: "/data" }, "darwin", "/u")).toBe("/u/Library/Application Support/recense");
});

test("the runtime resolver refuses unisolated tests, including traversal and prefix lookalikes", () => {
  for (const RECENSE_HOME of [
    undefined,
    "",
    "/state",
    tmpdir(),
    `${tmpdir()}-elsewhere/state`,
    join(tmpdir(), "..", "state"),
  ]) {
    expect(() => defaultStateDir({ VITEST: "true", RECENSE_HOME })).toThrow(/RECENSE_HOME/);
  }
});

test("the runtime resolver accepts a temporary test home and the guarded process environment", () => {
  const dir = join(tmpdir(), "recense-path-test", "state");
  expect(defaultStateDir({ VITEST: "true", RECENSE_HOME: dir })).toBe(dir);
  expect(defaultStateDir()).toBe(process.env.RECENSE_HOME);
  expect(() => defaultStateDir({ RECENSE_HOME: "/state" })).toThrow(/RECENSE_HOME/);
  expect(() => defaultStateDir({})).toThrow(/RECENSE_HOME/);
  expect(defaultStateDir({ RECENSE_HOME: dir })).toBe(dir);
});

test("relative RECENSE_HOME is refused and relative XDG_DATA_HOME is ignored", () => {
  for (const platform of ["linux", "darwin"]) {
    expect(() => stateDir({ RECENSE_HOME: "state" }, platform, "/u")).toThrow(/absolute/);
    expect(() => stateDir({ RECENSE_HOME: "../state" }, platform, "/u")).toThrow(/absolute/);
  }
  expect(stateDir({ XDG_DATA_HOME: "state" }, "linux", "/u")).toBe("/u/.local/share/recense");
});

test("the test guard refuses a temporary symlink that resolves outside the temporary directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-path-symlink-"));
  try {
    await symlink("/", join(dir, "escape"));
    expect(() => defaultStateDir({ VITEST: "true", RECENSE_HOME: join(dir, "escape", "synthetic-state") })).toThrow(
      /RECENSE_HOME/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["linux", "darwin"] as const)("global config uses XDG or .config on %s", (platform) => {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  try {
    expect(configDir({ XDG_CONFIG_HOME: "/config" }, "/u")).toBe("/config/recense");
    for (const XDG_CONFIG_HOME of [undefined, "", "relative", "../config"]) {
      expect(configDir({ XDG_CONFIG_HOME }, "/u")).toBe("/u/.config/recense");
    }
    expect(defaultConfigDir()).toBe(join(process.env.XDG_CONFIG_HOME as string, "recense"));
  } finally {
    vi.restoreAllMocks();
  }
});

test("the config guard rejects paths outside temp and symlinks escaping temp", async () => {
  for (const XDG_CONFIG_HOME of ["/config", `${tmpdir()}-elsewhere`, join(tmpdir(), "..", "config")]) {
    expect(() => defaultConfigDir({ VITEST: "true", XDG_CONFIG_HOME })).toThrow(/config folder/);
    expect(() => defaultConfigDir({ XDG_CONFIG_HOME })).toThrow(/config folder/);
  }
  const root = await mkdtemp(join(tmpdir(), "recense-config-path-"));
  try {
    const link = join(root, "escape");
    await symlink("/", link);
    expect(() => defaultConfigDir({ XDG_CONFIG_HOME: join(link, "synthetic-config") })).toThrow(/resolve inside/);
    expect(defaultConfigDir({ XDG_CONFIG_HOME: join(root, "missing") })).toBe(join(root, "missing", "recense"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EMEND_HOME, from before the rename, is read when RECENSE_HOME is unset, and RECENSE_HOME wins", () => {
  for (const platform of ["linux", "darwin"]) {
    expect(stateDir({ EMEND_HOME: "/old-state" }, platform, "/u")).toBe("/old-state");
    expect(stateDir({ EMEND_HOME: "/old-state", RECENSE_HOME: "/state" }, platform, "/u")).toBe("/state");
    expect(stateDir({ EMEND_HOME: "", XDG_DATA_HOME: "/data" }, "linux", "/u")).toBe("/data/recense");
    expect(() => stateDir({ EMEND_HOME: "relative" }, platform, "/u")).toThrow(/EMEND_HOME must be an absolute/);
  }
});

test("the test guard checks the value that is used, whichever name set it", () => {
  const dir = join(tmpdir(), "recense-path-test", "legacy-name");
  expect(defaultStateDir({ VITEST: "true", EMEND_HOME: dir })).toBe(dir);
  for (const EMEND_HOME of ["/state", tmpdir(), join(tmpdir(), "..", "state")])
    expect(() => defaultStateDir({ VITEST: "true", EMEND_HOME })).toThrow(/RECENSE_HOME/);
  // A safe RECENSE_HOME wins over an unsafe EMEND_HOME, and an unsafe RECENSE_HOME is never rescued by a safe EMEND_HOME.
  expect(defaultStateDir({ VITEST: "true", RECENSE_HOME: dir, EMEND_HOME: "/state" })).toBe(dir);
  expect(() => defaultStateDir({ VITEST: "true", RECENSE_HOME: "/state", EMEND_HOME: dir })).toThrow(/RECENSE_HOME/);
});

test("under a state override the config folder keeps its old name until a default run moves it", async () => {
  const root = await mkdtemp(join(tmpdir(), "recense-path-config-"));
  try {
    const env = { XDG_CONFIG_HOME: root, RECENSE_HOME: join(root, "state") };
    // Neither folder: the new name. Only the old one: read in place. Both: the new one.
    expect(configDir(env, "/u")).toBe(join(root, "recense"));
    await mkdir(join(root, "emend"));
    expect(configDir(env, "/u")).toBe(join(root, "emend"));
    expect(configDir({ XDG_CONFIG_HOME: root, EMEND_HOME: join(root, "state") }, "/u")).toBe(join(root, "emend"));
    // A default run never reads the old folder: it moves it first.
    expect(configDir({ XDG_CONFIG_HOME: root }, "/u")).toBe(join(root, "recense"));
    await mkdir(join(root, "recense"));
    expect(configDir(env, "/u")).toBe(join(root, "recense"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
