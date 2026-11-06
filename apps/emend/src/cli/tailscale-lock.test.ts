import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { lockTailscaleServe } from "./tailscale-lock.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function state() {
  const dir = await mkdtemp(join(tmpdir(), "emend-ts-lock-"));
  dirs.push(dir);
  return dir;
}
function clock() {
  let at = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => at,
    sleep: async (ms: number) => {
      waits.push(ms);
      at += ms;
    },
  };
}

test("the lock file is created 0600 and the lock excludes a second holder until released", async () => {
  const dir = await state();
  const release = await lockTailscaleServe(dir);
  expect((await stat(join(dir, "tailscale-serve.lock"))).mode & 0o777).toBe(0o600);
  const c = clock();
  await expect(lockTailscaleServe(dir, { ...c, timeoutMs: 200 })).rejects.toThrow(
    "another emend is changing the Tailscale Serve route; try again.",
  );
  release();
  release();
  (await lockTailscaleServe(dir))();
  expect((await readdir(dir)).filter((name) => name.startsWith("tailscale-serve.lock"))).toEqual([
    "tailscale-serve.lock",
  ]);
});

test("a waiter retries with an async sleep until the holder releases", async () => {
  const dir = await state();
  const holder = new DatabaseSync(join(dir, "tailscale-serve.lock"));
  holder.exec("PRAGMA locking_mode = EXCLUSIVE");
  holder.exec("BEGIN EXCLUSIVE");
  const c = clock();
  let calls = 0;
  const release = await lockTailscaleServe(dir, {
    now: c.now,
    sleep: async (ms) => {
      calls += 1;
      await c.sleep(ms);
      if (calls === 3) {
        holder.exec("ROLLBACK");
        holder.close();
      }
    },
  });
  expect(c.waits).toEqual([50, 50, 50]);
  release();
});

test("the deadline refuses with the route message after waiting in 50 ms steps", async () => {
  const dir = await state();
  const holder = new DatabaseSync(join(dir, "tailscale-serve.lock"));
  holder.exec("PRAGMA locking_mode = EXCLUSIVE");
  holder.exec("BEGIN EXCLUSIVE");
  const c = clock();
  await expect(lockTailscaleServe(dir, { now: c.now, sleep: c.sleep, timeoutMs: 120 })).rejects.toThrow(
    "another emend is changing the Tailscale Serve route; try again.",
  );
  expect(c.waits).toEqual([50, 50, 20]);
  holder.close();
});

test("a missing state folder is not created and needs no lock", async () => {
  const dir = join(await state(), "absent");
  (await lockTailscaleServe(dir))();
  await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
});
