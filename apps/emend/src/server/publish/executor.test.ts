import type { Worker } from "node:worker_threads";
import type { PublishRequest } from "@emend/contract";
import { expect, test, vi } from "vitest";
import { WorkTimeout, workerExecutor } from "./executor.ts";
import { renderRevision } from "./render.ts";
import type { Work } from "./work.ts";

const created = vi.hoisted(() => ({
  count: 0,
  limits: [] as unknown[],
  posts: [] as { kind: string; docs?: unknown }[],
}));
vi.mock("node:worker_threads", async (original) => {
  const module = await original<typeof import("node:worker_threads")>();
  return {
    ...module,
    Worker: class extends module.Worker {
      constructor(...args: ConstructorParameters<typeof module.Worker>) {
        super(...args);
        created.count++;
        created.limits.push(args[1]?.resourceLimits);
      }
      override postMessage(...args: Parameters<Worker["postMessage"]>) {
        created.posts.push(args[0]);
        return super.postMessage(...args);
      }
    },
  };
});

test("many docs post one heading map per worker and a later publish replaces it", async () => {
  const execute = workerExecutor();
  const before = created.posts.length;
  const stored = new Map<string, Buffer>();
  const input: PublishRequest = {
    reviewKey: "a".repeat(64),
    repo: null,
    branch: null,
    title: "Synthetic",
    base: null,
    head: null,
    topics: [],
    writeup: { overview: "[go](0.md)", tldr: "", decisions: null, topics: {} },
    files: Array.from({ length: 30 }, (_, index) => ({
      path: `${index}.md`,
      role: "doc",
      oldPath: null,
      oldBlob: null,
      newBlob: "b".repeat(64),
      flag: null,
    })),
  };
  const read = async (hash: string) =>
    Uint8Array.from(stored.get(hash) ?? Buffer.from("## Part\n\n[self](#missing)")).buffer;
  const put = async (bytes: Buffer) => {
    const hash = String(stored.size);
    stored.set(hash, bytes);
    return hash;
  };
  try {
    await renderRevision(input, execute, read, put);
    const posts = created.posts.slice(before);
    expect(posts.filter((post) => post.docs !== undefined)).toHaveLength(1);
    expect(
      posts.filter((post) => post.kind === "doc" || post.kind === "writeup").every((post) => post.docs === undefined),
    ).toBe(true);
    const next = await renderRevision({ ...input, files: [] }, execute, read, put);
    expect(stored.get(next.renderedBlob)?.toString()).not.toContain("?tab=docs");
    expect(created.posts.slice(before).filter((post) => post.docs !== undefined)).toHaveLength(2);
  } finally {
    await execute.close();
  }
});

test.each(["timeout", "failure"])("a doc after worker %s still gets its links", async (reason) => {
  const timeouts = { render: 10000, place: 30000 };
  const execute = workerExecutor(timeouts);
  const docs = new Map([["target.md", new Map([["part", "user-content-part"]])]]);
  const work = (): Extract<Work, { kind: "doc" }> => ({
    kind: "doc",
    path: "source.md",
    source: new TextEncoder().encode("[go](target.md#part)").buffer,
    docs,
  });
  const before = created.posts.length;
  try {
    await execute(work());
    if (reason === "timeout") {
      timeouts.render = 1;
      await expect(
        execute({ ...work(), source: new TextEncoder().encode("word ".repeat(200000)).buffer }),
      ).rejects.toBeInstanceOf(WorkTimeout);
    } else await expect(execute({ ...work(), source: null } as unknown as Work)).rejects.toThrow("Worker failed");
    timeouts.render = 10000;
    const result = await execute(work());
    if (result.kind !== "doc") throw new Error("wrong result");
    expect(new TextDecoder().decode(result.bytes)).toContain("doc=target.md#h-user-content-part");
    const posts = created.posts.slice(before);
    expect(posts.filter((post) => post.docs !== undefined)).toHaveLength(2);
  } finally {
    await execute.close();
  }
});

test("line counts treat CRLF as one delimiter and lone CR as content, with no phantom last line", async () => {
  const execute = workerExecutor();
  try {
    for (const [text, count] of [
      ["one\r\ntwo\r\n", 2],
      ["one\rtwo\r", 1],
      ["one\rtwo\r\nthree", 2],
      ["", 0],
    ] as const) {
      expect(await execute({ kind: "line-count", bytes: new TextEncoder().encode(text).buffer })).toEqual({
        kind: "line-count",
        count,
      });
    }
  } finally {
    await execute.close();
  }
});

test("comment Markdown renders in the worker, in order, with repoUrl links", async () => {
  const execute = workerExecutor();
  try {
    const result = await execute({
      kind: "comment-md",
      bodies: ["**one**", "see #5", "<script>alert(1)</script>ok"],
      repoUrl: "https://github.com/o/r",
    });
    expect(result.kind).toBe("comment-md");
    if (result.kind !== "comment-md") return;
    expect(result.html[0]).toBe("<p><strong>one</strong></p>");
    expect(result.html[1]).toContain('href="https://github.com/o/r/issues/5"');
    expect(result.html[2]).not.toContain("<script");
  } finally {
    await execute.close();
  }
});

test("breaker: writeup source is transferred, parsed and stripped in the worker", async () => {
  const execute = workerExecutor();
  try {
    const source = { overview: "Synthetic", tldr: "", decisions: null, topics: {} };
    const bytes = new TextEncoder().encode(JSON.stringify({ ...source, junk: [[[]]] })).buffer;
    const result = await execute({ kind: "writeup-source", bytes });
    expect(bytes.byteLength).toBe(0);
    expect(result).toEqual({ kind: "writeup-source", source });
    for (const text of ["{", "{}", JSON.stringify({ ...source, overview: 1 })])
      await expect(execute({ kind: "writeup-source", bytes: new TextEncoder().encode(text).buffer })).rejects.toThrow(
        "Worker failed",
      );
  } finally {
    await execute.close();
  }
});

test("breaker: writeup source uses the render timeout", async () => {
  const execute = workerExecutor({ render: 1, place: 30000 });
  try {
    await expect(
      execute({
        kind: "writeup-source",
        bytes: new TextEncoder().encode('{"overview":"","tldr":"","decisions":null,"topics":{}}').buffer,
      }),
    ).rejects.toBeInstanceOf(WorkTimeout);
  } finally {
    await execute.close();
  }
});

test("real worker reuses jobs with bounded memory and is replaced after failure or timeout", async () => {
  const work = () => ({
    kind: "doc" as const,
    source: new TextEncoder().encode("# Safe\n\n<script>evil()</script>").buffer,
    path: "plan.md",
  });
  const execute = workerExecutor();
  try {
    const before = created.count;
    const rendered = await execute(work());
    await execute(work());
    const hash = "a".repeat(64);
    const placed = await execute({
      kind: "place",
      writeup: null,
      docs: new Map(),
      topics: new Set(),
      texts: new Map([[hash, new TextEncoder().encode("needle\n").buffer]]),
      files: new Map([["file.ts", { newHash: hash }]]),
      threads: [
        {
          id: "synthetic",
          target: {
            kind: "lines",
            path: "file.ts",
            side: "new",
            start: 1,
            end: 1,
            lines: ["needle"],
            before: [],
            after: [],
          },
          last: null,
          renames: [],
        },
      ],
    });
    expect(placed).toMatchObject({ kind: "place", placements: [{ placement: { status: "placed" } }] });
    expect(created.count - before).toBe(1);
    expect(created.limits.at(-1)).toEqual({
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    });
    if (!("ids" in rendered)) throw new Error("missing bytes");
    expect(new TextDecoder().decode(rendered.bytes)).not.toContain("evil()");
    expect(new TextDecoder().decode(rendered.bytes)).toContain("Safe");
    const bytes = rendered.bytes;
    const ids = rendered.ids;
    const changed = await execute({ kind: "changed", previous: [{ format: "doc", bytes }], next: [ids] });
    expect(bytes.byteLength).toBe(0);
    expect(ids.byteLength).toBe(0);
    expect(changed).toEqual({ kind: "changed", bytes: new ArrayBuffer(0) });
    await expect(execute({ ...work(), source: null as unknown as ArrayBuffer })).rejects.toThrow();
    await execute(work());
    expect(created.count - before).toBe(2);
  } finally {
    await execute.close();
  }
  const timeouts = { render: 1, place: 1 };
  const slow = workerExecutor(timeouts);
  try {
    await expect(slow(work())).rejects.toBeInstanceOf(WorkTimeout);
    timeouts.render = 10000;
    expect((await slow(work())).kind).toBe("doc");
  } finally {
    await slow.close();
  }
});

test("fix5: real worker transfers parsed doc bytes in both directions and preserves cached bytes", async () => {
  const execute = workerExecutor();
  try {
    const bytes = new TextEncoder().encode("<p>needle 界</p>").buffer;
    const parsed = await execute({ kind: "placement-doc", format: "html", bytes });
    expect(bytes.byteLength).toBe(0);
    expect(parsed).toMatchObject({
      kind: "placement-doc",
      bytes: expect.any(ArrayBuffer),
      textBytes: 10,
      encodedBytes: expect.any(Number),
    });
    expect(parsed).not.toHaveProperty("doc");
    if (parsed.kind !== "placement-doc") throw new Error("Missing parsed document");
    expect(parsed.encodedBytes).toBe(parsed.bytes.byteLength);
    expect(JSON.parse(new TextDecoder().decode(parsed.bytes))).toEqual({ kind: "html", text: "needle 界" });
    for (let i = 0; i < 2; i++) {
      const copy = { ...parsed, bytes: parsed.bytes.slice(0) };
      const placed = await execute({
        kind: "place",
        docs: new Map(),
        parsedDocs: new Map([
          ["doc.html", copy],
          ["alias.html", copy],
        ]),
        files: new Map(),
        texts: new Map(),
        writeup: null,
        topics: new Set(),
        threads: [
          {
            id: "synthetic",
            target: { kind: "html-span", path: "doc.html", quote: "needle 界", prefix: "", suffix: "" },
            last: null,
            renames: [],
          },
        ],
      });
      expect(copy.bytes.byteLength).toBe(0);
      expect(parsed.bytes.byteLength).toBe(parsed.encodedBytes);
      expect(placed).toMatchObject({
        kind: "place",
        placements: [{ placement: { status: "placed", location: { path: "doc.html", start: 0, end: 8 } } }],
      });
    }
  } finally {
    await execute.close();
  }
});

test("fix5: real worker transfers parsed writeup bytes and reuses them for placement", async () => {
  const execute = workerExecutor();
  try {
    const block = {
      id: "overview-00000000",
      kind: "paragraph",
      section: "overview",
      text: "needle 界",
      html: "<p>needle 界</p>",
    };
    const bytes = new TextEncoder().encode(JSON.stringify({ sections: [{ key: "overview", blocks: [block] }] })).buffer;
    const parsed = await execute({ kind: "placement-doc", format: "writeup", bytes });
    expect(bytes.byteLength).toBe(0);
    expect(parsed).toMatchObject({
      kind: "placement-doc",
      bytes: expect.any(ArrayBuffer),
      textBytes: 10,
      encodedBytes: expect.any(Number),
    });
    expect(parsed).not.toHaveProperty("doc");
    if (parsed.kind !== "placement-doc") throw new Error("Missing writeup");
    expect(parsed.encodedBytes).toBe(parsed.bytes.byteLength);
    expect(JSON.parse(new TextDecoder().decode(parsed.bytes))).toEqual({ kind: "markdown", blocks: [block] });
    for (let i = 0; i < 2; i++) {
      const copy = { ...parsed, bytes: parsed.bytes.slice(0) };
      expect(
        await execute({
          kind: "place",
          writeup: null,
          parsedWriteup: copy,
          docs: new Map(),
          texts: new Map(),
          files: new Map(),
          topics: new Set(),
          threads: [
            {
              id: "synthetic",
              target: { kind: "writeup-span", blockId: block.id, quote: "needle 界", prefix: "", suffix: "" },
              last: null,
              renames: [],
            },
          ],
        }),
      ).toMatchObject({
        kind: "place",
        placements: [
          { placement: { status: "placed", location: { kind: "writeup-span", blockId: block.id, start: 0, end: 8 } } },
        ],
      });
      expect(copy.bytes.byteLength).toBe(0);
      expect(parsed.bytes.byteLength).toBe(parsed.encodedBytes);
    }
  } finally {
    await execute.close();
  }
});
