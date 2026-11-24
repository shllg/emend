import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { isolatedEnvironment } from "./isolated-env.ts";

test("every folder the CLI reads or moves is pinned under the work folder, whatever the parent sets", () => {
  const work = mkdtempSync(join(tmpdir(), "recense-isolated-"));
  try {
    const parent = {
      HOME: "/synthetic/user",
      XDG_CONFIG_HOME: "/synthetic/user/.config",
      XDG_DATA_HOME: "/synthetic/user/.local/share",
      XDG_STATE_HOME: "/synthetic/user/.local/state",
      XDG_CACHE_HOME: "/synthetic/user/.cache",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_SOMETHING_ELSE: "/synthetic/user/else",
      RECENSE_HOME: "/synthetic/user/.local/share/recense",
      EMEND_HOME: "/synthetic/user/.local/share/emend",
      npm_config_cache: "/synthetic/user/.npm",
      PATH: "/usr/bin",
    };
    const pinned = isolatedEnvironment(work, parent);
    for (const key of [
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "XDG_RUNTIME_DIR",
      "RECENSE_HOME",
      "EMEND_HOME",
    ]) {
      const value = pinned[key];
      assert.ok(value, `${key} is set`);
      assert.ok(!relative(work, value).startsWith(".."), `${key} is inside the work folder`);
    }
    assert.equal(pinned.PATH, "/usr/bin");
    assert.equal(pinned.npm_config_cache, undefined);
    assert.equal(pinned.XDG_SOMETHING_ELSE, undefined);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
