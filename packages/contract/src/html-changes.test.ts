import { expect, test } from "vitest";
import { HtmlDocChanges, LIMITS } from "./index.ts";

test("HTML changes accept empty and ordered sparse marks", () => {
  for (const value of [
    { parts: 0, marks: [] },
    { parts: 3, marks: [] },
    {
      parts: 3,
      marks: [
        { index: 0, revision: 2 },
        { index: 2, revision: 3 },
      ],
    },
  ])
    expect(HtmlDocChanges.parse(value)).toEqual(value);
});

test.each([
  { parts: 1, marks: [{ index: 1, revision: 2 }] },
  {
    parts: 2,
    marks: [
      { index: 1, revision: 2 },
      { index: 0, revision: 2 },
    ],
  },
  {
    parts: 2,
    marks: [
      { index: 0, revision: 2 },
      { index: 0, revision: 3 },
    ],
  },
  { parts: 2, marks: [{ index: -1, revision: 2 }] },
  { parts: 2, marks: [{ index: 0, revision: 0 }] },
  { parts: 2, marks: [{ index: 0, revision: 1.5 }] },
  { parts: LIMITS.htmlPartsPerDoc + 1, marks: [] },
  {
    parts: LIMITS.htmlPartsPerDoc,
    marks: Array.from({ length: LIMITS.htmlPartsPerDoc + 1 }, (_, index) => ({ index, revision: 2 })),
  },
])("HTML changes reject invalid counts, indexes and revisions (case %#)", (value) => {
  expect(HtmlDocChanges.safeParse(value).success).toBe(false);
});
