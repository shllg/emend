import { LIMITS } from "@emend/contract";
import { expect, test } from "vitest";
import { headingLookups } from "./heading-lookups.ts";

const headings = (texts: string[]) => texts.map((text, i) => ({ level: 2 as const, text, id: `heading-${i}` }));
test.each([
  ["Setup 2", "heading-1", "heading-1", "heading-2"],
  ["Setup 1", "heading-2", "heading-1", "heading-2"],
])("repeat kinds and priority: %s", (last, one, two, lastId) => {
  const names = headingLookups(headings(["Setup", "Setup", last]));
  expect(names.get("setup")).toBe("heading-0");
  expect(names.get("setup-1")).toBe(one);
  expect(names.get("setup-2")).toBe(two);
  expect(names.get(last === "Setup 1" ? "setup-1-1" : "setup-2-1")).toBe(last === "Setup 1" ? lastId : undefined);
});
test("author names win across all headings; prototype keys are ordinary names", () => {
  const names = headingLookups([
    ...headings(["x", "constructor", "__proto__"]),
    { level: 3, text: "Other", id: "user-content-x" },
  ]);
  expect(names.get("x")).toBe("user-content-x");
  expect(names.get("constructor")).toBe("heading-1");
  expect(names.get("__proto__")).toBe("heading-2");
  expect(names.has("user-content-x")).toBe(false);
  expect(names.has("heading-0")).toBe(false);
});
test.each(["What's new?", "K", "İ", "\u200b\u202e", "中文", "Café", "a  b", "-__-"])(
  "reference names for %s",
  (text) => {
    const hunk = String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "");
    const github = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\-_ ]/gu, "")
      .replace(/ /g, "-");
    expect([...headingLookups(headings([text])).keys()]).toEqual([...new Set([hunk, github].filter(Boolean))]);
  },
);
test("empty names, long names, normalization and count caps", () => {
  const names = headingLookups(headings(["", "", "a".repeat(LIMITS.headingIdChars + 1), "Café", "What's new?"]));
  expect(names.has("")).toBe(false);
  expect(names.has("a".repeat(LIMITS.headingIdChars + 1))).toBe(false);
  expect(names.has("cafe\u0301")).toBe(false);
  expect(names.has("café\u200b")).toBe(false);
  expect(names.get("whats-new")).toBe("heading-4");
  expect(headingLookups(headings(Array(50_000).fill("a"))).size).toBeLessThanOrEqual(3 * LIMITS.headingsPerDoc);
});
test("collision chains resume their counters", () => {
  const names = headingLookups(headings(["a", "a", "a-2", "a", "a-2"]));
  expect(names.get("a-2")).toBe("heading-1");
  expect(names.get("a-2-2")).toBe("heading-2");
  expect(names.get("a-2-3")).toBe("heading-4");
  expect(names.get("a-3")).toBe("heading-3");
});
