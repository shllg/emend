import { expect, test } from "vitest";
import { GlossaryForm, LIMITS, RevisionView } from "./index.ts";

const term = { term: "Budget", definition: "Attempts a worker may spend.", blockId: "doc-0a1b2c3d-0a1b2c3d" };
const doc = (terms: unknown) => [{ path: "a.md", kind: "markdown", blocks: [], terms }];

test("a Markdown doc may carry glossary terms, and omits them by default", () => {
  expect(RevisionView.shape.docs.safeParse(doc(undefined)).success).toBe(true);
  expect(RevisionView.shape.docs.safeParse(doc([term])).success).toBe(true);
});

test("doc terms stop at the glossary limit", () => {
  const many = (count: number) => Array.from({ length: count }, () => term);
  expect(RevisionView.shape.docs.safeParse(doc(many(LIMITS.glossaryTerms))).success).toBe(true);
  expect(RevisionView.shape.docs.safeParse(doc(many(LIMITS.glossaryTerms + 1))).success).toBe(false);
});

test("a doc term keeps the term, definition and block id bounds", () => {
  const parse = (value: unknown) => RevisionView.shape.docs.safeParse(doc([value])).success;
  expect(parse({ ...term, term: "" })).toBe(false);
  expect(parse({ ...term, term: "x".repeat(LIMITS.glossaryTermChars + 1) })).toBe(false);
  expect(parse({ ...term, definition: "x".repeat(LIMITS.glossaryDefinitionChars + 1) })).toBe(false);
  expect(parse({ ...term, blockId: "not a block id" })).toBe(false);
});

test("the exported glossary form applies the manifest's rules", () => {
  expect(GlossaryForm.safeParse("Budget").success).toBe(true);
  expect(GlossaryForm.safeParse("  ").success).toBe(false);
  expect(GlossaryForm.safeParse("a\nb").success).toBe(false);
  expect(GlossaryForm.safeParse("x".repeat(LIMITS.glossaryTermChars + 1)).success).toBe(false);
});
