import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compareVersions } from "../version-notice.ts";
import { childEnvironment } from "./environment.ts";

test("the child environment keeps only allowlisted names and fixes PATH, HOME and EMEND_HOME", async () => {
  const env = await childEnvironment(
    {
      PATH: "/evil",
      HOME: "/evil",
      EMEND_HOME: "/evil",
      NODE_OPTIONS: "--require x",
      NODE_PATH: "/x",
      npm_config_prefix: "/x",
      NPM_CONFIG_PREFIX: "/x",
      MISE_ENV: "x",
      LC_TIME: "C",
      XDG_RUNTIME_DIR: "relative",
      https_proxy: "http://proxy.invalid",
      USER: "synthetic",
      UNSET: undefined,
    },
    { path: "/trusted", home: "/home/user", stateDir: "/state" },
    [],
  );
  expect(env).toEqual({
    PATH: "/trusted",
    HOME: "/home/user",
    EMEND_HOME: "/state",
    LC_TIME: "C",
    https_proxy: "http://proxy.invalid",
    USER: "synthetic",
    npm_config_ignore_scripts: "true",
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

const pathNames = [
  "MISE_DATA_DIR",
  "MISE_CONFIG_DIR",
  "MISE_CACHE_DIR",
  "MISE_STATE_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CUSTOM",
  "PNPM_HOME",
  "VOLTA_HOME",
  "NVM_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "TMPDIR",
];
test.each(pathNames)(
  "%s passes only checked absolute paths outside repositories, including link hops",
  async (name) => {
    const root = await mkdtemp(join(process.env.EMEND_HOME as string, "env-"));
    const repo = join(root, "repo");
    const safe = join(root, "safe");
    await mkdir(repo);
    await mkdir(safe);
    await symlink(safe, join(repo, "out"));
    await symlink(join(repo, "out"), join(root, "hop"));
    await symlink(join(root, "loop"), join(root, "loop"));
    const fixed = { path: root, home: root, stateDir: root };
    for (const value of ["relative", repo, join(root, "hop"), join(root, "missing"), join(root, "loop"), "bad\0path"])
      expect(await childEnvironment({ [name]: value }, fixed, [repo])).not.toHaveProperty(name);
    expect(await childEnvironment({ [name]: safe }, fixed, [repo])).toHaveProperty(name, safe);
  },
);
