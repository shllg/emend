import { LIMITS, type PublishRequest } from "@emend/contract";
import {
  type Block,
  blockHash,
  HIGHLIGHT_SOURCE_BYTES,
  HIGHLIGHT_SOURCE_REVISION_BYTES,
  renderMarkdown,
} from "@emend/core";
import { expect, test, vi } from "vitest";
import { WorkTimeout } from "./executor.ts";
import { renderRevision } from "./render.ts";
import { executeWork, serializeRendered } from "./work.ts";

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
test("one shared Markdown render produces exactly each path's normal block identities", async () => {
  const source =
    "# Title\n\nrepeat\n\nrepeat\n\nFoot[^1].\n\n[^1]: note\n\n<script>bad()</script>\n\n[bad](javascript:bad)";
  const stored = new Map<string, Buffer>();
  const execute = vi.fn(executeWork);
  const result = await renderRevision(
    input(["one/one.md", "two/two.md"]),
    execute,
    async (hash) => Uint8Array.from(stored.get(hash) ?? Buffer.from(source)).buffer,
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
