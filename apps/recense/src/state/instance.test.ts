import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { loadOrCreateInstance } from "./instance.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, linkSync: vi.fn(fs.linkSync) };
});

test("an instance keeps its UUID and name across loads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-instance-"));
  try {
    const first = await loadOrCreateInstance(dir);
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.name).toBe(hostname());
    expect(await loadOrCreateInstance(dir)).toEqual(first);
    expect(JSON.parse(await readFile(join(dir, "instance.json"), "utf8"))).toEqual(first);
    expect((await stat(join(dir, "instance.json"))).mode & 0o777).toBe(0o600);
    await writeFile(join(dir, "instance.json"), JSON.stringify({ ...first, name: "Synthetic machine" }));
    await chmod(join(dir, "instance.json"), 0o644);
    expect((await loadOrCreateInstance(dir)).name).toBe("Synthetic machine");
    expect((await stat(join(dir, "instance.json"))).mode & 0o777).toBe(0o600);
    await writeFile(join(dir, "instance.json"), "{}");
    await expect(loadOrCreateInstance(dir)).rejects.toThrow();
    expect(await readFile(join(dir, "instance.json"), "utf8")).toBe("{}");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two simultaneous instance loads return the stored id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-instance-race-"));
  try {
    const [first, second] = await Promise.all([loadOrCreateInstance(dir), loadOrCreateInstance(dir)]);
    expect(first).toEqual(second);
    expect(JSON.parse(await readFile(join(dir, "instance.json"), "utf8"))).toEqual(first);
    expect(await readdir(dir)).toEqual(["instance.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an instance creator losing the link race returns the winner and removes its temp file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-instance-winner-"));
  const winner = { id: randomUUID(), name: "Synthetic winner" };
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(linkSync).mockImplementationOnce((from, to) => {
    fs.writeFileSync(to, JSON.stringify(winner), { mode: 0o644 });
    fs.linkSync(from, to);
  });
  try {
    expect(await loadOrCreateInstance(dir)).toEqual(winner);
    expect(await readdir(dir)).toEqual(["instance.json"]);
    expect((await stat(join(dir, "instance.json"))).mode & 0o777).toBe(0o600);
  } finally {
    vi.mocked(linkSync).mockReset().mockImplementation(fs.linkSync);
    await rm(dir, { recursive: true, force: true });
  }
});
