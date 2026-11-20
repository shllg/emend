import { Outcome, SampleView, ThreadState } from "@emend/contract";
import { describe, expect, it } from "vitest";
import { buildSampleView } from "./build.ts";

describe("theme sample", () => {
  it("renders deterministic contract data with content, anchors and every feedback state", async () => {
    const sample = await buildSampleView();
    expect(SampleView.parse(sample)).toEqual(await buildSampleView());
    const blocks = sample.revision.writeup.sections.flatMap((section) => section.blocks);
    const html = blocks.map((block) => block.html).join("");
    for (const tag of [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
      "a",
      "code",
      "ul",
      "ol",
      "table",
      "blockquote",
      "pre",
      "img",
    ])
      expect(html, tag).toContain(`<${tag}`);
    for (const kind of ["flowchart", "sequenceDiagram", "stateDiagram-v2", "classDiagram"])
      expect(
        blocks.some((block) => block.kind === "diagram" && block.source?.includes(kind)),
        kind,
      ).toBe(true);
    expect(new Set(sample.revision.threads.map((thread) => thread.state))).toEqual(new Set(ThreadState.options));
    expect(
      new Set(sample.revision.threads.flatMap((thread) => thread.comments.flatMap((comment) => comment.outcome ?? []))),
    ).toEqual(new Set(Outcome.options));
    for (const thread of sample.revision.threads) {
      const all = [...blocks, ...sample.revision.docs.flatMap((doc) => (doc.kind === "markdown" ? doc.blocks : []))];
      const target = thread.target;
      expect("blockId" in target && all.some((block) => block.id === target.blockId)).toBe(true);
      expect(thread.comments.every((comment) => comment.html?.includes("<"))).toBe(true);
    }
    expect(sample.revision.docs.map((doc) => doc.kind)).toEqual(["markdown", "source", "html"]);
    expect(sample.revision.docs[2]).toMatchObject({ look: "emend" });
    expect(sample.revision.files.filter((file) => file.role === "diff").map((file) => file.status)).toEqual([
      "modified",
      "modified",
      "added",
      "deleted",
    ]);
  });
});
