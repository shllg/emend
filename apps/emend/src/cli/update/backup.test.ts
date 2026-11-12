import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { backupDatabase, backupStamp, pruneBackups } from "./backup.ts";

const events = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    async open(...args: Parameters<typeof fs.open>) {
      const file = await fs.open(...args);
      const sync = file.sync.bind(file);
      file.sync = async () => {
        events.push("file sync");
        await sync();
      };
      return file;
    },
    async rename(...args: Parameters<typeof fs.rename>) {
      await fs.rename(...args);
      events.push("rename");
    },
  };
});
vi.mock("../../state/files.ts", async (original) => {
  const files = await original<typeof import("../../state/files.ts")>();
  return {
    ...files,
    syncDirectory(path: string) {
      events.push(path);
      files.syncDirectory(path);
    },
  };
});

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

test("a backup includes committed WAL rows while the writer stays open", async () => {
  const dir = await state();
  const writer = new DatabaseSync(join(dir, "emend.db"));
  try {
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('only in WAL');",
    );
    expect(await readdir(dir)).toContain("emend.db-wal");
    const path = await backupDatabase(dir, "0.1.0", new Date("2026-11-12T10:20:30.123Z"));
    const copy = new DatabaseSync(path, { readOnly: true });
    try {
      expect(copy.prepare("SELECT value FROM sample").all()).toEqual([{ value: "only in WAL" }]);
    } finally {
      copy.close();
    }
  } finally {
    writer.close();
  }
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

test.each([false, true])(
  "backup syncs the file, renames, then syncs directories (existing folder: %s)",
  async (existing) => {
    const dir = await state();
    const folder = join(dir, "backups");
    if (existing) await mkdir(folder);
    const db = new DatabaseSync(join(dir, "emend.db"));
    db.exec("CREATE TABLE sample(value TEXT)");
    db.close();
    events.length = 0;
    await backupDatabase(dir, "0.1.0", new Date());
    expect(events).toEqual(["file sync", "rename", folder, ...(existing ? [] : [dir])]);
  },
);
