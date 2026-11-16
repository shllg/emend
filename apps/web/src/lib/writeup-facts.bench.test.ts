import type { RenderedWriteup, TopicMeta } from "@emend/contract";
import { expect, test } from "vitest";
import { undoFact } from "./writeup-facts.ts";

test("writeup-facts-undo-markers", () => {
  const text = `${". Undo: a".repeat(80_000)}\nx`;
  const writeup: RenderedWriteup = {
    sections: [
      {
        key: "t-first-why",
        label: "t-first-why",
        topic: "first",
        blocks: [{ id: "t-first-why-12345678", section: "t-first-why", text, html: "", kind: "paragraph" }],
      },
    ],
  };
  const topics: TopicMeta[] = [{ slug: "first", title: "first", summary: "", importance: 10 }];
  const start = performance.now();
  const parts = undoFact(writeup, topics);
  const ms = performance.now() - start;
  expect(parts?.[0]?.text).toBe(`${"a. Undo: ".repeat(38).slice(0, 299)}…`);
  process.stdout.write(`${JSON.stringify({ bench: "writeup-facts-undo-markers", ms, inputChars: text.length })}\n`);
});
