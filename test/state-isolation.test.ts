import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { expect, test } from "vitest";
import { defaultConfigDir } from "../apps/emend/src/state/paths.ts";

test("state and home fallback paths share one private temporary root", () => {
  const home = process.env.EMEND_HOME;
  expect(home).toBeDefined();
  if (!home) throw new Error("EMEND_HOME must be set before tests run");
  const root = dirname(home);
  const path = relative(tmpdir(), root);
  expect(isAbsolute(path)).toBe(false);
  expect(path.split(sep)).toHaveLength(1);
  expect(path).toMatch(/^emend-test-/);
  for (const directory of [
    home,
    homedir(),
    process.env.HOME,
    process.env.USERPROFILE,
    process.env.XDG_DATA_HOME,
    process.env.XDG_STATE_HOME,
    process.env.XDG_CONFIG_HOME,
    process.env.XDG_CACHE_HOME,
  ]) {
    expect(directory).toBeDefined();
    if (!directory) throw new Error("All state and home fallback paths must be set before tests run");
    const withinRoot = relative(root, directory);
    expect(withinRoot).not.toBe("");
    expect(isAbsolute(withinRoot)).toBe(false);
    expect(withinRoot.split(sep)).not.toContain("..");
    expect(statSync(directory).isDirectory()).toBe(true);
  }
  const config = relative(root, defaultConfigDir());
  expect(isAbsolute(config)).toBe(false);
  expect(config.split(sep)).not.toContain("..");
  expect(config).not.toBe("");
  expect(statSync(home).isDirectory()).toBe(true);
  expect(statSync(home).mode & 0o777).toBe(0o700);
});
