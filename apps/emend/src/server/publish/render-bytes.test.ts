import type { PublishRequest } from "@emend/contract";
import type { Block } from "@emend/core";
import { expect, test, vi } from "vitest";
import { renderRevision } from "./render.ts";
import { type Executor, executeWork, serializeRendered } from "./work.ts";

vi.mock("@emend/contract", async (original) => {
  const contract = await original<typeof import("@emend/contract")>();
  return {
    ...contract,
    LIMITS: { ...contract.LIMITS, renderedBytesPerRevision: 600, headingLookupBytesPerRevision: 47 },
  };
});
const input: PublishRequest = {
  reviewKey: "a".repeat(64),
  repo: null,
  branch: null,
  title: "Synthetic",
  base: null,
  head: null,
  topics: [],
  writeup: { overview: "", tldr: "", decisions: null, topics: {} },
  files: ["a.md", "b.md", "c.md"].map((path) => ({
    path,
    role: "doc",
    oldPath: null,
    oldBlob: null,
    newBlob: path === "c.md" ? "c".repeat(64) : "b".repeat(64),
    flag: null,
  })),
};
const block: Block = {
  id: "doc-aaaaaaaa-bbbbbbbb",
  section: "doc-aaaaaaaa",
  kind: "paragraph",
  html: `<p>${"x".repeat(130)}</p>`,
  text: "x".repeat(130),
};
test("rendered bytes count each shared path and stop later docs even with different sources", async () => {
  const execute = vi.fn<Executor>(async (work) =>
    work.kind === "doc-metadata"
      ? { kind: "doc-metadata", headings: [] }
      : work.kind === "writeup"
        ? { kind: "writeup", ...serializeRendered({ sections: [] }) }
        : work.kind === "doc"
          ? { kind: "doc", ...serializeRendered([block]) }
          : executeWork(work),
  );
  const result = await renderRevision(
    input,
    execute,
    async () => serializeRendered([block]).bytes,
    async () => "stored",
  );
  expect([...result.docBlobs.keys()]).toEqual(["a.md"]);
  expect(result.unrendered).toEqual(["b.md", "c.md"]);
  expect(execute.mock.calls.filter(([work]) => work.kind === "doc")).toHaveLength(1);
});
test("a writeup alone above the byte cap has the fixed size error", async () => {
  await expect(
    renderRevision(
      input,
      async () => ({
        kind: "writeup",
        ...serializeRendered({
          sections: [
            { key: "overview", label: "Overview", topic: null, blocks: [{ ...block, html: "x".repeat(700) }] },
          ],
        }),
      }),
      async () => new ArrayBuffer(0),
      async () => "stored",
    ),
  ).rejects.toMatchObject({ code: "too_large", message: "The writeup has too many blocks." });
});

test("doc metadata is bounded before storing any rendered blobs", async () => {
  const put = vi.fn(async () => "stored");
  await expect(
    renderRevision(
      input,
      async (work) =>
        work.kind === "doc-metadata"
          ? { kind: "doc-metadata", title: "x".repeat(200), headings: [{ level: 2, text: "y".repeat(200) }] }
          : executeWork(work),
      async () => new ArrayBuffer(0),
      put,
    ),
  ).rejects.toMatchObject({ code: "too_large" });
  expect(put).not.toHaveBeenCalled();
});

test("lookup bytes have an independent budget even when metadata fits", async () => {
  const put = vi.fn(async () => "stored");
  await expect(
    renderRevision(
      { ...input, files: input.files.slice(0, 1) },
      async (work) =>
        work.kind === "doc-metadata"
          ? {
              kind: "doc-metadata",
              headings: [{ level: 2, text: "a".repeat(200), id: `user-content-${"b".repeat(187)}` }],
            }
          : executeWork(work),
      async () => new ArrayBuffer(0),
      put,
    ),
  ).rejects.toMatchObject({ code: "too_large" });
  expect(put).not.toHaveBeenCalled();
});

test.each(["distinct lists", "UTF-8 name"])(
  "R1.8 the dedicated lookup budget counts overhead and %s before writeup work",
  async (kind) => {
    const put = vi.fn(async () => "stored");
    const execute = vi.fn<Executor>(async (work) =>
      work.kind === "doc-metadata"
        ? {
            kind: "doc-metadata",
            headings: [{ level: 2, text: "", id: kind === "UTF-8 name" ? "user-content-é" : "user-content-a" }],
          }
        : work.kind === "writeup"
          ? { kind: "writeup", ...serializeRendered({ sections: [] }) }
          : { kind: "doc", ...serializeRendered([]) },
    );
    const files = kind === "distinct lists" ? [input.files[0], input.files[2]] : [input.files[0]];
    await expect(
      renderRevision(
        { ...input, files: files.filter((file) => file !== undefined) },
        execute,
        async () => new ArrayBuffer(0),
        put,
      ),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(execute.mock.calls.some(([work]) => work.kind === "writeup")).toBe(false);
    expect(put).not.toHaveBeenCalled();
  },
);

test("R1.8 exactly the lookup cap is accepted and a shared heading list is charged once", async () => {
  const execute: Executor = async (work) =>
    work.kind === "doc-metadata"
      ? { kind: "doc-metadata", headings: [{ level: 2, text: "", id: "user-content-a" }] }
      : work.kind === "writeup"
        ? { kind: "writeup", ...serializeRendered({ sections: [] }) }
        : { kind: "doc", ...serializeRendered([]) };
  const result = await renderRevision(
    { ...input, files: input.files.slice(0, 2) },
    execute,
    async () => new ArrayBuffer(0),
    async () => "stored",
  );
  expect(result.docBlobs.size).toBe(2);
});
