import * as fs from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import { expect, onTestFinished, test, vi } from "vitest";
import { readConfig, validateDocRoot } from "./config.ts";
import { escapeReference } from "./escape.ts";
import * as reader from "./publish/read.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));
vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()) }));

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "emend-config-")));
  vi.spyOn(os, "userInfo").mockReturnValue({
    homedir: join(dir, "account-home"),
    username: "synthetic",
    uid: 1000,
    gid: 1000,
    shell: null,
  });
  onTestFinished(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, path: join(dir, "config.json") };
}

test("a missing configuration uses defaults", async () => {
  const { dir } = await fixture();
  expect(await readConfig(join(dir, "state"), dir)).toEqual({ docRoots: [], openBrowser: false });
});

test.each([{}, { openBrowser: true }, { openBrowser: false }, { unknown: "ignored" }])(
  "optional keys and unknown keys are accepted: %j",
  async (config) => {
    const { dir, path } = await fixture();
    await writeFile(path, JSON.stringify(config));
    expect(await readConfig(join(dir, "state"), dir)).toEqual({
      docRoots: [],
      openBrowser: "openBrowser" in config && config.openBrowser,
    });
  },
);

test("docRoots and openBrowser can be used together", async () => {
  const { dir, path } = await fixture();
  await mkdir(join(dir, "docs"));
  const config = { docRoots: [join(dir, "docs")], openBrowser: true };
  await writeFile(path, JSON.stringify(config));
  expect(await readConfig(join(dir, "state"), dir)).toEqual(config);
});

test.each([
  "null",
  "[]",
  "true",
  "42",
  '"config"',
  "{",
  '{"docRoots": null}',
  '{"docRoots": "docs"}',
  '{"docRoots": [42]}',
  '{"docRoots": ["relative/docs"]}',
  '{"openBrowser": null}',
  '{"openBrowser": "true"}',
  '{"openBrowser": 1}',
  '{"openBrowser": []}',
  '{"openBrowser": {}}',
])("invalid configuration is refused: %s", async (config) => {
  const { dir, path } = await fixture();
  await writeFile(path, config);
  await expect(readConfig(join(dir, "state"), dir)).rejects.toThrow(
    `invalid emend configuration in ${escapeReference(path)}`,
  );
});

test.each(["EACCES", "EPERM", "EROFS"])("configuration names the global file on %s", async (code) => {
  const { dir, path } = await fixture();
  await writeFile(path, "{}");
  vi.spyOn(reader, "readRegular").mockRejectedValueOnce(Object.assign(new Error("synthetic denial"), { code, path }));
  await expect(readConfig(join(dir, "state"), dir)).rejects.toThrow(
    `invalid emend configuration in ${escapeReference(path)}`,
  );
});

test("configuration retains regular-file and size limits", async () => {
  const { dir, path } = await fixture();
  const source = join(dir, "source.json");
  await writeFile(source, "{}");
  await symlink(source, path);
  expect(await readConfig(join(dir, "state"), dir)).toEqual({ docRoots: [], openBrowser: false });
  await rm(path);
  await writeFile(path, "{}".padEnd(LIMITS.publicJsonBytes, " "));
  expect(await readConfig(join(dir, "state"), dir)).toEqual({ docRoots: [], openBrowser: false });
  await appendFile(path, " ");
  await expect(readConfig(join(dir, "state"), dir)).rejects.toThrow(
    `invalid emend configuration in ${escapeReference(path)}`,
  );
});

async function rootFixture() {
  const f = await fixture();
  const root = await realpath(f.dir);
  const homeParent = join(root, "homes");
  const home = join(homeParent, "reviewer");
  const stateParent = join(root, "data");
  const state = join(stateParent, "emend");
  const docs = join(home, "docs");
  await mkdir(docs, { recursive: true });
  await mkdir(state, { recursive: true, mode: 0o700 });
  return { root, homeParent, home, stateParent, state, docs };
}

test("root validation refuses both the real home and its parent", async () => {
  const f = await rootFixture();
  const alias = join(f.root, "home-alias");
  await symlink(f.home, alias, "dir");
  for (const home of [f.home, alias]) {
    for (const root of [f.home, f.homeParent]) {
      await expect(validateDocRoot(root, home, f.state)).rejects.toThrow(
        /^docRoots cannot be the home folder or hold it$/,
      );
    }
  }
});

test("root validation refuses both directions of containment with the real state folder", async () => {
  const f = await rootFixture();
  const child = join(f.state, "nested");
  await mkdir(child);
  const alias = join(f.root, "state-alias");
  await symlink(f.state, alias, "dir");
  for (const state of [f.state, alias]) {
    for (const root of [f.state, f.stateParent, child]) {
      await expect(validateDocRoot(root, f.home, state)).rejects.toThrow(
        /^docRoots cannot hold or sit inside emend's state folder$/,
      );
    }
  }
});

test.each([false, true])("a custom state below a doc root is refused (exists: %s)", async (exists) => {
  const f = await rootFixture();
  const state = join(f.docs, "state");
  if (exists) await mkdir(state);
  await expect(validateDocRoot(f.docs, f.home, state)).rejects.toThrow(
    /^docRoots cannot hold or sit inside emend's state folder$/,
  );
});

test("a missing state folder resolves through a symlinked parent", async () => {
  const f = await rootFixture();
  const target = join(f.root, "dot");
  await mkdir(join(target, "share"), { recursive: true });
  const link = join(f.root, "linked");
  await symlink(target, link, "dir");
  const state = join(link, "share", "emend");
  await expect(validateDocRoot(target, f.home, state)).rejects.toThrow(
    /^docRoots cannot hold or sit inside emend's state folder$/,
  );
  await expect(validateDocRoot(f.docs, f.home, state)).resolves.toBeUndefined();
});

test("a missing home folder does not fail as a raw error", async () => {
  const f = await rootFixture();
  const home = join(f.root, "no-home", "reviewer");
  await expect(validateDocRoot(f.docs, home, f.state)).resolves.toBeUndefined();
  await expect(validateDocRoot(join(f.root, "no-home"), home, f.state)).rejects.toThrow(
    /^docRoots cannot be the home folder or hold it$/,
  );
});

test("root validation permits home/docs and sibling names that merely share a path prefix", async () => {
  const f = await rootFixture();
  for (const root of [f.docs, `${f.home}-docs`, `${f.state}-docs`]) {
    if (root !== f.docs) await mkdir(root);
    await expect(validateDocRoot(root, f.home, f.state)).resolves.toBeUndefined();
  }
});

test.each(["state", "state ancestor", "home", "account home"])(
  "root validation follows a dangling %s symlink and retains its missing tail",
  async (kind) => {
    const f = await rootFixture();
    const link = join(f.root, "dangling");
    await symlink("homes/reviewer/docs/missing", link, "dir");
    let home = f.home;
    let state = f.state;
    let account = f.home;
    if (kind === "state") state = link;
    else if (kind === "state ancestor") state = join(link, "share", "emend");
    else if (kind === "home") home = join(link, "reviewer");
    else account = join(link, "reviewer");
    await expect(validateDocRoot(f.docs, home, state, () => account)).rejects.toThrow(
      kind.startsWith("state")
        ? /^docRoots cannot hold or sit inside emend's state folder$/
        : /^docRoots cannot be the home folder or hold it$/,
    );
  },
);

test("a dangling state alias retains the tail beyond its target", async () => {
  const f = await rootFixture();
  const link = join(f.root, "dangling");
  await symlink("homes/reviewer/docs/missing", link, "dir");
  const state = join(link, "share", "emend");
  await expect(validateDocRoot(join(f.docs, "missing", "share"), f.home, state)).rejects.toThrow(
    /^docRoots cannot hold or sit inside emend's state folder$/,
  );
  await expect(validateDocRoot(join(f.docs, "missing", "other"), f.home, state)).resolves.toBeUndefined();
});

test.each([40, 41])("dangling symlink resolution caps traversal at 40 hops (chain: %s)", async (count) => {
  const f = await rootFixture();
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const template = join(f.root, "template");
  await symlink("absent", template, "dir");
  const linkInfo = await actualFs.lstat(template);
  const links = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    links.set(join(f.root, `link-${i}`), i === count - 1 ? "absent" : `link-${i + 1}`);
  }
  // No real link chain reaches the kernel: every hop must pass through the explicit cap.
  vi.spyOn(fs, "realpath").mockImplementation(async (...args: unknown[]) => {
    if (links.has(String(args[0]))) throw Object.assign(new Error("synthetic dangling link"), { code: "ENOENT" });
    return Reflect.apply(actualFs.realpath, undefined, args);
  });
  vi.spyOn(fs, "lstat").mockImplementation(async (...args: unknown[]) => {
    if (links.has(String(args[0]))) return linkInfo;
    return Reflect.apply(actualFs.lstat, undefined, args);
  });
  const readlink = vi.spyOn(fs, "readlink").mockImplementation(async (...args: unknown[]) => {
    const target = links.get(String(args[0]));
    return target ?? Reflect.apply(actualFs.readlink, undefined, args);
  });
  const state = join(f.root, "link-0");
  const result = validateDocRoot(f.docs, f.home, state);
  if (count === 40) await expect(result).resolves.toBeUndefined();
  else await expect(result).rejects.toThrow(`cannot check docRoots: ${state} cannot be read`);
  expect(readlink).toHaveBeenCalledTimes(40);
});

test("a relative dangling link behind a parent alias is missing rather than a loop", async () => {
  const f = await rootFixture();
  const parent = join(f.root, "q");
  await mkdir(join(parent, "real", "deep"), { recursive: true });
  await symlink("real/deep", join(parent, "sub"), "dir");
  await symlink("../sub/x", join(parent, "real", "deep", "x"), "dir");
  const state = join(parent, "sub", "x");
  await expect(validateDocRoot(f.docs, f.home, state)).resolves.toBeUndefined();
  await expect(validateDocRoot(join(parent, "real", "sub"), f.home, state)).rejects.toMatchObject({
    reason: "state",
  });
});

test.each([
  ["home", "EACCES"],
  ["account home", "EACCES"],
  ["state", "EACCES"],
  ["home", "ELOOP"],
  ["account home", "ELOOP"],
  ["state", "ELOOP"],
])("an unreadable %s (%s) names the original folder, not its failing ancestor", async (kind, code) => {
  const f = await rootFixture();
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const ancestor = join(f.root, "blocked\n\u001b[31m");
  const folder = join(ancestor, "missing", "folder");
  vi.spyOn(fs, "realpath").mockImplementation(async (...args: unknown[]) => {
    if (args[0] === ancestor) throw Object.assign(new Error("synthetic resolution failure"), { code });
    return Reflect.apply(actualFs.realpath, undefined, args);
  });
  await expect(
    validateDocRoot(f.docs, kind === "home" ? folder : f.home, kind === "state" ? folder : f.state, () =>
      kind === "account home" ? folder : f.home,
    ),
  ).rejects.toThrow(`cannot check docRoots: ${escapeReference(folder)} cannot be read`);
});

test("both home providers are injectable and a missing passwd entry falls back to HOME", async () => {
  const f = await rootFixture();
  const account = join(f.docs, "account-home");
  await expect(validateDocRoot(f.docs, f.home, f.state, () => account)).rejects.toMatchObject({ reason: "home" });
  const noAccount = () => {
    throw new Error("no passwd entry");
  };
  await expect(validateDocRoot(f.docs, f.home, f.state, noAccount)).resolves.toBeUndefined();
  await expect(validateDocRoot(f.homeParent, f.home, f.state, noAccount)).rejects.toMatchObject({ reason: "home" });
});
