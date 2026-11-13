import { expect, test } from "vitest";
import { fuzzyMatch } from "./fuzzy-match.ts";

test("matches ordered letters with gaps and refuses missing or reversed letters", () => {
  expect(fuzzyMatch("nxtfl", "Next file")).not.toBeNull();
  expect(fuzzyMatch("xyz", "Next file")).toBeNull();
  expect(fuzzyMatch("tx", "Next file")).toBeNull();
  expect(fuzzyMatch("nn", "Next file")).toBeNull();
});

test("favors word starts and consecutive letters", () => {
  expect(fuzzyMatch("nf", "Next file")).toBeGreaterThan(fuzzyMatch("nf", "Switch the inbox filter") as number);
  expect(fuzzyMatch("snoo", "Snooze")).toBeGreaterThan(fuzzyMatch("snoo", "See new options only") as number);
  expect(fuzzyMatch("nf", "Next-file")).toBe(fuzzyMatch("nf", "Next file"));
});

test("matches every query word independently of word order", () => {
  expect(fuzzyMatch("tab files", "Files tab")).not.toBeNull();
  expect(fuzzyMatch("files tab", "Files tab")).toBe(fuzzyMatch("tab files", "Files tab"));
  expect(fuzzyMatch("files missing", "Files tab")).toBeNull();
  expect(fuzzyMatch("  files\t tab\n", "Files tab")).toBe(fuzzyMatch("files tab", "Files tab"));
});

test("ignores case and matches an empty query with zero", () => {
  expect(fuzzyMatch("NXTfl", "NEXT File")).toBe(fuzzyMatch("nxtfl", "Next file"));
  expect(fuzzyMatch("", "Next file")).toBe(0);
  expect(fuzzyMatch(" \t\n", "")).toBe(0);
  expect(fuzzyMatch("n", "")).toBeNull();
});

test("chooses the best alignment even after an earlier matching start or letter", () => {
  expect(fuzzyMatch("snoo", "s nothing Snooze")).toBeGreaterThan(fuzzyMatch("snoo", "s nothing only once") as number);
  expect(fuzzyMatch("abc", "a bxybc")).toBeGreaterThan(fuzzyMatch("abc", "a bxyxc") as number);
  expect(fuzzyMatch("files", "Files")).toBeGreaterThan(fuzzyMatch("files", "Open Files") as number);
});
