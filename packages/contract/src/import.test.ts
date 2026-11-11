import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { ImportBundle, importRowCount, MachineRegistration } from "./index.ts";

function bundle() {
  const reviewId = randomUUID(),
    revisionId = randomUUID(),
    threadId = randomUUID();
  const time = "2026-01-01T00:00:00.000Z";
  return {
    review: {
      id: reviewId,
      originInstanceId: randomUUID(),
      reviewKey: "a".repeat(64),
      repo: null,
      branch: null,
      title: "Synthetic",
      state: "open",
      approvedRevision: null,
      createdAt: time,
      updatedAt: time,
    },
    revisions: [
      { id: revisionId, reviewId, seq: 1, base: null, head: null, main: null, writeupEmpty: true, createdAt: time },
    ],
    topics: [],
    files: [],
    docAssets: [],
    changedBlocks: [],
    sends: [],
    deliveries: [],
    writeups: [{ id: randomUUID(), revisionId, sourceBlob: "b".repeat(64), renderedBlob: "c".repeat(64) }],
    threads: [
      {
        id: threadId,
        reviewId,
        target: { kind: "review" },
        state: "open",
        createdRevisionId: revisionId,
        createdAt: time,
        updatedAt: time,
      },
    ],
    placements: [
      { reviewId, threadId, revisionId, status: "placed", location: { kind: "review" }, reason: null, carried: null },
    ],
    comments: [
      {
        id: randomUUID(),
        reviewId,
        threadId,
        author: "user",
        body: "Synthetic feedback",
        outcome: null,
        sendId: null,
        createdAt: time,
        updatedAt: time,
      },
    ],
  };
}
test("machine registration uses exactly one normalized credential and a bounded UUID identity", () => {
  const instance = { id: randomUUID(), name: "Synthetic" };
  expect(MachineRegistration.parse({ instance, code: "oIl0-abcd" })).toEqual({ instance, code: "0110ABCD" });
  for (const input of [
    { instance },
    { instance, code: "00000000", secret: `emp_${"A".repeat(43)}` },
    { instance: { ...instance, id: "bad" }, code: "00000000" },
    { instance: { ...instance, name: "" }, code: "00000000" },
    { instance: { ...instance, name: "x".repeat(201) }, code: "00000000" },
  ])
    expect(MachineRegistration.safeParse(input).success).toBe(false);
});
test("bundle strips authority and capability fields while preserving row identity", () => {
  const input = bundle();
  const result = ImportBundle.parse({
    ...input,
    review: { ...input.review, ownerId: randomUUID(), movedTo: "https://hub.example" },
    revisions: input.revisions.map((r) => ({ ...r, contentKey: "A".repeat(43) })),
  });
  const { placements: _placements, changedBlocks: _changedBlocks, ...expected } = input;
  expect(result).toEqual(expected);
});

test("bundle project is optional, nullable and bounded without adding import rows", () => {
  const input = ImportBundle.parse(bundle());
  expect(input.review).not.toHaveProperty("project");
  for (const project of [null, "Orchard", "x".repeat(200)]) {
    const parsed = ImportBundle.parse({ ...input, review: { ...input.review, project } });
    expect(parsed.review.project).toBe(project);
    expect(importRowCount(parsed)).toBe(importRowCount(input));
  }
  for (const project of ["", "x".repeat(201)])
    expect(ImportBundle.safeParse({ ...input, review: { ...input.review, project } }).success).toBe(false);
});

test("import strips heading declarations while preserving a doc title", () => {
  const input = bundle();
  const file = {
    id: randomUUID(),
    revisionId: input.revisions[0]?.id,
    path: "doc.md",
    oldPath: null,
    role: "doc",
    status: null,
    topicSlug: null,
    ord: 0,
    oldBlob: null,
    newBlob: "a".repeat(64),
    renderedBlob: null,
    title: "Named",
    headings: [{ level: 2, text: "Forged", id: "thread-foreign" }],
    flag: null,
    parentDocId: null,
  };
  const result = ImportBundle.parse({ ...input, files: [file] });
  expect(result.files[0]).not.toHaveProperty("headings");
  expect(result.files[0]?.title).toBe("Named");
});
test("imported notes keep ids and order, count as rows and reject foreign files, duplicate refs and ordinals", () => {
  const input = bundle();
  const file = {
    id: randomUUID(),
    revisionId: input.revisions[0]?.id,
    path: "a.ts",
    oldPath: null,
    role: "diff",
    status: "added",
    topicSlug: null,
    ord: 0,
    oldBlob: null,
    newBlob: "a".repeat(64),
    renderedBlob: null,
    flag: null,
    parentDocId: null,
  };
  const note = {
    id: randomUUID(),
    fileId: file.id,
    ord: 0,
    side: "new",
    start: 1,
    end: 1,
    summary: "Decision",
    ref: "A",
  };
  const plain = ImportBundle.parse({ ...input, files: [file] });
  const withNotes = { ...plain, agentNotes: [note] };
  expect(ImportBundle.parse(withNotes).agentNotes).toEqual([note]);
  expect(importRowCount(ImportBundle.parse(withNotes))).toBe(importRowCount(plain) + 1);
  for (const changed of [
    { agentNotes: [{ ...note, fileId: randomUUID() }] },
    { agentNotes: [{ ...note, id: file.id }] },
    { agentNotes: [note, { ...note, id: randomUUID(), ord: 1 }] },
    { agentNotes: [note, { ...note, id: randomUUID(), ref: "B" }] },
    { files: [{ ...file, role: "doc" }] },
    { agentNotes: Array.from({ length: 9 }, (_, i) => ({ ...note, id: randomUUID(), ord: i, ref: undefined })) },
  ])
    expect(ImportBundle.safeParse({ ...withNotes, ...changed }).success).toBe(false);
});
test.each(["duplicate id", "invalid id", "comment reference", "revision reference", "approval reference", "body"])(
  "bundle refuses %s",
  (kind) => {
    const input = bundle();
    const comment = input.comments[0],
      thread = input.threads[0];
    if (!comment || !thread) throw new Error("Missing fixture row");
    if (kind === "duplicate id") comment.id = thread.id;
    if (kind === "invalid id") Object.assign(comment, { id: "bad" });
    if (kind === "comment reference") comment.threadId = randomUUID();
    if (kind === "revision reference") thread.createdRevisionId = randomUUID();
    if (kind === "approval reference")
      Object.assign(input.review, { state: "approved", approvedRevision: randomUUID() });
    if (kind === "body") comment.body = "\ud800";
    expect(ImportBundle.safeParse(input).success).toBe(false);
  },
);

test.each(["Synthetic\nname", "Synthetic\u202ename", "Synthetic\u200dname"])(
  "refuses controls and format characters in machine name %j",
  (name) => {
    expect(MachineRegistration.safeParse({ instance: { id: randomUUID(), name }, code: "00000000" }).success).toBe(
      false,
    );
  },
);

test.each(["Synthetic\u2028name", " ", "\u3164", `a${"\u0301".repeat(199)}`])(
  "fix2: rejects machine names outside the browser allowlist (%j)",
  (name) => {
    expect(MachineRegistration.safeParse({ instance: { id: randomUUID(), name }, code: "00000000" }).success).toBe(
      false,
    );
  },
);
test("fix2: trims valid machine names", () => {
  expect(
    MachineRegistration.parse({ instance: { id: randomUUID(), name: "  Laptop (work)/1;._-  " }, code: "00000000" })
      .instance.name,
  ).toBe("Laptop (work)/1;._-");
});

test("import row counts are pure and count creation through latest", () => {
  const input = ImportBundle.parse(bundle());
  expect(importRowCount(input)).toBe(6);
  const revision = input.revisions[0],
    writeup = input.writeups[0],
    thread = input.threads[0];
  if (!revision || !writeup || !thread) throw new Error("Missing fixture row");
  const next = randomUUID();
  input.revisions.push({ ...revision, id: next, seq: 2 });
  input.writeups.push({ ...writeup, id: randomUUID(), revisionId: next });
  thread.target = { kind: "file", path: "界/a.md" };
  const before = structuredClone(input);
  expect(importRowCount(input)).toBe(9);
  expect(input).toEqual(before);
  thread.createdRevisionId = next;
  expect(importRowCount(input)).toBe(8);
});
