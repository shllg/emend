import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

export default async function setup(project: TestProject) {
  const root = await mkdtemp(join(tmpdir(), "recense-test-"));
  const home = join(root, "home");
  const env = {
    RECENSE_HOME: join(root, "recense"),
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
  await Promise.all([...new Set(Object.values(env))].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  project.config.env = { ...project.config.env, ...env };
  return async () => {
    await rm(root, { recursive: true, force: true });
  };
}
