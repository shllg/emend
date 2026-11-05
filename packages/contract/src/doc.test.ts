import { expect, test } from "vitest";
import { HtmlDocPosition } from "./doc.ts";
import { LIMITS } from "./limits.ts";

test("HTML frame positions carry only a bounded heading index and fraction", () => {
  expect(HtmlDocPosition.parse({ heading: 0, fraction: 0 })).toEqual({ heading: 0, fraction: 0 });
  expect(HtmlDocPosition.safeParse({ heading: LIMITS.headingsPerDoc - 1, fraction: 1 }).success).toBe(true);
  for (const heading of [-1, 0.5, LIMITS.headingsPerDoc, NaN, Infinity, "0"])
    expect(HtmlDocPosition.safeParse({ heading, fraction: 0 }).success).toBe(false);
  for (const fraction of [-1, 2, NaN, Infinity, "0"])
    expect(HtmlDocPosition.safeParse({ heading: 0, fraction }).success).toBe(false);
  expect(HtmlDocPosition.safeParse({ heading: 0, fraction: 0, label: "Private label" }).success).toBe(false);
});

test("R1.3 the introduction is an explicit null heading, with zero fraction and no extra data", () => {
  expect(HtmlDocPosition.parse({ heading: null, fraction: 0 })).toEqual({ heading: null, fraction: 0 });
  for (const value of [
    { heading: null },
    { heading: null, fraction: 0.1 },
    { heading: null, fraction: 0, label: "Intro" },
  ])
    expect(HtmlDocPosition.safeParse(value).success).toBe(false);
});
