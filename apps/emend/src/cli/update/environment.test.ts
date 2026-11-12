import { expect, test } from "vitest";
import { compareVersions } from "../version-notice.ts";
import { childEnvironment } from "./environment.ts";

test("the child environment keeps only allowlisted names and fixes PATH, HOME and EMEND_HOME", () => {
  const env = childEnvironment(
    {
      PATH: "/evil",
      HOME: "/evil",
      EMEND_HOME: "/evil",
      NODE_OPTIONS: "--require x",
      NODE_PATH: "/x",
      npm_config_prefix: "/x",
      NPM_CONFIG_PREFIX: "/x",
      MISE_ENV: "x",
      MISE_DATA_DIR: "/data",
      LC_TIME: "C",
      XDG_CONFIG_HOME: "/config",
      XDG_RUNTIME_DIR: "relative",
      https_proxy: "http://proxy.invalid",
      USER: "synthetic",
      UNSET: undefined,
    },
    { path: "/trusted", home: "/home/user", stateDir: "/state" },
  );
  expect(env).toEqual({
    PATH: "/trusted",
    HOME: "/home/user",
    EMEND_HOME: "/state",
    MISE_DATA_DIR: "/data",
    LC_TIME: "C",
    XDG_CONFIG_HOME: "/config",
    https_proxy: "http://proxy.invalid",
    USER: "synthetic",
  });
});

test("compareVersions compares plain versions and gives up on anything else", () => {
  expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
  expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
  expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeNull();
  expect(compareVersions("01.0.0", "1.0.0")).toBeNull();
});
