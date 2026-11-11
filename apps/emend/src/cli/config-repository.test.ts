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

test.each(["folder", "file", "intermediate folder", "intermediate file"])(
  "a repository %s link pointing outside is ignored and config add refuses it",
  async (kind) => {
    const f = await fixture();
    const outside = join(f.root, "outside");
    await mkdir(outside);
    const content = JSON.stringify({ docRoots: [outside], openBrowser: true });
    const target = join(outside, "config.json");
    await writeFile(target, content);
    const folder = kind.endsWith("folder");
    await mkdir(folder ? join(f.repo, ".config") : f.configDir, { recursive: true });
    const link = folder ? f.configDir : f.file;
    await symlink(folder ? outside : target, link);
    let configDir = f.configDir;
    if (kind.startsWith("intermediate")) {
      configDir = join(f.root, "alias");
      if (folder) await symlink(f.configDir, configDir);
      else {
        await mkdir(configDir);
        await symlink(f.file, join(configDir, "config.json"));
      }
    }
    const configured = join(configDir, "config.json");
    expect(await readConfig(f.state, configDir, f.options)).toEqual({ docRoots: [], openBrowser: false });
    expect(f.warn).toHaveBeenCalledExactlyOnceWith(
      `emend: ignoring ${configured}: it sits inside the repository at ${f.repo}\n`,
    );
    const io = { env: {}, stdout: vi.fn(), stderr: vi.fn() };
    await expect(configCommand(f.state, configDir, ["add", "docRoots", outside], io, f.repo)).rejects.toThrow(
      `the emend config file ${configured} sits inside the repository at ${f.repo}; run emend config outside it`,
    );
    expect(await readFile(target, "utf8")).toBe(content);
    // Even a dangling target must not receive a migration through the repository link.
    await rm(target);
    const old = join(f.state, "config.json");
    await writeFile(old, '{"openBrowser":false}');
    expect(await readConfig(f.state, configDir, f.options)).toEqual({ docRoots: [], openBrowser: false });
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(old, "utf8")).toBe('{"openBrowser":false}');
    await expect(stat(`${old}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("a home link into a dotfiles repository works from outside that repository", async () => {
  const f = await fixture();
  const target = join(f.repo, "emend");
  await mkdir(target);
  await writeFile(join(target, "config.json"), '{"openBrowser":true}');
  const configDir = join(f.home, ".config", "emend");
  await mkdir(join(f.home, ".config"));
  await symlink(target, configDir);
  expect(await readConfig(f.state, configDir, { ...f.options, cwd: f.home })).toEqual({
    docRoots: [],
    openBrowser: true,
  });
  expect(f.warn).not.toHaveBeenCalled();
});

test.each(["file", "folder link", "file link", "intermediate link"])(
  "an old config with a repository %s is never read or archived",
  async (kind) => {
    const f = await fixture();
    const repoState = join(f.repo, ".emend");
    await mkdir(repoState);
    let state = repoState;
    let target = join(repoState, "config.json");
    if (kind !== "file") {
      target = join(f.state, "config.json");
      if (kind === "folder link") {
        await rm(repoState, { recursive: true });
        await symlink(f.state, repoState);
      } else await symlink(target, join(repoState, "config.json"));
      if (kind === "intermediate link") {
        state = join(f.root, "alias");
        await symlink(repoState, state);
      }
    }
    // Invalid JSON makes an accidental read fail, even if its values would be discarded.
    await writeFile(target, "{");
    const global = join(f.root, "global");
    for (const existing of [false, true]) {
      if (existing) {
        await mkdir(global);
        await writeFile(join(global, "config.json"), '{"openBrowser":true}');
      }
      expect(await readConfig(state, global, f.options)).toEqual({ docRoots: [], openBrowser: existing });
      if (!existing) await expect(stat(global)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(target, "utf8")).toBe("{");
      await expect(stat(join(state, "config.json.migrated"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(f.warn).not.toHaveBeenCalled();
  },
);
