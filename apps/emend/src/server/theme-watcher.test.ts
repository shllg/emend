import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ReviewEvents } from "./events.ts";
import { watchThemes } from "./theme-watcher.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));

let root: string;
let dir: string;
let events: ReviewEvents;
let stop: () => void;
let tick: () => Promise<void>;
let timer: ReturnType<typeof setInterval>;
let clock: Pick<typeof globalThis, "setInterval" | "clearInterval">;
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "emend-theme-watcher-"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("EMEND_HOME", join(root, "state"));
  dir = join(root, "config", "emend", "themes");
  events = new ReviewEvents(() => 0);
  clock = { setInterval, clearInterval };
  tick = async () => {};
  vi.spyOn(clock, "setInterval").mockImplementation((callback) => {
    tick = async () => {
      await callback();
    };
    timer = setInterval(() => {}, 60_000);
    return timer;
  });
  vi.spyOn(clock, "clearInterval");
  stop = () => {};
});
afterEach(async () => {
  stop();
  for (const reader of readers.splice(0)) await reader.cancel();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function stream(owner: string, review: string | null = null) {
  const reader = events.stream(owner, review, "session").getReader();
  readers.push(reader);
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
  return reader;
}
const seed = async (content = "{}") => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "mine.json"), content);
};
const start = async () => {
  stop = await watchThemes(dir, events, { intervalMs: 17, clock });
};

test("each file change emits once to every owner's global stream, never a review stream", async () => {
  const broadcast = vi.spyOn(events, "broadcast");
  await start();
  const first = await stream("first");
  const second = await stream("second");
  const review = await stream("first", "review");
  expect(events.streamCount).toBe(3);
  expect(clock.setInterval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 17);
  expect(timer.hasRef()).toBe(false);
  await tick(); // The missing-folder baseline already exists; nothing changed.
  expect(broadcast).not.toHaveBeenCalled();
  const reviewRead = vi.fn();
  const pending = review.read().then(reviewRead);
  for (const content of ["{}", '{"version":1}']) {
    await seed(content);
    await tick();
    for (const reader of [first, second])
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: themes\ndata: {}\n\n");
    await tick();
  }
  expect(broadcast).toHaveBeenCalledTimes(2);
  expect(reviewRead).not.toHaveBeenCalled();
  await review.cancel();
  await pending;
  expect(reviewRead).toHaveBeenCalledWith({ value: undefined, done: true });
});

test("a save immediately after start emits once at the first tick", async () => {
  const broadcast = vi.spyOn(events, "broadcast");
  await seed();
  await start();
  expect(clock.setInterval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 17);
  expect(timer.hasRef()).toBe(false);
  expect(broadcast).not.toHaveBeenCalled();
  const reader = await stream("owner");
  await seed("saved before the first tick since opening");
  await tick();
  expect(broadcast).toHaveBeenCalledExactlyOnceWith({ type: "themes" });
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: themes\ndata: {}\n\n");
  await tick();
  expect(broadcast).toHaveBeenCalledTimes(1);
  await reader.cancel();
  expect(events.streamCount).toBe(0);
  expect(clock.clearInterval).not.toHaveBeenCalled();
  await seed("changed while closed");
  await tick();
  expect(broadcast).toHaveBeenCalledTimes(2);
  await stream("owner");
  await seed("saved immediately after reopening");
  await tick();
  expect(broadcast).toHaveBeenCalledTimes(3);
  stop();
  expect(clock.clearInterval).toHaveBeenCalledWith(timer);
  await seed("changed after stop");
  await tick();
  expect(broadcast).toHaveBeenCalledTimes(3);
});

test("linked files, deletion and folder disappearance change the fingerprint", async () => {
  await seed();
  const target = join(root, "target.json");
  await writeFile(target, "{}");
  await symlink(target, join(dir, "linked.json"));
  await start();
  await stream("owner");
  const broadcast = vi.spyOn(events, "broadcast");
  await tick();
  await writeFile(target, "changed target");
  await tick();
  await rm(join(dir, "mine.json"));
  await tick();
  await rm(dir, { recursive: true });
  await tick();
  await tick();
  expect(broadcast).toHaveBeenCalledTimes(3);
});

test("ticks never overlap and an in-flight result cannot outlive the watcher", async () => {
  await seed();
  await start();
  const reader = await stream("owner");
  await tick();
  const broadcast = vi.spyOn(events, "broadcast");
  const original = fs.stat;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const stat = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return Reflect.apply(original, undefined, args);
  });
  const pending = tick();
  try {
    await entered.promise;
    await seed("changed");
    await tick();
    expect(stat).toHaveBeenCalledTimes(1);
    stop();
    await reader.cancel();
  } finally {
    release.resolve();
    await pending;
  }
  await tick();
  expect(broadcast).not.toHaveBeenCalled();
});

test("no configured folder allocates no timer", async () => {
  stop();
  vi.mocked(clock.setInterval).mockClear();
  stop = await watchThemes(undefined, events, { clock });
  await stream("owner");
  expect(clock.setInterval).not.toHaveBeenCalled();
});

test("fingerprints only the sorted, displayable 50 files the list shows", async () => {
  await seed();
  for (let i = 0; i < 50; i++) await writeFile(join(dir, `theme-${String(i).padStart(2, "0")}.json`), "");
  await start();
  await stream("owner");
  const broadcast = vi.spyOn(events, "broadcast");
  await tick();
  await writeFile(join(dir, "theme-49.json"), "not listed");
  await writeFile(join(dir, "bad\nname.json"), "not displayable");
  await writeFile(join(dir, ".hidden.json"), "hidden");
  await tick();
  expect(broadcast).not.toHaveBeenCalled();
  await writeFile(join(dir, "theme-48.json"), "listed");
  await tick();
  expect(broadcast).toHaveBeenCalledExactlyOnceWith({ type: "themes" });
});

test("a too-full folder has a stable fingerprint and returning to 1000 entries emits once", async () => {
  await seed();
  for (let i = 0; i < 999; i++) await writeFile(join(dir, `.ignored-${i}`), "");
  await start();
  await stream("owner");
  const broadcast = vi.spyOn(events, "broadcast");
  await tick();
  await writeFile(join(dir, "overflow"), "");
  await tick();
  expect(broadcast).toHaveBeenCalledTimes(1);
  await seed("changed while too full");
  await tick();
  expect(broadcast).toHaveBeenCalledTimes(1);
  await rm(join(dir, "overflow"));
  await tick();
  await tick();
  expect(broadcast).toHaveBeenCalledTimes(2);
});
