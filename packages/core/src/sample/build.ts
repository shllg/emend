import { Outcome, type RevisionView, SampleView, type ThreadState, type ThreadView } from "@emend/contract";
import { DIFF_COUNT_TIMEOUT_MS, diffLineCounts } from "../diff-counts.ts";
import { htmlHeadingsFromTree, markdownHeadings } from "../doc-headings.ts";
import { inferDocTitle, markdownTitle } from "../doc-title.ts";
import { htmlLookFromTree } from "../html-look.ts";
import { parseDocHtml } from "../place/html.ts";
import { renderCommentHtml, renderDoc } from "../render/markdown.ts";
import { renderSource } from "../render/source.ts";
import { renderWriteup } from "../render/writeup.ts";
import {
  SAMPLE_DIFFS,
  SAMPLE_HTML,
  SAMPLE_HTML_PATH,
  SAMPLE_MARKDOWN,
  SAMPLE_SOURCE,
  SAMPLE_SOURCE_PATH,
  SAMPLE_TOPICS,
  SAMPLE_WRITEUP,
  sampleImageHash,
} from "./content.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Pure, deterministic sample data; the server owns caching and transport. */
export async function buildSampleView(): Promise<SampleView> {
  const sha = await sampleImageHash();
  const media = new Map([["sample.svg", sha]]);
  const mediaSizes = new Map([[sha, { width: 240, height: 120 }]]);
  const writeup = await renderWriteup(SAMPLE_WRITEUP, SAMPLE_TOPICS, { media, mediaSizes, effects: {} });
  const blocks = await renderDoc(SAMPLE_MARKDOWN, "guide.md", undefined, undefined, {}, new Map(), new Map());
  const tree = parseDocHtml(SAMPLE_HTML);
  const docs: RevisionView["docs"] = [
    { kind: "markdown", path: "guide.md", title: markdownTitle(blocks), headings: markdownHeadings(blocks), blocks },
    { kind: "source", path: SAMPLE_SOURCE_PATH, ...(await renderSource(SAMPLE_SOURCE, SAMPLE_SOURCE_PATH)) },
    {
      kind: "html",
      path: SAMPLE_HTML_PATH,
      title: await inferDocTitle("html", new TextEncoder().encode(SAMPLE_HTML)),
      headings: htmlHeadingsFromTree(tree),
      look: htmlLookFromTree(tree).look,
      contentUrl: `/content/sample/${SAMPLE_HTML_PATH}`,
    },
  ];
  const fileTexts: SampleView["fileTexts"] = {};
  const files: RevisionView["files"] = SAMPLE_DIFFS.map((file, index) => {
    const fileId = id(index + 1);
    fileTexts[fileId] = { old: file.old, new: file.new };
    return {
      id: fileId,
      path: file.path,
      oldPath: null,
      role: "diff",
      status: !file.old ? "added" : !file.new ? "deleted" : "modified",
      topic: file.topic,
      order: index,
      mediaType: "text/plain",
      flag: null,
      hasOld: !!file.old,
      hasNew: !!file.new,
      counts: diffLineCounts(file.old, file.new, { timeout: DIFF_COUNT_TIMEOUT_MS }) ?? undefined,
      ...(index === 0
        ? {
            notes: [
              {
                id: id(50),
                side: "new" as const,
                start: 3,
                end: 3,
                summary: "Choose the label from the parcel size.",
                rationale: "Small and large parcels have distinct labels.",
                ref: "A",
              },
            ],
          }
        : {}),
    };
  });
  for (const [index, doc] of docs.entries())
    files.push({
      id: id(20 + index),
      path: doc.path,
      oldPath: null,
      role: "doc",
      status: null,
      topic: null,
      order: SAMPLE_DIFFS.length + index,
      mediaType: doc.kind === "html" ? "text/html" : doc.kind === "markdown" ? "text/markdown" : "text/plain",
      flag: null,
      hasOld: false,
      hasNew: true,
      ...(doc.kind === "source" ? { view: "source" as const } : {}),
    });
  const anchors = [
    ...writeup.sections
      .flatMap((section) => section.blocks)
      .filter((block) => block.kind === "paragraph")
      .slice(0, 4)
      .map((block) => ({ block, path: undefined })),
    ...blocks
      .filter((block) => block.kind !== "heading" && block.text.length > 0)
      .slice(0, 4)
      .map((block) => ({ block, path: "guide.md" })),
  ];
  const threads: ThreadView[] = await Promise.all(
    anchors.map(async ({ block, path }, index) => {
      const quote = block.text.slice(0, 60);
      const location =
        path === undefined
          ? { kind: "writeup-span" as const, blockId: block.id }
          : { kind: "doc-span" as const, blockId: block.id, path };
      const states: ThreadState[] = [
        "open",
        "sent",
        "answered",
        "resolved",
        "answered",
        "answered",
        "open",
        "resolved",
      ];
      const state = states[index] ?? "answered";
      const body = `Please check this **parcel** example.\nIs the label clear?`;
      const reply = "The example now describes the `label` and its destination.";
      return {
        id: id(100 + index),
        target: { ...location, quote, prefix: "", suffix: block.text.slice(quote.length, quote.length + 30) },
        placement: { status: "placed", location: { ...location, start: 0, end: quote.length } },
        state,
        createdOn: 1,
        comments: [
          {
            id: id(200 + index),
            author: "user",
            body,
            html: await renderCommentHtml(body),
            sent: index !== 0,
            sentOn: index === 0 ? null : 1,
          },
          ...(state === "answered" || state === "resolved"
            ? [
                {
                  id: id(300 + index),
                  author: "agent" as const,
                  body: reply,
                  html: await renderCommentHtml(reply),
                  outcome: Outcome.options[(index - 2) % Outcome.options.length],
                  sent: true,
                  sentOn: 1,
                },
              ]
            : []),
        ],
      };
    }),
  );
  return SampleView.parse({
    revision: {
      seq: 2,
      base: null,
      head: null,
      main: "writeup",
      writeupEmpty: false,
      topics: SAMPLE_TOPICS,
      files,
      writeup,
      docs,
      threads,
      changedSince: 1,
      changedBlocks: anchors.slice(0, 3).map(({ block }) => ({ blockId: block.id, revision: 2 })),
    },
    fileTexts,
  });
}
