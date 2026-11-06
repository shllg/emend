import { expect, test, vi } from "vitest";
import { LIMITS, RenderedBlock, RenderedWriteup, RevisionView } from "./index.ts";

// Exercise exact UTF-8 and serialized-budget boundaries without allocating 256 MiB per assertion.
vi.mock("./limits.ts", async (original) => {
  const actual = await original<typeof import("./limits.ts")>();
  return { LIMITS: { ...actual.LIMITS, renderedBytesPerRevision: 1024, blocksPerRevision: 4 } };
});
const block = { id: "overview-12345678", section: "overview", kind: "paragraph", html: "", text: "" };
const section = { key: "overview", label: "Overview", topic: null, blocks: [block] };
const revision = {
  seq: 1,
  base: null,
  head: null,
  main: null,
  writeupEmpty: false,
  topics: [],
  files: [],
  writeup: { sections: [] },
  docs: [],
  threads: [],
  changedBlocks: [],
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test.each(["html", "text", "source"] as const)("rendered %s uses the renderer's UTF-8 byte cap", (field) => {
  for (const text of ["x".repeat(LIMITS.renderedBytesPerRevision), "é".repeat(LIMITS.renderedBytesPerRevision / 2)]) {
    expect(RenderedBlock.shape[field].safeParse(text).success).toBe(true);
    expect(RenderedBlock.shape[field].safeParse(`${text}x`).success).toBe(false);
  }
});
test("the exact serialized writeup budget parses, including JSON escapes", () => {
  const padded = { ...block, text: '"\né' };
  const writeup = { sections: [{ ...section, blocks: [padded] }] };
  padded.html = "x".repeat(LIMITS.renderedBytesPerRevision - bytes(writeup));
  expect(bytes(writeup)).toBe(LIMITS.renderedBytesPerRevision);
  expect(RenderedWriteup.safeParse(writeup).success).toBe(true);
  padded.html += "x";
  expect(RenderedWriteup.safeParse(writeup).success).toBe(false);
});
test("writeup and docs share the render budget; unrendered empty doc arrays add no stored bytes", () => {
  const padded = { ...block };
  const view = {
    ...revision,
    docs: [
      { path: "a.md", kind: "markdown", blocks: [padded] },
      { path: "unrendered.md", kind: "markdown", blocks: [] },
    ],
  };
  padded.html = "x".repeat(LIMITS.renderedBytesPerRevision - bytes(view.writeup) - bytes([padded]));
  expect(RevisionView.safeParse(view).success).toBe(true);
  padded.html += "x";
  expect(RevisionView.safeParse(view).success).toBe(false);
});
test("rendered block counts are shared across writeup sections and docs", () => {
  const writeup = {
    sections: [
      { ...section, blocks: [block, block] },
      { ...section, blocks: [block, block] },
    ],
  };
  expect(RenderedWriteup.safeParse(writeup).success).toBe(true);
  expect(RenderedWriteup.safeParse({ sections: [...writeup.sections, section] }).success).toBe(false);
  expect(RevisionView.safeParse({ ...revision, writeup }).success).toBe(true);
  expect(
    RevisionView.safeParse({ ...revision, writeup, docs: [{ path: "a.md", kind: "markdown", blocks: [block] }] })
      .success,
  ).toBe(false);
});

test("source tokens share the serialized revision budget, including colors and escaping", () => {
  const content = { language: "text", lines: [[{ text: '"\né', light: "#abc", dark: "#123456" }]] };
  const token = content.lines[0]?.[0];
  if (!token) throw new Error("missing token");
  token.text += "x".repeat(LIMITS.renderedBytesPerRevision - bytes(revision.writeup) - bytes(content));
  const view = {
    ...revision,
    docs: [
      { path: "a.txt", kind: "source", ...content },
      { path: "b.txt", kind: "source", language: "text", lines: [] },
    ],
  };
  expect(RevisionView.safeParse(view).success).toBe(true);
  token.text += "x";
  expect(RevisionView.safeParse(view).success).toBe(false);
});
