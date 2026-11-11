import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { configCommand } from "./commands/config.ts";
import { readConfig } from "./config.ts";
import { escapeReference } from "./escape.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "emend-config-repo-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"),
    repo = join(home, "repo"),
    state = join(root, "state");
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await mkdir(state);
  const configDir = join(repo, ".config", "emend"),
    file = join(configDir, "config.json");
  const warn = vi.fn();
  return { root, home, repo, state, configDir, file, warn, options: { cwd: repo, home, warn } };
}

test.each(["file", "folder link", "file link", "missing"])(
  "repo config is ignored through a %s without migration",
  async (kind) => {
    const f = await fixture();
    const legacy = { docRoots: [join(f.root, "docs")], openBrowser: false, future: true };
    const old = join(f.state, "config.json");
    await writeFile(old, JSON.stringify(legacy));
    let configDir = f.configDir;
    if (kind !== "missing") {
      await mkdir(f.configDir, { recursive: true });
      await writeFile(f.file, JSON.stringify({ docRoots: [f.repo], openBrowser: true }));
    }
    if (kind.endsWith("link")) {
      configDir = join(f.root, "outside");
      if (kind === "folder link") await symlink(f.configDir, configDir);
      else {
        await mkdir(configDir);
        await symlink(f.file, join(configDir, "config.json"));
      }
    }
    expect(await readConfig(f.state, configDir, f.options)).toEqual({ docRoots: legacy.docRoots, openBrowser: false });
    expect(f.warn).toHaveBeenCalledExactlyOnceWith(
      `emend: ignoring ${escapeReference(join(configDir, "config.json"))}: it sits inside the repository at ${escapeReference(f.repo)}\n`,
    );
    expect(await readFile(old, "utf8")).toBe(JSON.stringify(legacy));
    await expect(stat(`${old}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
    if (kind === "missing") await expect(stat(f.configDir)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("an ignored config supplies no roots or browser opt-in without a legacy file", async () => {
  const f = await fixture();
  await mkdir(f.configDir, { recursive: true });
  await writeFile(f.file, JSON.stringify({ docRoots: [f.repo], openBrowser: true }));
  expect(await readConfig(f.state, f.configDir, f.options)).toEqual({ docRoots: [], openBrowser: false });
  expect(await readConfig(f.configDir, f.configDir, f.options)).toEqual({ docRoots: [], openBrowser: false });
});

test.each([
  [],
  ["list"],
  ["add", "docRoots", "/synthetic/docs"],
  ["remove", "docRoots", "/synthetic/docs"],
  ["set", "openBrowser", "true"],
])("config %j refuses to use a repository file", async (...args) => {
  const f = await fixture();
  const io = { env: {}, stdout: vi.fn(), stderr: vi.fn() };
  await expect(configCommand(f.state, f.configDir, args, io, f.repo)).rejects.toThrow(
    `the emend config file ${f.file} sits inside the repository at ${f.repo}; run emend config outside it`,
  );
  expect(io.stdout).not.toHaveBeenCalled();
  await expect(stat(f.configDir)).rejects.toMatchObject({ code: "ENOENT" });
});

test("outside configuration and a home-rooted dotfiles repository remain usable", async () => {
  const f = await fixture();
  await mkdir(join(f.home, ".git"));
  await writeFile(join(f.home, ".git", "HEAD"), "ref: refs/heads/main\n");
  for (const dir of [join(f.root, "outside"), join(f.home, ".config", "emend")]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), '{"openBrowser":true}');
    expect(await readConfig(f.state, dir, f.options)).toEqual({ docRoots: [], openBrowser: true });
  }
  expect(f.warn).not.toHaveBeenCalled();
});
