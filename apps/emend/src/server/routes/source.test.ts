import {
  isRenderedHtmlDoc,
  LIMITS,
  MachineRegistered,
  PairingCreated,
  PublishResponse,
  RevisionView,
  ThreadCreated,
} from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { snapshot } from "../../cli/attach/bundle.ts";
import { files, revisions } from "../../db/schema.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";
import { WorkTimeout } from "../publish/executor.ts";
import { executeWork } from "../publish/work.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
async function publish(entries: { path: string; text: string | Uint8Array; view?: "source" | "rendered" }[]) {
  const files = await Promise.all(
    entries.map(async ({ text, ...entry }) => ({
      ...entry,
      role: "doc",
      ...(isRenderedHtmlDoc({ ...entry, role: "doc" }) ? { assets: [] } : {}),
      oldPath: null,
      oldBlob: null,
      flag: null,
      newBlob: await f.deps.blobs.put(f.ownerId, Buffer.from(text), "text/plain"),
    })),
  );
  return f.request(
    "/publish",
    "POST",
    {
      reviewKey: "b".repeat(64),
      repo: null,
      branch: null,
      title: "Source",
      base: null,
      head: null,
      topics: [],
      writeup: { overview: "[source](sample.html)", tldr: "", decisions: null, topics: {} },
      files,
    },
    "agent",
  );
}
async function view(id: string, seq: number) {
  const response = await f.request(`/reviews/${id}/revisions/${seq}`, "GET");
  expect(response.status).toBe(200);
  return RevisionView.parse(await response.json());
}
it("publishes highlighted source and both views of Markdown", async () => {
  const response = await publish([
    { path: "sample.ts", text: "const a: number = 1;\r\n" },
    { path: "notes.md", text: "# Title *raw*" },
    { path: "notes.md", view: "source", text: "# Title *raw*" },
  ]);
  expect(response.status).toBe(200);
  const result = PublishResponse.parse(await response.json());
  const revision = await view(result.reviewId, 1);
  expect(revision.docs).toHaveLength(3);
  const source = revision.docs.find((doc) => doc.path === "sample.ts");
  expect(source).toMatchObject({ kind: "source", language: "ts", title: "sample.ts" });
  if (source?.kind !== "source") throw new Error("missing source");
  expect(source.lines).toHaveLength(1);
  expect(source.lines.flat().some((token) => token.light && token.dark)).toBe(true);
  const raw = revision.docs.find((doc) => doc.path === "notes.md" && doc.kind === "source");
  if (raw?.kind !== "source") throw new Error("missing raw Markdown");
  expect(
    raw.lines
      .flat()
      .map((t) => t.text)
      .join(""),
  ).toBe("# Title *raw*");
  expect(revision.files.filter((file) => file.path === "notes.md").map((file) => file.view)).toEqual([
    undefined,
    "source",
  ]);
});
it.each([new Uint8Array([255]), new Uint8Array([97, 0])])("refuses non-text stored bytes", async (text) => {
  const response = await publish([{ path: "sample.ts", text }]);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "The request is invalid." } });
});
it("never exposes source HTML through the content route or navigable doc links", async () => {
  const text = '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<a href="javascript:alert(1)">link</a>';
  const response = await publish([{ path: "sample.html", view: "source", text }]);
  expect(response.status).toBe(200);
  const result = PublishResponse.parse(await response.json());
  const revision = await view(result.reviewId, 1);
  const doc = revision.docs[0];
  if (doc?.kind !== "source") throw new Error("missing source HTML");
  expect(doc).not.toHaveProperty("contentUrl");
  expect(doc.lines.map((line) => line.map((token) => token.text).join("")).join("\n")).toBe(text);
  expect(
    revision.writeup.sections
      .flatMap((s) => s.blocks)
      .map((b) => b.html)
      .join(""),
  ).not.toContain("href=");
  const row = await f.db.read((q) =>
    q
      .select()
      .from(revisions)
      .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.reviewId, result.reviewId)))
      .get(),
  );
  const url = `/content/${row?.contentKey}${revision.files[0]?.id.replaceAll("-", "")}/sample.html`;
  expect((await f.app.request(`http://127.0.0.1:3636${url}`, { headers: { Host: "127.0.0.1:3636" } })).status).toBe(
    404,
  );
});
it.each([false, true])("carries source lines across insertion and deletion (BOM + CRLF: %s)", async (bomCrlf) => {
  const encode = (text: string) => (bomCrlf ? `\uFEFF${text.replaceAll("\n", "\r\n")}` : text);
  const first = PublishResponse.parse(
    await (await publish([{ path: "sample.ts", text: encode("before\nselected\nafter\n") }])).json(),
  );
  const target = {
    kind: "source-lines",
    path: "sample.ts",
    start: 2,
    end: 2,
    lines: ["selected"],
    before: ["before"],
    after: ["after"],
  };
  const response = await f.request(`/reviews/${first.reviewId}/threads`, "POST", {
    revision: 1,
    target,
    body: "Explain this line.",
  });
  expect(response.status).toBe(201);
  ThreadCreated.parse(await response.json());
  const invalid = await f.request(`/reviews/${first.reviewId}/threads`, "POST", {
    revision: 1,
    target: { ...target, path: "absent.ts" },
    body: "Invalid",
  });
  expect(invalid.status).toBe(400);
  expect((await publish([{ path: "sample.ts", text: encode("insert\nbefore\nselected\nafter\n") }])).status).toBe(200);
  expect((await view(first.reviewId, 2)).threads[0]?.placement).toEqual({
    status: "placed",
    location: { kind: "source-lines", path: "sample.ts", start: 3, end: 3 },
  });
  expect((await publish([{ path: "sample.ts", text: encode("insert\nbefore\nafter\n") }])).status).toBe(200);
  expect((await view(first.reviewId, 3)).threads[0]?.placement).toEqual({ status: "unplaced", reason: "lines-gone" });
});

it("export/import round-trips both doc views and a source-lines thread across revisions", async () => {
  const first = PublishResponse.parse(
    await (
      await publish([
        { path: "notes.md", text: "# Title\nselected\n" },
        { path: "notes.md", view: "source", text: "# Title\nselected\n" },
      ])
    ).json(),
  );
  const response = await f.request(`/reviews/${first.reviewId}/threads`, "POST", {
    revision: 1,
    target: {
      kind: "source-lines",
      path: "notes.md",
      start: 2,
      end: 2,
      lines: ["selected"],
      before: ["# Title"],
      after: [],
    },
    body: "Keep this line.",
  });
  expect(response.status).toBe(201);
  expect(
    (
      await publish([
        { path: "notes.md", text: "# Title\ninserted\nselected\n" },
        { path: "notes.md", view: "source", text: "# Title\ninserted\nselected\n" },
      ])
    ).status,
  ).toBe(200);
  const exported = await f.db.query((q) =>
    snapshot(q, f.ownerId, f.instanceId, first.reviewId, "https://hub.example", Date.now(), false),
  );
  if (exported.kind !== "bundle") throw new Error("missing export");
  expect(exported.bundle.files.map((row) => row.view)).toEqual([undefined, "source", undefined, "source"]);
  const hub = await mailboxFixture();
  try {
    const paired = PairingCreated.parse(await (await hub.request("/pairings", "POST", { purpose: "machine" })).json());
    const machine = MachineRegistered.parse(
      await (
        await hub.request("/machines", "POST", {
          secret: new URL(paired.url).hash.slice(1),
          instance: { id: f.instanceId, name: "Synthetic source" },
        })
      ).json(),
    );
    const hashes = new Set([
      ...exported.bundle.files.flatMap((row) => [row.oldBlob, row.newBlob, row.renderedBlob]),
      ...exported.bundle.writeups.flatMap((row) => [row.sourceBlob, row.renderedBlob]),
    ]);
    for (const hash of hashes)
      if (hash) {
        const bytes = await f.deps.blobs.get(f.ownerId, hash);
        if (!bytes) throw new Error("missing blob");
        await hub.deps.blobs.put(hub.ownerId, bytes, "application/octet-stream");
      }
    const imported = await hub.app.request("http://127.0.0.1:3636/api/v1/import", {
      method: "POST",
      headers: { Host: "127.0.0.1:3636", Authorization: `Bearer ${machine.token}`, "Content-Type": "application/json" },
      body: exported.json,
    });
    expect(imported.status, await imported.text()).toBe(201);
    const revision = RevisionView.parse(
      await (await hub.request(`/reviews/${first.reviewId}/revisions/2`, "GET")).json(),
    );
    expect(revision.docs.map((doc) => doc.kind)).toEqual(["markdown", "source"]);
    expect(revision.files.map((file) => file.view)).toEqual([undefined, "source"]);
    expect(revision.threads[0]?.target.kind).toBe("source-lines");
    expect(revision.threads[0]?.placement).toEqual({
      status: "placed",
      location: { kind: "source-lines", path: "notes.md", start: 3, end: 3 },
    });
  } finally {
    await hub.cleanup();
  }
});

it.each(["failure", "timeout"])("a source render %s leaves a publishable, unrendered source doc", async (reason) => {
  f.deps.publishExecutor = async (work) => {
    if (work.kind === "source")
      throw reason === "timeout" ? new WorkTimeout() : new Error("Synthetic rendering failure");
    return executeWork(work);
  };
  const result = PublishResponse.parse(await (await publish([{ path: "sample.ts", text: "const n = 1;" }])).json());
  expect(result.unrendered).toEqual(["sample.ts"]);
  expect((await view(result.reviewId, 1)).docs).toEqual([
    { path: "sample.ts", kind: "source", title: "sample.ts", language: "text", lines: [], unrendered: true },
  ]);
});

it("refuses a source file above the Markdown byte limit before rendering", async () => {
  const response = await publish([
    { path: "sample.html", view: "source", text: "x".repeat(LIMITS.markdownDocBytes + 1) },
  ]);
  expect(response.status).toBe(413);
});

it("keeps HTML metadata and navigation when a source view of the same path comes first", async () => {
  const response = await publish([
    { path: "sample.html", view: "source", text: "<title>Raw title</title>" },
    { path: "sample.html", text: "<title>Rendered title</title><h2>Section</h2>" },
  ]);
  expect(response.status).toBe(200);
  const result = PublishResponse.parse(await response.json());
  const revision = await view(result.reviewId, 1);
  expect(revision.docs[0]).toMatchObject({ kind: "source", title: "sample.html" });
  expect(revision.docs[1]).toMatchObject({
    kind: "html",
    title: "Rendered title",
    headings: [{ level: 2, text: "Section" }],
  });
  expect(
    revision.writeup.sections
      .flatMap((s) => s.blocks)
      .map((b) => b.html)
      .join(""),
  ).toContain('href="?tab=docs&#x26;doc=sample.html"');
  expect(revision.files.map((file) => file.mediaType)).toEqual(["text/plain", "text/html"]);
});

it.each(["lines", "bytes"])(
  "source %s budget counts aliases per row and leaves empty docs rendered",
  async (budget) => {
    const text =
      budget === "lines" ? "\n".repeat(LIMITS.sourceLinesPerRevision / 2) : "é".repeat(LIMITS.markdownDocBytes / 2);
    const aliases = budget === "lines" ? 2 : LIMITS.sourceBytesPerRevision / LIMITS.markdownDocBytes;
    const execute = vi.fn(executeWork);
    f.deps.publishExecutor = execute;
    const response = await publish([
      ...Array.from({ length: aliases }, (_, i) => ({ path: `alias-${i}.txt`, text })),
      { path: "extra.txt", text: "x" },
      { path: "empty.txt", text: "" },
    ]);
    expect(response.status).toBe(200);
    const result = PublishResponse.parse(await response.json());
    expect(result.unrendered).toEqual(["extra.txt"]);
    expect(execute.mock.calls.filter(([work]) => work.kind === "source")).toHaveLength(2);
    const docs = (await view(result.reviewId, 1)).docs;
    for (const doc of docs.slice(0, aliases)) expect(doc).not.toHaveProperty("unrendered");
    expect(docs[aliases]).toEqual({
      path: "extra.txt",
      kind: "source",
      title: "extra.txt",
      language: "text",
      lines: [],
      unrendered: true,
    });
    expect(docs[aliases + 1]).toEqual({
      path: "empty.txt",
      kind: "source",
      title: "empty.txt",
      language: "text",
      lines: [],
    });
  },
);

it.each(["missing", "json", "schema", "extra fields"])(
  "source revision views validate stored content: %s",
  async (mode) => {
    const result = PublishResponse.parse(await (await publish([{ path: "sample.txt", text: "hello" }])).json());
    const data =
      mode === "json"
        ? "{"
        : JSON.stringify({
            language: "text",
            lines: [[{ text: "hello", ...(mode === "schema" ? { light: "red; color: red" } : {}) }]],
            path: "other.html",
            kind: "html",
            contentUrl: "https://example.test/",
            unrendered: true,
          });
    const blob = await f.deps.blobs.put(f.ownerId, Buffer.from(data), "application/json");
    if (mode === "missing") {
      const get = f.deps.blobs.get.bind(f.deps.blobs);
      vi.spyOn(f.deps.blobs, "get").mockImplementation(async (owner, hash, scope) =>
        hash === blob ? null : get(owner, hash, scope),
      );
    }
    await f.db.query((q) =>
      q
        .update(files)
        .set({ renderedBlob: blob })
        .where(and(eq(files.ownerId, f.ownerId), eq(files.path, "sample.txt"))),
    );
    const response = await f.request(`/reviews/${result.reviewId}/revisions/1`, "GET");
    expect(response.status).toBe(200);
    const raw = await response.json();
    expect(raw).toHaveProperty("docs", [
      {
        path: "sample.txt",
        kind: "source",
        title: "sample.txt",
        language: "text",
        lines: mode === "extra fields" ? [[{ text: "hello" }]] : [],
        ...(mode === "extra fields" ? {} : { unrendered: true }),
      },
    ]);
    RevisionView.parse(raw);
  },
);
