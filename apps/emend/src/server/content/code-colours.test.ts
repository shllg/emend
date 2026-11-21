import * as core from "@emend/core";
import { afterEach, expect, test, vi } from "vitest";
import { CODE_COLOURS_CACHE_LIMIT, cachedCodeColours } from "./code-colours.ts";

afterEach(() => vi.restoreAllMocks());

const html = '<pre><code class="language-ts">const seed = 1;</code></pre>';

test("the same key shares one computation and promise before and after completion", async () => {
  const pending = Promise.withResolvers<core.HtmlCodeColour[]>();
  const compute = vi.spyOn(core, "htmlCodeColours").mockReturnValue(pending.promise);
  const first = cachedCodeColours("shared", html);
  expect(cachedCodeColours("shared", html)).toBe(first);
  expect(first).toBe(pending.promise);
  expect(compute).toHaveBeenCalledExactlyOnceWith(html);
  const colours: core.HtmlCodeColour[] = [{ start: 31, end: 46, markup: "coloured" }];
  pending.resolve(colours);
  expect(await first).toBe(colours);
  expect(cachedCodeColours("shared", html)).toBe(first);
  expect(compute).toHaveBeenCalledTimes(1);
});

test("a hit moves to newest and keeps the entry when the cache fills", () => {
  const compute = vi.spyOn(core, "htmlCodeColours").mockResolvedValue([]);
  const entries = Array.from({ length: CODE_COLOURS_CACHE_LIMIT }, (_, index) =>
    cachedCodeColours(`hit:${index}`, html),
  );
  expect(cachedCodeColours("hit:0", html)).toBe(entries[0]);
  cachedCodeColours(`hit:${CODE_COLOURS_CACHE_LIMIT}`, html);
  expect(cachedCodeColours("hit:0", html)).toBe(entries[0]);
  expect(compute).toHaveBeenCalledTimes(CODE_COLOURS_CACHE_LIMIT + 1);
  expect(cachedCodeColours("hit:1", html)).not.toBe(entries[1]);
  expect(compute).toHaveBeenCalledTimes(CODE_COLOURS_CACHE_LIMIT + 2);
});

test("the seventeenth distinct key evicts the least recently used entry", () => {
  const compute = vi.spyOn(core, "htmlCodeColours").mockResolvedValue([]);
  expect(CODE_COLOURS_CACHE_LIMIT).toBe(16);
  const entries = Array.from({ length: CODE_COLOURS_CACHE_LIMIT + 1 }, (_, index) =>
    cachedCodeColours(`evict:${index}`, html),
  );
  expect(compute).toHaveBeenCalledTimes(CODE_COLOURS_CACHE_LIMIT + 1);
  expect(cachedCodeColours("evict:1", html)).toBe(entries[1]);
  expect(compute).toHaveBeenCalledTimes(CODE_COLOURS_CACHE_LIMIT + 1);
  expect(cachedCodeColours("evict:0", html)).not.toBe(entries[0]);
  expect(compute).toHaveBeenCalledTimes(CODE_COLOURS_CACHE_LIMIT + 2);
});
