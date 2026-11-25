import { expect, test } from "vitest";
import { AgentNote, AgentNoteView, PublishFile, PublishManifest, PublishRequest } from "./index.ts";

const note = { side: "new" as const, start: 1, end: 2, summary: "Keep the boundary.", ref: "A" };
const file = { path: "a.ts", role: "diff", notes: [note] };
const topic = { slug: "first", title: "First", importance: 1, summary: "Boundary" };
const manifest = {
  version: 1,
  title: "Synthetic",
  topics: [topic],
  files: [file],
  writeup: { overview: "", tldr: "", decisions: null, topics: {} },
};
const requestFile = { ...file, oldPath: null, oldBlob: null, newBlob: "a".repeat(64), flag: null };
const request = {
  ...manifest,
  reviewKey: "b".repeat(64),
  repo: null,
  branch: null,
  base: null,
  head: null,
  files: [requestFile],
};

test("notes preserve hostile text literally and view adds an id", () => {
  const hostile = { ...note, summary: "<script>alert(1)</script>", rationale: "<img src=x onerror=alert(1)>" };
  expect(AgentNote.parse(hostile)).toEqual(hostile);
  expect(AgentNoteView.parse({ ...hostile, id: "11111111-1111-4111-8111-111111111111" })).toMatchObject(hostile);
  expect(PublishManifest.parse(manifest).files[0]?.notes).toEqual([note]);
  expect(PublishRequest.parse(request).files[0]?.notes).toEqual([note]);
});
test("publish accepts a whole-line quote, a range, or both", () => {
  const { start, end, ...fields } = note;
  const quote = "  first line\nsecond line ";
  for (const placement of [{ start, end }, { quote }, { quote, start, end }]) {
    const input = { ...fields, ...placement };
    expect(AgentNote.parse(input)).toEqual(input);
  }
  for (const placement of [
    {},
    { start },
    { end },
    { quote, start },
    { quote, end },
    { quote: " \r\n\t" },
    { quote: "x".repeat(2001) },
  ])
    expect(AgentNote.safeParse({ ...fields, ...placement }).success).toBe(false);
  const view = { ...fields, id: "11111111-1111-4111-8111-111111111111" };
  for (const placement of [{ quote }, { quote, start }, { quote, end }])
    expect(AgentNoteView.safeParse({ ...view, ...placement }).success).toBe(false);
  expect(AgentNoteView.parse({ ...view, start, end, quote })).toEqual({ ...view, start, end });
});

test("only diff entries accept notes, even when empty", () => {
  for (const notes of [[], [note]]) {
    expect(PublishManifest.safeParse({ ...manifest, files: [{ ...file, role: "doc", notes }] }).success).toBe(false);
    for (const role of ["doc", "asset"])
      expect(PublishFile.safeParse({ ...requestFile, role, notes }).success).toBe(false);
  }
});
test("summary and a present rationale must not be blank; meaningful whitespace is preserved", () => {
  for (const field of ["summary", "rationale"] as const) {
    for (const blank of ["", " ", "\t", "\r\n", "\u00a0\u2003"]) {
      expect(AgentNote.safeParse({ ...note, [field]: blank }).success).toBe(false);
    }
  }
  const spaced = { ...note, summary: " Keep the boundary. ", rationale: "\n Explain the trade-off.\n" };
  expect(AgentNote.parse(spaced)).toEqual(spaced);
  expect(AgentNote.parse(note)).not.toHaveProperty("rationale");
});
test("refs are unique per topic across files, including Other changes", () => {
  for (const schema of [PublishManifest, PublishRequest]) {
    const base = schema === PublishManifest ? manifest : request;
    const files =
      schema === PublishManifest ? [file, { ...file, path: "b.ts" }] : [requestFile, { ...requestFile, path: "b.ts" }];
    expect(schema.safeParse({ ...base, files }).success).toBe(false);
    expect(
      schema.safeParse({ ...base, files: files.map((f, i) => ({ ...f, topic: i ? "first" : undefined })) }).success,
    ).toBe(true);
    expect(schema.safeParse({ ...base, files: [{ ...files[0], notes: [note, note] }] }).success).toBe(false);
  }
});
