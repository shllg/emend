import * as fs from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { StateDirModeError, tightenSecretFile, writeSecretFile } from "./files.ts";

const writes = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    fsyncSync(fd: number) {
      writes.push(fs.fstatSync(fd).isDirectory() ? "sync directory" : "sync file");
      fs.fsyncSync(fd);
    },
    renameSync(from: string, to: string) {
      writes.push("rename");
      fs.renameSync(from, to);
    },
  };
});

test("a state mode error retains its original folder for safe CLI formatting", () => {
  const dir = "/synthetic/state\n\u001b[31m";
  const error = new StateDirModeError(dir);
  expect(error.dir).toBe(dir);
  expect(error.message).toBe(
    "State directory /synthetic/state\\u{a}\\u{1b}[31m has group or other permissions; fix it with chmod 700 $'/synthetic/state\\x0a\\x1b[31m'",
  );
});

test("secret writes create private parents, replace files and tighten existing permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-files-"));
  const parent = join(dir, "state", "nested");
  const file = join(parent, "secret");
  try {
    await writeSecretFile(file, "synthetic first", join(dir, "state"));
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "state"))).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await chmod(parent, 0o755);
    await chmod(file, 0o644);
    await writeSecretFile(file, new TextEncoder().encode("synthetic replacement"), join(dir, "state"));
    expect(await readFile(file, "utf8")).toBe("synthetic replacement");
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(parent)).toEqual(["secret"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an existing public state directory is refused without chmodding it or its ancestors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-state-mode-"));
  const state = join(dir, "state");
  try {
    await chmod(dir, 0o755);
    await mkdir(state, { mode: 0o755 });
    await chmod(state, 0o755);
    expect(() => writeSecretFile(join(state, "secret"), "synthetic")).toThrow(StateDirModeError);
    expect(() => writeSecretFile(join(state, "secret"), "synthetic")).toThrow(`chmod 700 '${state}'`);
    expect((await stat(state)).mode & 0o777).toBe(0o755);
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    await writeSecretFile(join(dir, "new", "private", "secret"), "synthetic");
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    expect((await stat(join(dir, "new"))).mode & 0o777).toBe(0o700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secret replacement fsyncs the file before rename and the directory afterward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-durable-write-"));
  try {
    writes.length = 0;
    writeSecretFile(join(dir, "secret"), "synthetic");
    expect(writes).toEqual(["sync file", "rename", "sync directory"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tightening preserves a private file's ctime and chmods only a public file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-file-mode-"));
  const file = join(dir, "synthetic");
  writeSecretFile(file, "Synthetic content", dir);
  const chmodFile = vi.spyOn(fs, "chmodSync");
  try {
    const before = await stat(file, { bigint: true });
    expect(tightenSecretFile(file)).toBe(true);
    expect((await stat(file, { bigint: true })).ctimeNs).toBe(before.ctimeNs);
    expect(chmodFile).not.toHaveBeenCalled();
    await chmod(file, 0o644);
    expect(tightenSecretFile(file)).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(chmodFile).toHaveBeenCalledExactlyOnceWith(file, 0o600);
  } finally {
    chmodFile.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("tightening follows symlinks, returns false for missing paths and propagates other errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-file-path-"));
  try {
    const file = join(dir, "synthetic");
    writeSecretFile(file, "Synthetic content", dir);
    await chmod(file, 0o644);
    const link = join(dir, "link");
    await symlink(file, link);
    expect(tightenSecretFile(link)).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(tightenSecretFile(join(dir, "missing"))).toBe(false);
    expect(() => tightenSecretFile(join(file, "child"))).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
