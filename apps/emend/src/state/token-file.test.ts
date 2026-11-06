import * as fs from "node:fs/promises";
import { chmod, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { expect, test, vi } from "vitest";
import { errorLine } from "../cli/http.ts";
import { commandFixture } from "../cli/test-support.ts";
import { run } from "../main.ts";
import { StateDirModeError, writeSecretFile } from "./files.ts";
import { checkTokenFileMode, readTokenFile } from "./token-file.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));

test.each([0o004, 0o040, 0o044])("mode %i is refused before open even without owner read permission", async (mode) => {
  const f = await commandFixture();
  const path = join(f.dir, "agent.token");
  await chmod(path, mode);
  const open = vi.spyOn(fs, "open");
  await expect(readTokenFile(path)).rejects.toMatchObject({ name: "TokenFileModeError", path });
  await expect(checkTokenFileMode(path)).rejects.toMatchObject({ name: "TokenFileModeError", path });
  expect(open).not.toHaveBeenCalled();
  expect((await stat(path)).mode & 0o777).toBe(mode);
});

test.each([0o004, 0o040, 0o044])("ls refuses agent.token mode %i with the chmod line", async (mode) => {
  const f = await commandFixture();
  const path = join(f.dir, "agent.token");
  await chmod(path, mode);
  expect(await run(["ls"], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([`Token file ${path} has group or other permissions; fix it with chmod 600 '${path}'\n`]);
  expect(f.fetcher.mock.calls.every(([, init]) => !new Headers(init?.headers).has("Authorization"))).toBe(true);
  expect((await stat(path)).mode & 0o777).toBe(mode);
});

test("a loose state folder is refused before inspecting or opening the token", async () => {
  const f = await commandFixture();
  await chmod(f.dir, 0o755);
  const inspect = vi.spyOn(fs, "lstat");
  const open = vi.spyOn(fs, "open");
  await expect(readTokenFile(join(relative(process.cwd(), f.dir), "agent.token"))).rejects.toMatchObject({
    name: "StateDirModeError",
    dir: f.dir,
  });
  expect(inspect).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

test.each([0o040, 0o020, 0o010, 0o004, 0o002, 0o001])(
  "token check refuses permission bit %i on the opened descriptor before reading",
  async (bit) => {
    const f = await commandFixture();
    const path = join(f.dir, "agent.token");
    const open = fs.open;
    const read = vi.fn(async () => "synthetic");
    const close = vi.fn();
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const file = await open(...args);
      await file.chmod(0o600 | bit);
      vi.spyOn(file, "readFile").mockImplementation(read);
      const originalClose = file.close.bind(file);
      vi.spyOn(file, "close").mockImplementation(async () => {
        close();
        await originalClose();
      });
      return file;
    });
    await expect(readTokenFile(path)).rejects.toThrow("has group or other permissions; fix it with chmod 600");
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect((await stat(path)).mode & 0o777).toBe(0o600 | bit);
  },
);

test("token mode advice escapes terminal controls and quotes the shell argument", async () => {
  const f = await commandFixture();
  const dir = join(f.dir, "state'\n\u001b[31m");
  await mkdir(dir, { mode: 0o700 });
  const path = join(dir, "hub.token");
  writeSecretFile(path, "synthetic");
  await chmod(path, 0o644);
  const error = await readTokenFile(path).then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).not.toBeInstanceOf(StateDirModeError);
  expect(errorLine(error)).toBe(
    `Token file ${f.dir}/state'\\u{a}\\u{1b}[31m/hub.token has group or other permissions; fix it with chmod 600 $'${f.dir}/state\\'\\x0a\\x1b[31m/hub.token'\n`,
  );
});

test("reading an absent token or state folder creates nothing", async () => {
  const f = await commandFixture();
  const before = await readdir(f.dir);
  expect(await readTokenFile(join(f.dir, "hub.token"))).toBeNull();
  expect(await readTokenFile(join(f.dir, "absent", "hub.token"))).toBeNull();
  expect(await readdir(f.dir)).toEqual(before);
});

test("the server still tightens a loose token before reading it", async () => {
  const f = await commandFixture();
  const path = join(f.dir, "agent.token");
  const before = await readFile(path);
  await chmod(path, 0o644);
  expect(await readTokenFile(path, { tighten: true })).toBe(before.toString());
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readFile(path)).toEqual(before);
});
