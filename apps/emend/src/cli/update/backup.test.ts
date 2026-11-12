import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { backupDatabase, backupStamp, pruneBackups } from "./backup.ts";
import { makeDatabase } from "./test-support.ts";

async function state() {
  const dir = await mkdtemp(join(process.env.EMEND_HOME as string, "backup-"));
  await chmod(dir, 0o700);
  return dir;
}

test("the stamp is UTC with milliseconds", () => {
  expect(backupStamp(new Date("2026-11-12T10:20:30.007Z"))).toBe("20261112T102030007Z");
});

test("a failed backup leaves no partial file and says nothing was changed", async () => {
  const dir = await state();
  await writeFile(join(dir, "emend.db"), "not a database");
  await expect(backupDatabase(dir, "0.1.0", new Date())).rejects.toThrow(
    "could not back up the database; nothing was changed.",
  );
  expect(await readdir(join(dir, "backups"))).toEqual([]);
});

test("a backup of a database in WAL mode works", async () => {
  const dir = await state();
  await makeDatabase(join(dir, "emend.db"));
  const path = await backupDatabase(dir, "0.1.0", new Date("2026-11-12T10:20:30.123Z"));
  expect(path).toBe(join(dir, "backups", "emend-0.1.0-20261112T102030123Z.db"));
});

test("pruning keeps the three newest by timestamp and ignores other names", async () => {
  const dir = await state();
  const folder = join(dir, "backups");
  await mkdir(folder, { mode: 0o700 });
  const names = [
    "emend-9.9.9-20260101T000000000Z.db",
    "emend-0.1.0-20260301T000000000Z.db",
    "emend-0.1.0-20260201T000000000Z.db",
    "emend-0.1.0-20260401T000000000Z.db",
    "emend-0.1.0-20260501T000000000Z.db.partial",
    "other.db",
  ];
  for (const name of names) await writeFile(join(folder, name), "x");
  await pruneBackups(dir);
  expect((await readdir(folder)).sort()).toEqual([
    "emend-0.1.0-20260201T000000000Z.db",
    "emend-0.1.0-20260301T000000000Z.db",
    "emend-0.1.0-20260401T000000000Z.db",
    "emend-0.1.0-20260501T000000000Z.db.partial",
    "other.db",
  ]);
});
