import { DatabaseSync } from "node:sqlite";
import { ErrorBody, LIMITS, MachineRegistered, PairingCreated, PublishResponse, RevisionView } from "@emend/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { snapshot } from "../../cli/attach/bundle.ts";
import { agentNotes, files, revisions } from "../../db/schema.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
const note = {
  side: "new",
  start: 1,
  end: 2,
  summary: "<script>alert(1)</script>",
  rationale: "<img src=x onerror=alert(1)>",
  ref: "A",
};
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
async function input() {
  const newBlob = await f.deps.blobs.put(f.ownerId, Buffer.from("same\nline\nchanged\n"), "text/plain");
  const oldBlob = await f.deps.blobs.put(f.ownerId, Buffer.from("same\nline\nbefore\n"), "text/plain");
  return {
    reviewKey: "b".repeat(64),
    repo: null,
    branch: null,
    title: "Synthetic",
    base: null,
    head: null,
    topics: [],
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    files: [
      { path: "src/a.ts", role: "diff", oldPath: null, oldBlob, newBlob, flag: null, notes: [note] },
      { path: "src/b.ts", role: "diff", oldPath: null, oldBlob, newBlob, flag: null },
    ],
  };
}
async function publish(body: unknown) {
  const response = await f.request("/publish", "POST", body, "agent");
  expect(response.status).toBe(200);
  return PublishResponse.parse(await response.json());
}
async function view(fixture: typeof f, id: string, seq = 1) {
  const response = await fixture.request(`/reviews/${id}/revisions/${seq}`, "GET");
  expect(response.status).toBe(200);
  return RevisionView.parse(await response.json());
}
test("notes survive publish, revision view, export and import as immutable plain text", async () => {
  const body = await input();
  const published = await publish(body);
  const first = await view(f, published.reviewId);
  expect(first.files[0]?.notes).toEqual([{ ...note, id: expect.any(String) }]);
  expect(first.files[1]).not.toHaveProperty("notes");
  const firstFile = first.files[0];
  if (!firstFile) throw new Error("Missing file");
  const id = firstFile.notes?.[0]?.id;
  await publish({
    ...body,
    files: body.files.map((file) => ({ ...file, notes: [{ ...note, ref: undefined, summary: "Next revision" }] })),
  });
  expect((await view(f, published.reviewId)).files[0]?.notes?.[0]).toEqual({ ...note, id });
  expect((await view(f, published.reviewId, 2)).files[0]?.notes?.[0]?.id).not.toBe(id);
  await error(
    await f.request(`/reviews/${published.reviewId}/revisions/1`, "GET", undefined, "foreign"),
    404,
    "unknown_review",
  );
  await expect(
    f.db.query((q) =>
      q.insert(agentNotes).values({
        ownerId: f.otherOwnerId,
        fileId: firstFile.id,
        side: "new",
        startLine: 1,
        endLine: 1,
        summary: "Foreign",
        ord: 0,
      }),
    ),
  ).rejects.toThrow();
  const exported = await f.db.transaction((q) =>
    snapshot(q, f.ownerId, f.instanceId, published.reviewId, "https://example.test", f.deps.now()),
  );
  if (exported.kind !== "bundle") throw new Error("Missing export");
  expect(exported.bundle.agentNotes?.find((n) => n.id === id)).toMatchObject(note);
  const hub = await mailboxFixture();
  try {
    const pairing = PairingCreated.parse(await (await hub.request("/pairings", "POST", { purpose: "machine" })).json());
    const machine = MachineRegistered.parse(
      await (
        await hub.request("/machines", "POST", {
          secret: new URL(pairing.url).hash.slice(1),
          instance: { id: f.instanceId, name: "Synthetic source" },
        })
      ).json(),
    );
    const bundle = exported.bundle;
    for (const hash of new Set([
      ...bundle.files.flatMap((file) => [file.oldBlob, file.newBlob, file.renderedBlob]),
      ...bundle.writeups.flatMap((w) => [w.sourceBlob, w.renderedBlob]),
    ])) {
      if (!hash) continue;
      const bytes = await f.deps.blobs.get(f.ownerId, hash);
      if (!bytes) throw new Error("Missing source blob");
      await hub.deps.blobs.put(hub.ownerId, bytes, "text/plain");
    }
    const send = (body: unknown) =>
      hub.app.request("http://127.0.0.1:3636/api/v1/import", {
        method: "POST",
        headers: {
          Host: "127.0.0.1:3636",
          "Content-Type": "application/json",
          Authorization: `Bearer ${machine.token}`,
        },
        body: JSON.stringify(body),
      });
    const invalid = await send({ ...bundle, agentNotes: bundle.agentNotes?.map((n) => ({ ...n, end: 4 })) });
    expect(invalid.status).toBe(400);
    expect(ErrorBody.parse(await invalid.json()).error.message).toContain("Agent note 0 in src/a.ts");
    for (const status of ["renamed", "mode-changed"]) {
      const unchanged = await send({
        ...bundle,
        files: bundle.files.map((file) => ({
          ...file,
          oldBlob: file.newBlob,
          oldPath: status === "renamed" ? `old/${file.path}` : null,
          status,
        })),
      });
      expect(unchanged.status).toBe(400);
      expect(ErrorBody.parse(await unchanged.json()).error.message).toBe(
        "Agent note 0 in src/a.ts: the file's content does not change.",
      );
    }
    expect(await hub.db.read((q) => q.select().from(agentNotes).where(eq(agentNotes.ownerId, hub.ownerId)))).toEqual(
      [],
    );
    expect((await send(bundle)).status).toBe(201);
    expect((await view(hub, published.reviewId)).files[0]?.notes).toEqual(first.files[0]?.notes);
  } finally {
    await hub.cleanup();
  }
});

test("range errors identify the file and note index and leave no partial revision", async () => {
  const body = await input();
  const file = body.files[0];
  if (!file) throw new Error("Missing file");
  for (const patch of [
    { notes: [{ ...note, end: 4 }] },
    { notes: [{ ...note, start: 4, end: 4 }] },
    { oldBlob: null, notes: [{ ...note, side: "old" }] },
    { newBlob: null },
    { oldBlob: null, newBlob: null, flag: "binary" },
    { oldBlob: null, newBlob: null, flag: "oversized" },
    { newBlob: await f.deps.blobs.put(f.ownerId, Buffer.from(""), "text/plain") },
  ]) {
    const response = await f.request("/publish", "POST", { ...body, files: [{ ...file, ...patch }] }, "agent");
    expect(response.status).toBe(400);
    expect(ErrorBody.parse(await response.json()).error.message).toContain("Agent note 0 in src/a.ts");
  }
  expect(await f.db.read((q) => q.select().from(files).where(eq(files.ownerId, f.ownerId)))).toEqual([]);
  expect(await f.db.read((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)))).toHaveLength(1);
  // Lines before a distant change are valid; terminal newlines do not create a fourth line.
  const published = await publish(body);
  expect((await view(f, published.reviewId)).files[0]?.notes?.[0]).toMatchObject(note);
});

test("duplicate refs, limits and notes on docs are rejected by publish", async () => {
  const body = await input();
  const file = body.files[0];
  if (!file) throw new Error("Missing file");
  for (const changed of [
    [{ ...file, role: "doc", path: "doc.md", oldBlob: null }],
    [file, { ...file, path: "b.ts" }],
    [{ ...file, notes: Array.from({ length: 9 }, () => ({ ...note, ref: undefined })) }],
    Array.from({ length: 9 }, (_, i) => ({
      ...file,
      path: `file-${i}.ts`,
      notes: Array.from({ length: 8 }, () => ({ ...note, ref: undefined })),
    })),
  ])
    await error(await f.request("/publish", "POST", { ...body, files: changed }, "agent"), 400, "invalid_request");
  expect(await f.db.read((q) => q.select().from(agentNotes).where(eq(agentNotes.ownerId, f.ownerId)))).toEqual([]);
});

test.each(["renamed", "mode-changed"])("%s files need changed content to carry notes", async (status) => {
  const body = await input();
  const file = body.files[0];
  if (!file) throw new Error("Missing file");
  const changed = { ...file, status, oldPath: status === "renamed" ? "src/previous.ts" : null };
  const response = await f.request(
    "/publish",
    "POST",
    {
      ...body,
      files: [{ ...changed, oldBlob: changed.newBlob }],
    },
    "agent",
  );
  expect(response.status).toBe(400);
  expect(ErrorBody.parse(await response.json()).error.message).toBe(
    "Agent note 0 in src/a.ts: the file's content does not change.",
  );
  const published = await publish({ ...body, files: [changed] });
  // The note is on unchanged lines before the content change, including for a rename.
  expect((await view(f, published.reviewId)).files[0]?.notes?.[0]).toMatchObject(note);
});

test("note detail messages keep the index and reason within the error catalogue's limit", async () => {
  const body = await input();
  const file = body.files[0];
  if (!file) throw new Error("Missing file");
  const path = `${Array.from({ length: 10 }, () => "a".repeat(200)).join("/")}/end.ts`;
  const response = await f.request(
    "/publish",
    "POST",
    {
      ...body,
      files: [{ ...file, path, notes: [note, { ...note, ref: "B", end: 4 }] }],
    },
    "agent",
  );
  expect(response.status).toBe(400);
  const { error } = ErrorBody.parse(await response.json());
  expect(error.code).toBe("invalid_request");
  expect(error.message).toMatch(/^Agent note 1 in a/);
  expect(error.message).toContain("…");
  expect(error.message).toContain("/end.ts: the range must exist");
  expect(error.message.length).toBeLessThanOrEqual(LIMITS.errorMessageChars);
});

test.each(["view", "export"])(
  "%s probes notes by the selected revision files, not the owner's history",
  async (kind) => {
    const published = await publish(await input());
    const prepare = DatabaseSync.prototype.prepare;
    const plan: string[] = [];
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, query: string) {
      const statement = prepare.call(this, query);
      if (query.includes('from "agent_notes"')) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...params) => {
          plan.push(
            ...prepare
              .call(this, `EXPLAIN QUERY PLAN ${query}`)
              .all(...params)
              .map((row) => String(row.detail)),
          );
          return all(...params);
        });
      }
      return statement;
    });
    if (kind === "view") await view(f, published.reviewId);
    else
      await f.db.transaction((q) =>
        snapshot(q, f.ownerId, f.instanceId, published.reviewId, "https://example.test", f.deps.now()),
      );
    expect(plan.join("\n")).toContain("agent_notes_owner_file_ord_unique (owner_id=? AND file_id=?)");
    expect(plan.join("\n")).toContain("files_owner_revision_id_unique (owner_id=? AND revision_id=?)");
    expect(plan.join("\n")).not.toMatch(/agent_notes_owner_idx|files_owner_idx|SCAN agent_notes/);
  },
);
