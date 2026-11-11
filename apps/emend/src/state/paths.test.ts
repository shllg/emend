import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { configDir, defaultConfigDir, defaultStateDir, stateDir } from "./paths.ts";

test("EMEND_HOME wins on every platform", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    expect(stateDir({ EMEND_HOME: "/state", XDG_DATA_HOME: "/data" }, platform, "/u")).toBe("/state");
  }
});

test("Linux and other platforms use XDG data with a home fallback", () => {
  expect(stateDir({ XDG_DATA_HOME: "/data" }, "linux", "/u")).toBe("/data/emend");
  expect(stateDir({}, "linux", "/u")).toBe("/u/.local/share/emend");
  expect(stateDir({}, "freebsd", "/u")).toBe("/u/.local/share/emend");
});

test("macOS uses Application Support even when XDG is set", () => {
  expect(stateDir({ XDG_DATA_HOME: "/data" }, "darwin", "/u")).toBe("/u/Library/Application Support/emend");
});

test("the runtime resolver refuses unisolated tests, including traversal and prefix lookalikes", () => {
  for (const EMEND_HOME of [
    undefined,
    "",
    "/state",
    tmpdir(),
    `${tmpdir()}-elsewhere/state`,
    join(tmpdir(), "..", "state"),
  ]) {
    expect(() => defaultStateDir({ VITEST: "true", EMEND_HOME })).toThrow(/EMEND_HOME/);
  }
});

test("the runtime resolver accepts a temporary test home and the guarded process environment", () => {
  const dir = join(tmpdir(), "emend-path-test", "state");
  expect(defaultStateDir({ VITEST: "true", EMEND_HOME: dir })).toBe(dir);
  expect(defaultStateDir()).toBe(process.env.EMEND_HOME);
  expect(() => defaultStateDir({ EMEND_HOME: "/state" })).toThrow(/EMEND_HOME/);
  expect(() => defaultStateDir({})).toThrow(/EMEND_HOME/);
  expect(defaultStateDir({ EMEND_HOME: dir })).toBe(dir);
});

test("relative EMEND_HOME is refused and relative XDG_DATA_HOME is ignored", () => {
  for (const platform of ["linux", "darwin"]) {
    expect(() => stateDir({ EMEND_HOME: "state" }, platform, "/u")).toThrow(/absolute/);
    expect(() => stateDir({ EMEND_HOME: "../state" }, platform, "/u")).toThrow(/absolute/);
  }
  expect(stateDir({ XDG_DATA_HOME: "state" }, "linux", "/u")).toBe("/u/.local/share/emend");
});

test("the test guard refuses a temporary symlink that resolves outside the temporary directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-path-symlink-"));
  try {
    await symlink("/", join(dir, "escape"));
    expect(() => defaultStateDir({ VITEST: "true", EMEND_HOME: join(dir, "escape", "synthetic-state") })).toThrow(
      /EMEND_HOME/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["linux", "darwin"] as const)("global config uses XDG or .config on %s", (platform) => {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  try {
    expect(configDir({ XDG_CONFIG_HOME: "/config" }, "/u")).toBe("/config/emend");
    for (const XDG_CONFIG_HOME of [undefined, "", "relative", "../config"]) {
      expect(configDir({ XDG_CONFIG_HOME }, "/u")).toBe("/u/.config/emend");
    }
    expect(defaultConfigDir()).toBe(join(process.env.XDG_CONFIG_HOME as string, "emend"));
  } finally {
    vi.restoreAllMocks();
  }
});

test("the config guard rejects paths outside temp and symlinks escaping temp", async () => {
  for (const XDG_CONFIG_HOME of ["/config", `${tmpdir()}-elsewhere`, join(tmpdir(), "..", "config")]) {
    expect(() => defaultConfigDir({ VITEST: "true", XDG_CONFIG_HOME })).toThrow(/config folder/);
    expect(() => defaultConfigDir({ XDG_CONFIG_HOME })).toThrow(/config folder/);
  }
  const root = await mkdtemp(join(tmpdir(), "emend-config-path-"));
  try {
    const link = join(root, "escape");
    await symlink("/", link);
    expect(() => defaultConfigDir({ XDG_CONFIG_HOME: join(link, "synthetic-config") })).toThrow(/resolve inside/);
    expect(defaultConfigDir({ XDG_CONFIG_HOME: join(root, "missing") })).toBe(join(root, "missing", "emend"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
