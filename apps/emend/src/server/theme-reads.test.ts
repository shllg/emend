import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThemeEntry, ThemeList } from "@emend/contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as themes from "../state/themes.ts";
import { listThemesForRequest, readThemeForRequest } from "./theme-reads.ts";

vi.mock("../state/themes.ts", async (original) => ({ ...(await original<typeof import("../state/themes.ts")>()) }));

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "emend-theme-reads-"));
  dir = join(root, "themes");
  await mkdir(dir);
  await writeFile(join(dir, "mine.json"), JSON.stringify({ version: 1, base: "dark" }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const refused: ThemeEntry = {
  valid: false,
  name: "mine",
  base: "dark",
  problems: ["The file is not valid JSON."],
};

test.each(["fulfilled", "rejected"] as const)(
  "list requests share one queued read after a %s running read, then read afresh",
  async (outcome) => {
    const a = Promise.withResolvers<ThemeList>();
    const b = Promise.withResolvers<ThemeList>();
    const old: ThemeList = { themes: [], folderError: false };
    const fresh: ThemeList = { themes: [refused], folderError: false };
    const failure = new Error("read failed");
    const order: string[] = [];
    const list = vi
      .spyOn(themes, "listThemes")
      .mockImplementationOnce(() => {
        order.push("A started");
        return a.promise.finally(() => order.push("A settled"));
      })
      .mockImplementationOnce(() => {
        order.push("B started");
        return b.promise;
      });
    const first = listThemesForRequest(dir);
    const firstResult = Promise.allSettled([first]);
    const second = listThemesForRequest(dir);
    const third = listThemesForRequest(dir);
    try {
      expect(second).not.toBe(first);
      expect(third).toBe(second);
      await Promise.resolve();
      expect(list).toHaveBeenCalledExactlyOnceWith(dir);
      expect(order).toEqual(["A started"]);
      if (outcome === "fulfilled") a.resolve(old);
      else a.reject(failure);
      expect(await firstResult).toEqual([
        outcome === "fulfilled" ? { status: "fulfilled", value: old } : { status: "rejected", reason: failure },
      ]);
      expect(order).toEqual(["A started", "A settled", "B started"]);
      expect(list).toHaveBeenCalledTimes(2);
      b.resolve(fresh);
      expect(await Promise.all([second, third])).toEqual([fresh, fresh]);
      expect(await listThemesForRequest(dir)).toMatchObject({
        themes: [{ name: "mine", valid: true }],
        folderError: false,
      });
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      a.resolve(old);
      b.resolve(fresh);
      await Promise.allSettled([first, second, third]);
    }
  },
);

test.each(["fulfilled", "rejected"] as const)(
  "theme requests share one queued read after a %s running read, then read afresh",
  async (outcome) => {
    const a = Promise.withResolvers<ThemeEntry | null>();
    const b = Promise.withResolvers<ThemeEntry | null>();
    const failure = new Error("read failed");
    const order: string[] = [];
    const read = vi
      .spyOn(themes, "readTheme")
      .mockImplementationOnce(() => {
        order.push("A started");
        return a.promise.finally(() => order.push("A settled"));
      })
      .mockImplementationOnce(() => {
        order.push("B started");
        return b.promise;
      });
    const first = readThemeForRequest(dir, "mine");
    const firstResult = Promise.allSettled([first]);
    const second = readThemeForRequest(dir, "mine");
    const third = readThemeForRequest(dir, "mine");
    try {
      expect(second).not.toBe(first);
      expect(third).toBe(second);
      await Promise.resolve();
      expect(read).toHaveBeenCalledExactlyOnceWith(dir, "mine");
      expect(order).toEqual(["A started"]);
      if (outcome === "fulfilled") a.resolve(null);
      else a.reject(failure);
      expect(await firstResult).toEqual([
        outcome === "fulfilled" ? { status: "fulfilled", value: null } : { status: "rejected", reason: failure },
      ]);
      expect(order).toEqual(["A started", "A settled", "B started"]);
      expect(read).toHaveBeenCalledTimes(2);
      b.resolve(refused);
      expect(await Promise.all([second, third])).toEqual([refused, refused]);
      expect(await readThemeForRequest(dir, "mine")).toMatchObject({ name: "mine", valid: true });
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      a.resolve(null);
      b.resolve(refused);
      await Promise.allSettled([first, second, third]);
    }
  },
);

test("a promoted queued read queues later callers instead of returning its result", async () => {
  const a = Promise.withResolvers<ThemeEntry | null>();
  const b = Promise.withResolvers<ThemeEntry | null>();
  const read = vi.spyOn(themes, "readTheme").mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const first = readThemeForRequest(dir, "mine");
  const second = readThemeForRequest(dir, "mine");
  let later: Promise<ThemeEntry | null> | undefined;
  try {
    a.resolve(null);
    expect(await first).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    later = readThemeForRequest(dir, "mine");
    expect(later).not.toBe(second);
    expect(readThemeForRequest(dir, "mine")).toBe(later);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    b.resolve(refused);
    expect(await second).toEqual(refused);
    expect(await later).toMatchObject({ name: "mine", valid: true });
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    a.resolve(null);
    b.resolve(refused);
    await Promise.allSettled([first, second, later]);
  }
});

test("pending reads are isolated by folder and theme name", async () => {
  const listPending = Promise.withResolvers<ThemeList>();
  const filePending = Promise.withResolvers<ThemeEntry | null>();
  const list = vi.spyOn(themes, "listThemes").mockReturnValueOnce(listPending.promise);
  const read = vi.spyOn(themes, "readTheme").mockReturnValueOnce(filePending.promise);
  const firstList = listThemesForRequest(dir);
  const firstFile = readThemeForRequest(dir, "mine");
  try {
    expect(await listThemesForRequest(join(root, "other"))).toEqual({ themes: [], folderError: false });
    expect(await readThemeForRequest(dir, "other")).toBeNull();
    expect(await readThemeForRequest(join(root, "other"), "mine")).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    listPending.resolve({ themes: [], folderError: false });
    filePending.resolve(null);
    await Promise.all([firstList, firstFile]);
  }
});
