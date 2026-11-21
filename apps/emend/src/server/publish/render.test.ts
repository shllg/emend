import { LIMITS, type PublishRequest } from "@emend/contract";
import {
  type Block,
  blockHash,
  HIGHLIGHT_SOURCE_BYTES,
  HIGHLIGHT_SOURCE_REVISION_BYTES,
  htmlPartHashes,
  parseDocHtml,
  renderMarkdown,
} from "@emend/core";
import { expect, test, vi } from "vitest";
import { WorkTimeout } from "./executor.ts";
import { PublishAborted } from "./lifecycle.ts";
import { chargeHtmlParts, type HtmlPartBudget, renderRevision } from "./render.ts";
import { type DocMetadata, executeWork, serializeRendered } from "./work.ts";

const input = (paths: string[]): PublishRequest => ({
  reviewKey: "a".repeat(64),
  repo: null,
  branch: null,
  title: "Synthetic",
  base: null,
  head: null,
  topics: [],
  writeup: { overview: "", tldr: "", decisions: null, topics: {} },
  files: paths.map((path) => ({
    path,
    role: "doc",
    oldPath: null,
    oldBlob: null,
    newBlob: "b".repeat(64),
    flag: null,
  })),
});

test("writeup work reports doc-base use without inspecting serialized HTML", async () => {
  const rendered = await executeWork({
    kind: "writeup",
    source: { overview: "[go](target.md)", tldr: "", decisions: null, topics: {} },
    topics: [],
    media: [],
    docs: new Map([["target.md", new Map()]]),
  });
  expect(rendered).toMatchObject({ kind: "writeup", pathDependent: true });
});

test("code colour work returns token spans and source offsets for a TypeScript block", async () => {
  const prefix = '<p>🌱</p><pre><code class="language-ts">';
  const text = 'const seed: string = "fern";';
  const result = await executeWork({
    kind: "code-colours",
    bytes: new TextEncoder().encode(`${prefix}${text}</code></pre>`).buffer,
  });
  expect(result).toEqual({
    kind: "code-colours",
    colours: [
      {
        start: prefix.length,
        end: prefix.length + text.length,
        markup: expect.stringContaining('<span style="color:var(--syn-keyword)">const</span>'),
      },
    ],
  });
});

test("HTML metadata shares parsing but full part IDs remain path-specific and separate from Markdown IDs", async () => {
  const source = "<h2>Seeds</h2><p>First</p><p>First</p>";
  const execute = vi.fn(executeWork);
  const result = await renderRevision(
    input(["one.html", "two.html"]),
    execute,
    async () => new TextEncoder().encode(source).buffer,
    async () => new ArrayBuffer(0),
    async () => "stored",
  );
  const hashes = await htmlPartHashes(parseDocHtml(source));
  const ids = result.ids.flatMap((bytes) => new TextDecoder().decode(bytes).split("\n"));
  expect(execute.mock.calls.filter(([work]) => work.kind === "doc-metadata")).toHaveLength(1);
  for (const path of ["one.html", "two.html"]) {
    expect(result.metadata.get(path)?.parts).toEqual(hashes);
    const prefix = `doc-${await blockHash(path)}-`;
    expect(result.htmlParts.get(path)).toEqual(hashes.map((hash) => `${prefix}${hash}`));
    expect(ids.some((id) => id.startsWith(prefix))).toBe(false);
  }
  expect(result.ids).toHaveLength(1);
});

test("HTML part charging releases cut and later cached parts while retaining charged parts", () => {
  const limit = LIMITS.htmlPartsPerRevision;
  const state = { count: limit - 2, exhausted: false, limit };
  const kept: DocMetadata = { headings: [], parts: ["aaaaaaaa"] };
  const stored = chargeHtmlParts([state], kept);
  expect(stored).toBe(kept.parts);
  expect(kept.parts).toEqual(["aaaaaaaa"]);
  expect(state.count).toBe(LIMITS.htmlPartsPerRevision - 1);
  const cut: DocMetadata = { title: "Cut doc", headings: [], parts: ["bbbbbbbb", "cccccccc"] };
  expect(chargeHtmlParts([state], cut)).toBeUndefined();
  expect(cut).toEqual({ title: "Cut doc", headings: [] });
  const later: DocMetadata = { headings: [], parts: ["dddddddd"] };
  expect(chargeHtmlParts([state], later)).toBeUndefined();
  expect(later).not.toHaveProperty("parts");
  expect(state).toEqual({ count: limit - 1, exhausted: true, limit });
  expect(kept.parts).toBe(stored);
});

test("HTML part charging counts cached aliases per path and preserves earlier stored parts", () => {
  const limit = LIMITS.htmlPartsPerRevision;
  const state = { count: limit - 4, exhausted: false, limit };
  const parts = ["aaaaaaaa", "bbbbbbbb"];
  const own: DocMetadata = { headings: [], parts };
  expect(chargeHtmlParts([state], own)).toBe(parts);
  expect(state).toEqual({ count: limit - 2, exhausted: false, limit });
  expect(chargeHtmlParts([state], own)).toBe(parts);
  expect(state).toEqual({ count: limit, exhausted: false, limit });
  expect(chargeHtmlParts([state], own)).toBeUndefined();
  expect(own).not.toHaveProperty("parts");
  expect(state).toEqual({ count: limit, exhausted: true, limit });
  expect(parts).toEqual(["aaaaaaaa", "bbbbbbbb"]);
});

test("HTML parts charge all fitting budgets and exhaust only budgets that overflow", () => {
  const revision = (): HtmlPartBudget => ({ count: 0, exhausted: false, limit: 2 });
  const imported: HtmlPartBudget = { count: 0, exhausted: false, limit: 4 };
  let current = revision();
  const kept: DocMetadata = { headings: [], parts: ["aaaaaaaa", "bbbbbbbb"] };
  expect(chargeHtmlParts([current, imported], kept)).toBe(kept.parts);
  expect(current).toEqual({ count: 2, exhausted: false, limit: 2 });
  expect(imported).toEqual({ count: 2, exhausted: false, limit: 4 });

  const revisionCut: DocMetadata = { headings: [], parts: ["cccccccc"] };
  expect(chargeHtmlParts([current, imported], revisionCut)).toBeUndefined();
  expect(revisionCut).not.toHaveProperty("parts");
  expect(current).toEqual({ count: 2, exhausted: true, limit: 2 });
  expect(imported).toEqual({ count: 2, exhausted: false, limit: 4 });

  current = revision();
  const resumed: DocMetadata = { headings: [], parts: ["dddddddd"] };
  expect(chargeHtmlParts([current, imported], resumed)).toBe(resumed.parts);
  expect(current).toEqual({ count: 1, exhausted: false, limit: 2 });
  expect(imported).toEqual({ count: 3, exhausted: false, limit: 4 });

  current = revision();
  const importCut: DocMetadata = { headings: [], parts: ["eeeeeeee", "ffffffff"] };
  expect(chargeHtmlParts([current, imported], importCut)).toBeUndefined();
  expect(importCut).not.toHaveProperty("parts");
  expect(current).toEqual({ count: 0, exhausted: false, limit: 2 });
  expect(imported).toEqual({ count: 3, exhausted: true, limit: 4 });

  current = revision();
  const later: DocMetadata = { headings: [], parts: ["11111111"] };
  expect(chargeHtmlParts([current, imported], later)).toBeUndefined();
  expect(later).not.toHaveProperty("parts");
  expect(current).toEqual({ count: 0, exhausted: false, limit: 2 });
  expect(imported).toEqual({ count: 3, exhausted: true, limit: 4 });
});

test("the HTML part cap omits the first over-budget doc and every later HTML doc", async () => {
  const paths = ["one.html", "two.html", "over.html", "later.html"];
  const counts = [60000, 30000, 20000, 1];
  const request = input(paths);
  const sizes = new Map<string, number>();
  for (const [index, file] of request.files.entries()) {
    file.newBlob = index.toString(16).padStart(64, "0");
    sizes.set(file.newBlob, counts[index] ?? 0);
  }
  // Synthetic metadata exercises the revision budget without parsing large documents.
  const execute = vi.fn(async (work: Parameters<typeof executeWork>[0]) => {
    if (work.kind === "doc-metadata")
      return {
        kind: "doc-metadata" as const,
        title: "Synthetic doc",
        headings: [],
        parts: Array.from({ length: Number(new TextDecoder().decode(work.bytes)) }, (_, index) =>
          index.toString(16).padStart(8, "0"),
        ),
      };
    if (work.kind === "writeup") return { kind: "writeup" as const, ...serializeRendered({ sections: [] }) };
    throw new Error("unexpected work");
  });
  const onRendered = vi.fn();
  const result = await renderRevision(
    request,
    execute,
    async (hash) => new TextEncoder().encode(String(sizes.get(hash))).buffer,
    async () => new ArrayBuffer(0),
    async () => "stored",
    undefined,
    onRendered,
  );
  for (const [index, path] of paths.slice(0, 2).entries()) {
    expect(result.metadata.get(path)?.parts).toHaveLength(counts[index] ?? 0);
    expect(result.htmlParts.get(path)).toHaveLength(counts[index] ?? 0);
  }
  for (const path of paths.slice(2)) {
    expect(result.metadata.get(path)).toEqual({ title: "Synthetic doc", headings: [] });
    expect(result.htmlParts.has(path)).toBe(false);
  }
  const total = [...result.htmlParts.values()].reduce((sum, parts) => sum + parts.length, 0);
  expect(total).toBe(90000);
  expect(total).toBeLessThanOrEqual(LIMITS.htmlPartsPerRevision);
  expect(onRendered.mock.calls.slice(0, paths.length).map(([size]) => size)).toEqual(
    paths.map((path) => Buffer.byteLength(JSON.stringify(result.metadata.get(path) ?? null))),
  );
  expect(result.unrendered).toEqual([]);
});

test("the HTML part cap counts shared blobs per path and allows exactly the limit", async () => {
  const parts = Array.from({ length: LIMITS.htmlPartsPerDoc }, (_, index) => index.toString(16).padStart(8, "0"));
  const allowed = LIMITS.htmlPartsPerRevision / parts.length;
  const paths = Array.from({ length: allowed + 2 }, (_, index) => `doc-${index}.html`);
  const execute = vi.fn(async (work: Parameters<typeof executeWork>[0]) => {
    if (work.kind === "doc-metadata") return { kind: "doc-metadata" as const, headings: [], parts };
    if (work.kind === "writeup") return { kind: "writeup" as const, ...serializeRendered({ sections: [] }) };
    throw new Error("unexpected work");
  });
  const result = await renderRevision(
    input(paths),
    execute,
    async () => new ArrayBuffer(0),
    async () => new ArrayBuffer(0),
    async () => "stored",
  );
  expect(execute.mock.calls.filter(([work]) => work.kind === "doc-metadata")).toHaveLength(1);
  expect([...result.htmlParts.keys()]).toEqual(paths.slice(0, allowed));
  for (const path of paths.slice(0, allowed)) {
    expect(result.metadata.get(path)?.parts).toBe(parts);
    expect(result.htmlParts.get(path)).toHaveLength(parts.length);
  }
  for (const path of paths.slice(allowed)) expect(result.metadata.get(path)).not.toHaveProperty("parts");
  expect([...result.htmlParts.values()].reduce((sum, ids) => sum + ids.length, 0)).toBe(LIMITS.htmlPartsPerRevision);
  expect(result.unrendered).toEqual([]);
});

test("revision rendering shares an import part budget across calls", async () => {
  const parts = Array.from({ length: LIMITS.htmlPartsPerDoc }, (_, index) => index.toString(16).padStart(8, "0"));
  const paths = Array.from({ length: 10 }, (_, index) => `doc-${index}.html`);
  const imported: HtmlPartBudget = { count: 0, exhausted: false, limit: LIMITS.htmlPartsPerImport };
  const execute = vi.fn(async (work: Parameters<typeof executeWork>[0]) => {
    if (work.kind === "doc-metadata") return { kind: "doc-metadata" as const, headings: [], parts };
    if (work.kind === "writeup") return { kind: "writeup" as const, ...serializeRendered({ sections: [] }) };
    throw new Error("unexpected work");
  });
  for (let revision = 1; revision <= 11; revision++) {
    const result = await renderRevision(
      input(paths),
      execute,
      async () => new ArrayBuffer(0),
      async () => new ArrayBuffer(0),
      async () => "stored",
      undefined,
      undefined,
      { htmlParts: imported },
    );
    for (const path of paths) {
      if (revision <= 10) {
        expect(result.metadata.get(path)?.parts).toBe(parts);
        expect(result.htmlParts.get(path)).toHaveLength(parts.length);
      } else {
        expect(result.metadata.get(path)).not.toHaveProperty("parts");
        expect(result.htmlParts.has(path)).toBe(false);
      }
    }
    expect(result.unrendered).toEqual([]);
    expect(imported.count).toBe(Math.min(revision, 10) * LIMITS.htmlPartsPerRevision);
  }
  expect(imported).toEqual({ count: LIMITS.htmlPartsPerImport, exhausted: true, limit: LIMITS.htmlPartsPerImport });
});

test.each([false, true])(
  "HTML metadata stops requesting hashes after exhaustion (import already exhausted: %s)",
  async (importExhausted) => {
    const parts = Array.from({ length: LIMITS.htmlPartsPerDoc }, (_, index) => index.toString(16).padStart(8, "0"));
    const allowed = LIMITS.htmlPartsPerRevision / parts.length;
    const paths = Array.from({ length: allowed + 3 }, (_, index) => `doc-${index}.html`);
    const request = input(paths);
    for (const [index, file] of request.files.entries()) file.newBlob = index.toString(16).padStart(64, "0");
    const imported: HtmlPartBudget = {
      count: importExhausted ? LIMITS.htmlPartsPerImport : 0,
      exhausted: importExhausted,
      limit: LIMITS.htmlPartsPerImport,
    };
    const execute = vi.fn(async (work: Parameters<typeof executeWork>[0]) => {
      if (work.kind === "doc-metadata")
        return { kind: "doc-metadata" as const, headings: [], ...(work.parts === true ? { parts } : {}) };
      if (work.kind === "writeup") return { kind: "writeup" as const, ...serializeRendered({ sections: [] }) };
      throw new Error("unexpected work");
    });
    const result = await renderRevision(
      request,
      execute,
      async () => new ArrayBuffer(0),
      async () => new ArrayBuffer(0),
      async () => "stored",
      undefined,
      undefined,
      { htmlParts: imported },
    );
    const requested = execute.mock.calls.flatMap(([work]) =>
      work.kind === "doc-metadata" && work.format === "html" ? [work.parts === true] : [],
    );
    // The first over-budget doc is hashed; only its result can tell chargeHtmlParts to cut.
    expect(requested).toEqual(paths.map((_, index) => !importExhausted && index <= allowed));
    expect([...result.htmlParts.keys()]).toEqual(importExhausted ? [] : paths.slice(0, allowed));
    for (const path of paths.slice(importExhausted ? 0 : allowed))
      expect(result.metadata.get(path)).not.toHaveProperty("parts");
    expect(result.unrendered).toEqual([]);
  },
);

test("writeup work bounds unlisted paths and retains their full count", async () => {
  const paths = Array.from({ length: 25 }, (_, i) => `media/${i}.png`);
  const result = await executeWork({
    kind: "writeup",
    source: { overview: paths.map((path) => `![Before](${path})`).join(" "), tldr: "", decisions: null, topics: {} },
    topics: [],
    media: [],
  });
  expect(result).toMatchObject({ kind: "writeup", unlistedMedia: paths.slice(0, 20), unlistedMediaCount: 25 });
});

test("revision rendering reports only writeup effects, without refusing or collecting doc effects", async () => {
  const request = input(["doc.md"]);
  request.writeup.overview = "![Before](media/writeup.png)";
  const result = await renderRevision(
    request,
    executeWork,
    async () => new TextEncoder().encode("![Doc](media/doc.png)").buffer,
    async () => new ArrayBuffer(0),
    async () => "stored",
  );
  expect(result.unlistedMedia).toEqual(["media/writeup.png"]);
  expect(result.unrendered).toEqual([]);
  expect(result.docBlobs.has("doc.md")).toBe(true);
});

test("publish refuses unlisted media before storing blobs or rendering docs", async () => {
  const request = input(["doc.md"]);
  request.writeup.overview = "![Before](media/missing.png)";
  const execute = vi.fn(executeWork);
  const put = vi.fn(async () => "stored");
  await expect(
    renderRevision(
      request,
      execute,
      async () => new TextEncoder().encode("# Synthetic doc").buffer,
      async () => new ArrayBuffer(0),
      put,
      undefined,
      undefined,
      { refuseUnlistedMedia: true },
    ),
  ).rejects.toMatchObject({ code: "invalid_request", message: "A writeup image path is not listed under media." });
  expect(put).not.toHaveBeenCalled();
  expect(execute.mock.calls.map(([work]) => work.kind)).toEqual(["doc-metadata", "writeup"]);
});
test("one shared Markdown render produces exactly each path's normal block identities", async () => {
  const source =
    "# Title\n\nrepeat\n\nrepeat\n\nFoot[^1].\n\n[^1]: note\n\n<script>bad()</script>\n\n[bad](javascript:bad)";
  const stored = new Map<string, Buffer>();
  const execute = vi.fn(executeWork);
  const result = await renderRevision(
    input(["one/one.md", "two/two.md"]),
    execute,
    async (hash) => Uint8Array.from(stored.get(hash) ?? Buffer.from(source)).buffer,
    async () => new ArrayBuffer(0),
    async (bytes) => {
      const key = String(stored.size);
      stored.set(key, bytes);
      return key;
    },
  );
  expect(execute.mock.calls.filter(([work]) => work.kind === "doc")).toHaveLength(1);
  for (const path of ["one/one.md", "two/two.md"]) {
    const blob = stored.get(result.docBlobs.get(path) ?? "");
    expect(JSON.parse(blob?.toString() ?? "null")).toEqual(
      await renderMarkdown(source, `doc-${await blockHash(path)}`),
    );
  }
});

test.each(["failure", "timeout"])("identical bytes that %s cost one attempt across folders", async (reason) => {
  const failed = Array.from({ length: 40 }, (_, i) => `folder-${i}/bad.md`);
  const body = input([...failed, "later/good.md"]);
  const good = body.files.at(-1);
  if (!good) throw new Error("missing doc");
  good.newBlob = "c".repeat(64);
  const stored = new Map<string, Buffer>();
  const execute = vi.fn(async (work: Parameters<typeof executeWork>[0]) => {
    if (work.kind === "doc" && work.path !== good.path)
      throw reason === "timeout" ? new WorkTimeout() : new Error("synthetic failure");
    return executeWork(work);
  });
  const result = await renderRevision(
    body,
    execute,
    async (hash) => Uint8Array.from(stored.get(hash) ?? Buffer.from(hash === good.newBlob ? "# Good" : "# Bad")).buffer,
    async () => new ArrayBuffer(0),
    async (bytes) => {
      const key = String(stored.size);
      stored.set(key, bytes);
      return key;
    },
  );
  expect(execute.mock.calls.filter(([work]) => work.kind === "doc").map(([work]) => work)).toEqual([
    expect.objectContaining({ kind: "doc", path: failed[0] }),
    expect.objectContaining({ kind: "doc", path: good.path }),
  ]);
  expect(result.unrendered).toEqual(failed);
  expect(result.docBlobs.has(good.path)).toBe(true);
});

test("shared doc links render once per folder and resection copies keep that folder's link", async () => {
  const paths = ["one/a.md", "one/b.md", "two/a.md", "two/b.md", "one/target.md", "two/target.md"];
  const stored = new Map<string, Buffer>();
  const execute = vi.fn(executeWork);
  const result = await renderRevision(
    input(paths),
    execute,
    async (hash) => Uint8Array.from(stored.get(hash) ?? Buffer.from("[go](target.md)")).buffer,
    async () => new ArrayBuffer(0),
    async (bytes) => {
      const key = String(stored.size);
      stored.set(key, bytes);
      return key;
    },
  );
  expect(execute.mock.calls.filter(([work]) => work.kind === "doc")).toHaveLength(2);
  expect(execute.mock.calls.filter(([work]) => work.kind === "resection")).toHaveLength(4);
  for (const path of paths) {
    const blocks = JSON.parse(stored.get(result.docBlobs.get(path) ?? "")?.toString() ?? "[]") as Block[];
    expect(blocks.map((block) => block.html).join("")).toContain(
      `href="?tab=docs&#x26;doc=${path.startsWith("one/") ? "one" : "two"}%2Ftarget.md">go`,
    );
    expect(blocks[0]?.section).toBe(`doc-${await blockHash(path)}`);
  }
});

test("a missing relative link in one folder cannot hide a declared link in another", async () => {
  const body = input(["one/start.md", "two/start.md", "two/target.md"]);
  const stored = new Map<string, Buffer>();
  const execute = vi.fn(executeWork);
  const result = await renderRevision(
    body,
    execute,
    async (hash) => Uint8Array.from(stored.get(hash) ?? Buffer.from("[go](target.md)")).buffer,
    async () => new ArrayBuffer(0),
    async (bytes) => {
      const key = String(stored.size);
      stored.set(key, bytes);
      return key;
    },
  );
  const blocks = (path: string) =>
    JSON.parse(stored.get(result.docBlobs.get(path) ?? "")?.toString() ?? "[]") as Block[];
  expect(blocks("one/start.md")[0]?.html).toBe("<p><a>go</a></p>");
  expect(blocks("two/start.md")[0]?.html).toContain('href="?tab=docs&#x26;doc=two%2Ftarget.md"');
  expect(execute.mock.calls.filter(([work]) => work.kind === "doc")).toHaveLength(2);
});
test("the block cap counts repeated paths and stops every later Markdown doc", async () => {
  const blocks: Block[] = Array.from({ length: 3000 }, (_, i) => ({
    id: `doc-aaaaaaaa-${i.toString(16).padStart(8, "0")}`,
    section: "doc-aaaaaaaa",
    kind: "paragraph",
    html: "<p>x</p>",
    text: "x",
  }));
  const execute = vi.fn(async (work: Parameters<typeof executeWork>[0]) =>
    work.kind === "doc-metadata"
      ? { kind: "doc-metadata" as const, headings: [] }
      : work.kind === "doc"
        ? { kind: "doc" as const, ...serializeRendered(blocks) }
        : executeWork(work),
  );
  const body = input(Array.from({ length: 40 }, (_, i) => `${i}.md`));
  const result = await renderRevision(
    body,
    execute,
    async () => serializeRendered(blocks).bytes,
    async () => new ArrayBuffer(0),
    async () => "stored",
  );
  expect(result.count).toBe(99001); // 99,000 doc blocks plus the writeup block.
  expect(result.unrendered).toEqual(body.files.slice(33).map((f) => f.path));
  expect(execute.mock.calls.filter(([work]) => work.kind === "doc")).toHaveLength(1);
});
test("an over-cap writeup fails before any rendered blob is stored", async () => {
  const blocks: Block[] = Array.from({ length: LIMITS.blocksPerRevision + 1 }, () => ({
    id: "overview-aaaaaaaa",
    section: "overview",
    kind: "paragraph",
    html: "x",
    text: "x",
  }));
  const put = vi.fn(async () => "stored");
  await expect(
    renderRevision(
      input([]),
      async () => ({
        kind: "writeup",
        ...serializeRendered({ sections: [{ key: "overview", label: "Overview", topic: null, blocks }] }),
      }),
      async () => new ArrayBuffer(0),
      async () => new ArrayBuffer(0),
      put,
    ),
  ).rejects.toMatchObject({ code: "too_large", message: "The writeup has too many blocks." });
  expect(put).not.toHaveBeenCalled();
});
test("the writeup renders images that parentless assets declare, and only those", async () => {
  const body = input([]);
  body.writeup.overview = "![Shot](media/a.png) ![Other](media/b.png) ![Doc asset](docs/c.png)";
  const asset = (path: string, newBlob: string, parent?: string) => ({
    path,
    role: "asset" as const,
    oldPath: null,
    oldBlob: null,
    newBlob,
    flag: null,
    ...(parent ? { parent } : {}),
  });
  body.files = [asset("media/a.png", "c".repeat(64)), asset("docs/c.png", "d".repeat(64), "docs/plan.html")];
  const stored: Buffer[] = [];
  await renderRevision(
    body,
    executeWork,
    async () => new ArrayBuffer(0),
    async () => new ArrayBuffer(0),
    async (bytes) => {
      stored.push(bytes);
      return String(stored.length - 1);
    },
  );
  const rendered = JSON.parse(stored[0]?.toString() ?? "null") as { sections: { blocks: { html: string }[] }[] };
  const html = rendered.sections.flatMap((s) => s.blocks.map((b) => b.html)).join("");
  expect(html).toContain(`src="/api/v1/media/${"c".repeat(64)}"`);
  expect(html).not.toContain("media/b.png");
  expect(html).not.toContain("d".repeat(64));
});
test("a Markdown doc keeps no image source even when the writeup declares that media path", async () => {
  const body = input(["notes.md"]);
  body.writeup.overview = "![Shot](media/a.png)";
  body.files = [
    ...body.files,
    { path: "media/a.png", role: "asset", oldPath: null, oldBlob: null, newBlob: "c".repeat(64), flag: null },
  ];
  const stored: Buffer[] = [];
  const docSource = Buffer.from("See ![x](media/a.png) here");
  const result = await renderRevision(
    body,
    executeWork,
    async () => Uint8Array.from(docSource).buffer,
    async () => new ArrayBuffer(0),
    async (bytes) => {
      stored.push(bytes);
      return String(stored.length - 1);
    },
  );
  const doc = stored[Number(result.docBlobs.get("notes.md"))]?.toString() ?? "";
  expect(doc).toContain("<img");
  expect(doc).not.toContain("src=");
  expect(doc).not.toContain("/api/v1/media/");
  expect(stored.map((blob) => blob.toString()).join("")).toContain(`src=\\"/api/v1/media/${"c".repeat(64)}\\"`);
});

test("shared source resolves each doc's own fragments and directory separately", async () => {
  const source = "[self](#missing) [sibling](target.md)";
  const stored = new Map<string, Buffer>();
  const paths = ["one.md", "two.md", "folder/one.md", "target.md", "folder/target.md"];
  const result = await renderRevision(
    input(paths),
    executeWork,
    async (hash) => Uint8Array.from(stored.get(hash) ?? Buffer.from(source)).buffer,
    async () => new ArrayBuffer(0),
    async (bytes) => {
      const key = String(stored.size);
      stored.set(key, bytes);
      return key;
    },
  );
  for (const path of paths) {
    const html = (JSON.parse(stored.get(result.docBlobs.get(path) ?? "")?.toString() ?? "[]") as Block[])
      .map((b) => b.html)
      .join("");
    expect(html).toContain(`doc=${encodeURIComponent(path)}">self`);
    expect(html).toContain(`doc=${path.includes("/") ? "folder%2F" : ""}target.md">sibling`);
  }
});

test.each(["failure", "budget"])("unrendered docs keep titles but no headings after %s", async (reason) => {
  const original = LIMITS.blocksPerRevision;
  if (reason === "budget") Object.assign(LIMITS, { blocksPerRevision: 1 });
  const body = input(["a.md", "b.md", "c.md"]);
  const stored = new Map<string, Buffer>();
  try {
    const result = await renderRevision(
      body,
      async (work) => {
        if (reason === "failure" && work.kind === "doc") throw new Error("synthetic render failure");
        return executeWork(work);
      },
      async (hash) => Uint8Array.from(stored.get(hash) ?? Buffer.from("# Title\n\n## Part")).buffer,
      async () => new ArrayBuffer(0),
      async (bytes) => {
        const hash = String(stored.size);
        stored.set(hash, bytes);
        return hash;
      },
    );
    expect(result.unrendered).toEqual(["a.md", "b.md", "c.md"]);
    for (const path of result.unrendered) expect(result.metadata.get(path)).toEqual({ title: "Title", headings: [] });
  } finally {
    Object.assign(LIMITS, { blocksPerRevision: original });
  }
});

test.each(["identical", "collision chain"])(
  "5,000 headings publish with bounded lookup work: %s",
  async (kind) => {
    const source = Array.from(
      { length: 5_000 },
      (_, i) => `## ${kind === "identical" || i < 2 ? "a" : `a-${i}`}\n`,
    ).join("\n");
    const stored = new Map<string, Buffer>();
    const result = await renderRevision(
      input(["a.md"]),
      async (work) => {
        if (work.kind === "writeup" || work.kind === "doc")
          expect(work.docs?.get("a.md")?.size).toBeLessThanOrEqual(3 * LIMITS.headingsPerDoc);
        return executeWork(work);
      },
      async (hash) => Uint8Array.from(stored.get(hash) ?? Buffer.from(source)).buffer,
      async () => new ArrayBuffer(0),
      async (bytes) => {
        const key = String(stored.size);
        stored.set(key, bytes);
        return key;
      },
    );
    expect(result.metadata.get("a.md")?.headings).toHaveLength(LIMITS.headingsPerDoc);
    const blocks = JSON.parse(stored.get(result.docBlobs.get("a.md") ?? "")?.toString() ?? "[]") as Block[];
    const ids = new Set(blocks.flatMap((block) => [...block.html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1])));
    for (const heading of result.metadata.get("a.md")?.headings ?? []) expect(ids.has(heading.id)).toBe(true);
  },
  10_000,
);

test("shared heading lists share their lookup map across paths", async () => {
  const execute = vi.fn(executeWork);
  const stored = new Map<string, Buffer>();
  await renderRevision(
    input(["a.md", "b.md"]),
    execute,
    async (hash) => Uint8Array.from(stored.get(hash) ?? Buffer.from("## Setup")).buffer,
    async () => new ArrayBuffer(0),
    async (bytes) => {
      const key = String(stored.size);
      stored.set(key, bytes);
      return key;
    },
  );
  const work = execute.mock.calls.find(([work]) => work.kind === "writeup")?.[0];
  expect(work?.kind === "writeup" && work.docs?.get("a.md")).toBe(work?.kind === "writeup" && work.docs?.get("b.md"));
});

test("source aliases reuse one render per language and highlight mode", async () => {
  const paths = Array.from({ length: 6 }, (_, i) => `alias-${i}.ts`);
  paths.push("alias.js");
  const source = `//${"x".repeat(256 * 1024 - 3)}\n`;
  const stored = new Map<string, Buffer>();
  const execute = vi.fn(executeWork);
  const result = await renderRevision(
    input(paths),
    execute,
    async () => new TextEncoder().encode(source).buffer,
    async () => new ArrayBuffer(0),
    async (bytes) => {
      const key = String(stored.size);
      stored.set(key, bytes);
      return key;
    },
  );
  expect(result.unrendered).toEqual([]);
  const jobs = execute.mock.calls.flatMap(([work]) => (work.kind === "source" ? [work] : []));
  expect(jobs.map(({ path, highlight }) => ({ path, highlight }))).toEqual([
    { path: "alias-0.ts", highlight: true },
    { path: "alias-4.ts", highlight: false },
    { path: "alias.js", highlight: false },
  ]);
  const doc = (path: string) => JSON.parse(stored.get(result.sourceBlobs.get(path) ?? "")?.toString() ?? "null");
  expect(doc("alias-0.ts").language).toBe("ts");
  expect(doc("alias-4.ts")).toEqual({ language: "text", lines: [[{ text: source.slice(0, -1) }]] });
  expect(result.sourceBlobs.get("alias-0.ts")).toBe(result.sourceBlobs.get("alias-3.ts"));
  expect(result.sourceBlobs.get("alias-4.ts")).toBe(result.sourceBlobs.get("alias-5.ts"));
});

test.each(["failure", "timeout"])(
  "failed source highlighting still consumes the revision budget: %s",
  async (reason) => {
    const attempts = Math.floor(HIGHLIGHT_SOURCE_REVISION_BYTES / HIGHLIGHT_SOURCE_BYTES);
    const body = input(Array.from({ length: attempts + 3 }, (_, i) => `source-${i}.ts`));
    const sources = new Map<string, ArrayBuffer>();
    for (const [index, file] of body.files.entries()) {
      file.newBlob = index.toString(16).padStart(64, "0");
      sources.set(
        file.newBlob,
        new TextEncoder().encode(`//${String(index).padEnd(HIGHLIGHT_SOURCE_BYTES - 3, "x")}\n`).buffer,
      );
    }
    // Failed aliases reuse the negative cache without dispatching or spending again.
    const first = body.files[0];
    if (!first) throw new Error("missing source");
    body.files.splice(1, 0, { ...first, path: "alias.ts" });
    const execute = vi.fn(async (work: Parameters<typeof executeWork>[0]) => {
      if (work.kind === "source" && work.highlight)
        throw reason === "timeout" ? new WorkTimeout() : new Error("synthetic failure");
      return executeWork(work);
    });
    const result = await renderRevision(
      body,
      execute,
      async (hash) => {
        const source = sources.get(hash);
        if (!source) throw new Error("missing source");
        return source;
      },
      async () => new ArrayBuffer(0),
      async () => "stored",
    );
    const jobs = execute.mock.calls.flatMap(([work]) => (work.kind === "source" ? [work] : []));
    const highlighted = jobs.filter((work) => work.highlight);
    expect(highlighted).toHaveLength(attempts);
    expect(highlighted.reduce((sum, work) => sum + work.source.byteLength, 0)).toBeLessThanOrEqual(
      HIGHLIGHT_SOURCE_REVISION_BYTES,
    );
    expect(jobs.filter((work) => !work.highlight)).toHaveLength(3);
    expect(result.unrendered).toEqual(body.files.slice(0, attempts + 1).map((file) => file.path));
    expect(result.sourceBlobs.size).toBe(3);
  },
);

test("media heads come from readHead once per distinct hash and never from read", async () => {
  const sha = "c".repeat(64);
  // Synthetic 3x2 PNG header.
  const header = Buffer.from("89504e470d0a1a0a0000000d4948445200000003000000020806000000", "hex");
  const read = vi.fn(async (hash: string): Promise<ArrayBuffer> => {
    if (hash === sha) throw new Error("media blob must not be read whole");
    return new ArrayBuffer(0);
  });
  const readHead = vi.fn(async () => Uint8Array.from(header).buffer);
  const request: PublishRequest = {
    ...input([]),
    writeup: { overview: "![A](media/a.png) ![B](media/b.png)", tldr: "", decisions: null, topics: {} },
    files: ["media/a.png", "media/b.png"].map((path) => ({
      path,
      role: "asset" as const,
      oldPath: null,
      oldBlob: null,
      newBlob: sha,
      flag: null,
    })),
  };
  const stored = new Map<string, Buffer>();
  const result = await renderRevision(request, executeWork, read, readHead, async (bytes) => {
    const key = String(stored.size);
    stored.set(key, bytes);
    return key;
  });
  expect(readHead).toHaveBeenCalledTimes(1);
  expect(readHead).toHaveBeenCalledWith(sha);
  expect(read.mock.calls.some(([hash]) => hash === sha)).toBe(false);
  const html = stored.get(result.renderedBlob)?.toString() ?? "";
  expect(html).toContain('width=\\"3\\"');
  expect(html).toContain('height=\\"2\\"');
});

test("shared Markdown sources keep their own image maps and share bounded heads with the writeup", async () => {
  const request = input(["one/a.md", "one/b.md", "two/a.md", "plain.md"]);
  const shaA = "c".repeat(64),
    shaB = "d".repeat(64);
  request.writeup.overview = "![Writeup](one/shot.png)";
  for (const doc of request.files) if (doc.path !== "plain.md") doc.assets = [`${doc.path.split("/")[0]}/shot.png`];
  request.files.push(
    { path: "one/shot.png", role: "asset", oldPath: null, oldBlob: null, newBlob: shaA, flag: null },
    {
      path: "two/shot.png",
      role: "asset",
      parent: "two/a.md",
      oldPath: null,
      oldBlob: null,
      newBlob: shaB,
      flag: null,
    },
  );
  const stored = new Map<string, Buffer>();
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000280000001e008060000001f15c489", "hex");
  const head = vi.fn(async () => Uint8Array.from(png).buffer);
  const execute = vi.fn(async (work: Parameters<typeof executeWork>[0]) => {
    if (work.kind === "image-sizes" || work.kind === "writeup") {
      // Match real worker transfer semantics: the sender's copies become detached.
      const transfers = (work.kind === "image-sizes" ? work.heads : (work.mediaHeads ?? [])).map(([, head]) => head);
      return executeWork(structuredClone(work, { transfer: transfers }));
    }
    return executeWork(work);
  });
  const result = await renderRevision(
    request,
    execute,
    async (sha) => Uint8Array.from(stored.get(sha) ?? Buffer.from("![Shot](shot.png)")).buffer,
    head,
    async (bytes) => {
      const key = String(stored.size);
      stored.set(key, bytes);
      return key;
    },
  );
  expect(head.mock.calls).toEqual([[shaA], [shaB]]);
  expect(execute.mock.calls.filter(([work]) => work.kind === "doc")).toHaveLength(3);
  for (const [path, sha] of [
    ["one/a.md", shaA],
    ["one/b.md", shaA],
    ["two/a.md", shaB],
  ]) {
    const html = stored.get(result.docBlobs.get(path ?? "") ?? "")?.toString();
    expect(html).toContain(`/api/v1/media/${sha}`);
    expect(html).toContain('width=\\"640\\" height=\\"480\\"');
  }
  expect(stored.get(result.docBlobs.get("plain.md") ?? "")?.toString()).not.toContain("/api/v1/media/");
});

test("metadata and rendered image headings agree, including cached sources and cross-doc links", async () => {
  const request = input(["with.md", "without.md", "link.md"]);
  const first = request.files[0];
  const link = request.files[2];
  if (!first || !link) throw new Error("missing doc");
  first.assets = ["shot.png"];
  link.newBlob = "e".repeat(64);
  request.files.push({
    path: "shot.png",
    role: "asset",
    parent: "with.md",
    oldPath: null,
    oldBlob: null,
    newBlob: "c".repeat(64),
    flag: null,
  });
  const stored = new Map<string, Buffer>();
  const result = await renderRevision(
    request,
    executeWork,
    async (sha) =>
      Uint8Array.from(
        stored.get(sha) ??
          Buffer.from(sha === link.newBlob ? "[Status](with.md#status-before)" : "## Status ![Before](shot.png)"),
      ).buffer,
    async () => new ArrayBuffer(0),
    async (bytes) => {
      const key = String(stored.size);
      stored.set(key, bytes);
      return key;
    },
  );
  const html = (path: string) =>
    (JSON.parse(stored.get(result.docBlobs.get(path) ?? "")?.toString() ?? "[]") as Block[])
      .map((b) => b.html)
      .join("");
  const id = result.metadata.get("with.md")?.headings[0]?.id;
  expect(id).toBeTruthy();
  expect(html("with.md")).toContain(`id="${id}"`);
  expect(html("link.md")).toContain(`doc=with.md#h-${id}`);
  const plainId = result.metadata.get("without.md")?.headings[0]?.id;
  expect(plainId).not.toBe(id);
  expect(html("without.md")).toContain(`id="${plainId}"`);
});

test("doc image heads are released in batches of at most 16 MiB and docs receive only sizes", async () => {
  const request = input(["one.md", "two.md"]);
  const paths = Array.from({ length: 66 }, (_, i) => `shot-${i}.png`);
  for (const doc of request.files) doc.assets = paths;
  request.files.push(
    ...paths.map((path, i) => ({
      path,
      role: "asset" as const,
      parent: "one.md",
      oldPath: null,
      oldBlob: null,
      newBlob: i.toString(16).padStart(64, "0"),
      flag: null,
    })),
  );
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000003000000020806000000", "hex");
  let liveBytes = 0;
  const batches: number[] = [];
  const readHead = vi.fn(async (_sha: string) => {
    liveBytes += 256 * 1024;
    expect(liveBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    const head = new Uint8Array(256 * 1024);
    head.set(png);
    return head.buffer;
  });
  const execute = vi.fn(async (work: Parameters<typeof executeWork>[0]) => {
    if (work.kind === "doc") {
      expect(work).not.toHaveProperty("mediaHeads");
      expect(work.mediaSizes).toHaveLength(66);
    }
    if (work.kind !== "image-sizes") return executeWork(work);
    const bytes = work.heads.reduce((sum, [, head]) => sum + head.byteLength, 0);
    const result = await executeWork(structuredClone(work, { transfer: work.heads.map(([, head]) => head) }));
    batches.push(bytes);
    liveBytes -= bytes;
    return result;
  });
  const stored = new Map<string, Buffer>();
  const result = await renderRevision(
    request,
    execute,
    async (sha) => Uint8Array.from(stored.get(sha) ?? Buffer.from("![Shot](shot-0.png)")).buffer,
    readHead,
    async (bytes) => {
      const key = String(stored.size);
      stored.set(key, bytes);
      return key;
    },
  );
  expect(batches).toEqual([16 * 1024 * 1024, 2 * 256 * 1024]);
  expect(readHead).toHaveBeenCalledTimes(66);
  expect(new Set(readHead.mock.calls.map(([sha]) => sha)).size).toBe(66);
  for (const path of ["one.md", "two.md"]) {
    const html = stored.get(result.docBlobs.get(path) ?? "")?.toString();
    expect(html).toContain("emend-media-sized");
    expect(html).toContain('width=\\"3\\" height=\\"2\\"');
  }
});

test.each([false, true])("doc image head failures honor cancellation (aborted: %s)", async (aborted) => {
  const request = input(["plan.md", "other.md"]);
  request.writeup.overview = "Synthetic overview";
  const sha = "c".repeat(64);
  for (const doc of request.files) doc.assets = ["shot.png"];
  request.files.push({
    path: "shot.png",
    role: "asset",
    parent: "plan.md",
    oldPath: null,
    oldBlob: null,
    newBlob: sha,
    flag: null,
  });
  const controller = new AbortController();
  const stored = new Map<string, Buffer>();
  const head = vi.fn(async () => {
    if (aborted) controller.abort();
    throw new Error("synthetic head read failure");
  });
  const rendered = renderRevision(
    request,
    executeWork,
    async (hash) => Uint8Array.from(stored.get(hash) ?? Buffer.from("![Shot](shot.png)")).buffer,
    head,
    async (bytes) => {
      const key = String(stored.size);
      stored.set(key, bytes);
      return key;
    },
    controller.signal,
  );
  if (aborted) {
    await expect(rendered).rejects.toBeInstanceOf(PublishAborted);
    expect(stored.size).toBe(0);
    return;
  }
  const result = await rendered;
  expect(head).toHaveBeenCalledExactlyOnceWith(sha);
  expect(result.unrendered).toEqual([]);
  expect(stored.get(result.renderedBlob)?.toString()).toContain("Synthetic overview");
  for (const path of ["plan.md", "other.md"]) {
    const blocks = JSON.parse(stored.get(result.docBlobs.get(path) ?? "")?.toString() ?? "[]") as Block[];
    const html = blocks.map((block) => block.html).join("");
    expect(html).toContain(`/api/v1/media/${sha}`);
    expect(html).not.toMatch(/width=|height=|emend-media-sized/);
  }
});
