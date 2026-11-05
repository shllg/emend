import { once } from "node:events";
import { Worker } from "node:worker_threads";
import type { Block, RenderedWriteup } from "@emend/core";
import { expect, test } from "vitest";
import { type WorkerExecutor, workerExecutor } from "./executor.ts";

async function blockText(html: string): Promise<string> {
  // Reparse deep output on the production-sized stack too, not Vitest's main-thread stack.
  const worker = new Worker(new URL("./block-text-worker.fixture.ts", import.meta.url), {
    workerData: html,
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
  });
  try {
    const [text] = await once(worker, "message");
    return text;
  } finally {
    await worker.terminate();
  }
}

async function render(execute: WorkerExecutor, kind: "doc" | "writeup", source: string): Promise<Block[]> {
  const result = await execute(
    kind === "doc"
      ? { kind, path: "deep.md", source: new TextEncoder().encode(source).buffer }
      : {
          kind,
          source: { overview: source, tldr: "", decisions: "", topics: {} },
          topics: [],
          media: [],
        },
  );
  expect(result.kind).toBe(kind);
  if (result.kind === "doc") return JSON.parse(new TextDecoder().decode(result.bytes)) as Block[];
  if (result.kind === "writeup") {
    const writeup = JSON.parse(new TextDecoder().decode(result.bytes)) as RenderedWriteup;
    return writeup.sections.flatMap((section) => section.blocks);
  }
  throw new Error("Missing rendered blocks");
}

// Real rendering and reparsing on production-sized worker stacks are the depth regression.
test.each(["doc", "writeup"] as const)(
  "%s worker renders 2000 nested divs without overflowing the stack",
  async (kind) => {
    const execute = workerExecutor();
    try {
      const blocks = await render(execute, kind, `${"<div>".repeat(2000)}<p>Deep content</p>${"</div>".repeat(2000)}`);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ kind: "paragraph", text: "Deep content" });
      expect(await blockText(blocks[0]?.html ?? "")).toBe("Deep content");
    } finally {
      await execute.close();
    }
  },
  30000,
);

// Cold real workers render shallow markup and 2,000 nested containers on production-sized stacks.
test.each(["doc", "writeup"] as const)(
  "%s worker preserves sanitized markup, escaped text and identity in 2000 nested containers",
  async (kind) => {
    const execute = workerExecutor();
    try {
      const content =
        '<p title="&quot;quoted&quot; &amp; text">Deep <strong>&lt;content&gt;</strong><br>&amp; more<img src="https://example.com/a.png" onerror="bad()"></p>';
      const [shallow] = await render(execute, kind, content);
      const [deep] = await render(execute, kind, `${"<div>".repeat(2000)}${content}${"</div>".repeat(2000)}`);
      expect(deep?.id).toBe(shallow?.id);
      expect(deep?.text).toBe("Deep <content>& more");
      expect(deep?.html).toContain(shallow?.html);
      expect(deep?.html).not.toContain("onerror");
    } finally {
      await execute.close();
    }
  },
  30000,
);

// Both real worker passes must handle 4,000 nested containers on the production-sized stack.
test("doc worker renders 4000 nested divs with stack headroom", async () => {
  const execute = workerExecutor();
  try {
    const blocks = await render(execute, "doc", `${"<div>".repeat(4000)}<p>Deep content</p>${"</div>".repeat(4000)}`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "paragraph", text: "Deep content" });
    expect(await blockText(blocks[0]?.html ?? "")).toBe("Deep content");
  } finally {
    await execute.close();
  }
}, 30000);
