import { z } from "zod";
import { AgentNoteView } from "./agent-note.ts";
import { DocHeadings, DocTitle, SourceContent } from "./doc.ts";
import { LIMITS } from "./limits.ts";
import { PublishLinks, RepoUrl } from "./links.ts";
import { Placement } from "./placement.ts";
import { PublishRequest, Sha256 } from "./publish.ts";
import { FileFlag, FilePath, FileRole, FileStatus, TopicMeta, TopicSlug } from "./review.ts";
import { BlockId, Target } from "./target.ts";
import { CommentBody, Outcome, ThreadState } from "./thread.ts";

export const PublishResponse = z.object({
  reviewId: z.uuid(),
  revision: z.int().positive(),
  url: z.url({ protocol: /^https?$/ }).max(LIMITS.pathChars),
  placed: z.int().nonnegative(),
  unplaced: z.int().nonnegative(),
  unrendered: z.array(FilePath).max(LIMITS.filesPerRevision).default([]),
});
export type PublishResponse = z.infer<typeof PublishResponse>;

export const ReviewState = z.enum(["open", "approved", "settled"]);
export type ReviewState = z.infer<typeof ReviewState>;

export const ReviewList = z.enum(["active", "snoozed", "done"]);
export type ReviewList = z.infer<typeof ReviewList>;

export const InboxItem = z.object({
  id: z.uuid(),
  title: PublishRequest.shape.title,
  origin: z.object({ id: z.uuid(), name: z.string() }),
  repo: Sha256.nullable(),
  branch: PublishRequest.shape.branch,
  state: ReviewState,
  newestRevision: z.int().positive(),
  unsentCount: z.int().nonnegative(),
  openThreads: z.int().nonnegative(),
  agentWaiting: z.boolean(),
  pendingSend: z.boolean(),
  updatedAt: z.iso.datetime(),
  movedTo: z.url({ protocol: /^https?$/ }).nullable(),
  list: ReviewList,
  snoozed: z.boolean(),
  snoozedUntil: z.iso.datetime().nullable(),
  releasedAt: z.iso.datetime().nullable(),
  pickedUpAt: z.iso.datetime().nullable(),
  kind: z.enum(["review", "publish"]),
});
export type InboxItem = z.infer<typeof InboxItem>;
export const InboxList = z.object({ items: z.array(InboxItem).max(LIMITS.inboxItems * ReviewList.options.length) });
export type InboxList = z.infer<typeof InboxList>;
/** One row of the agent's own list: no comments, writeup, docs or other owners' ids. */
export const AgentReviewItem = z.object({
  id: z.uuid(),
  title: PublishRequest.shape.title,
  state: ReviewState,
  updatedAt: z.iso.datetime(),
  url: z.url({ protocol: /^https?$/ }).max(LIMITS.pathChars),
});
export type AgentReviewItem = z.infer<typeof AgentReviewItem>;
export const AgentReviewList = z.object({ items: z.array(AgentReviewItem).max(LIMITS.agentReviews) });
export type AgentReviewList = z.infer<typeof AgentReviewList>;
export const ReviewView = InboxItem.extend({
  importedAt: z.iso.datetime().nullable().default(null),
  revisions: z.array(z.object({ seq: z.int().positive(), createdAt: z.iso.datetime() })),
});
export type ReviewView = z.infer<typeof ReviewView>;

const encoder = new TextEncoder();
const renderedText = z
  .string()
  .max(LIMITS.renderedBytesPerRevision)
  .refine(
    (text) =>
      text.length <= LIMITS.renderedBytesPerRevision &&
      encoder.encode(text).byteLength <= LIMITS.renderedBytesPerRevision,
    "rendered text exceeds the UTF-8 byte budget",
  );
const renderedBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const sectionKey = z.union([
  z.enum(["overview", "tldr", "decisions", "glossary"]),
  z.templateLiteral(["t-", TopicSlug, "-", z.enum(["why", "example", "body"])]),
]);

/** Wire representation of core's Block; rendering remains server-only. */
export const RenderedBlock = z.object({
  id: BlockId,
  section: z.union([sectionKey, z.string().regex(/^doc-[0-9a-f]{8}$/)]),
  kind: z.enum(["heading", "paragraph", "item", "code", "table", "quote", "diagram"]),
  html: renderedText,
  text: renderedText,
  source: renderedText.optional(),
});
export type RenderedBlock = z.infer<typeof RenderedBlock>;
export const RenderedWriteup = z
  .object({
    sections: z
      .array(
        z.object({
          key: sectionKey,
          label: z.string().max(LIMITS.titleChars + " — Example".length),
          topic: TopicSlug.nullable(),
          blocks: z.array(RenderedBlock).max(LIMITS.blocksPerRevision),
        }),
      )
      .max(4 + 3 * LIMITS.topicsPerReview),
  })
  .refine(
    (writeup) =>
      writeup.sections.reduce((total, section) => total + section.blocks.length, 0) <= LIMITS.blocksPerRevision,
    "writeup exceeds the rendered block count budget",
  )
  .refine(
    (writeup) => renderedBytes(writeup) <= LIMITS.renderedBytesPerRevision,
    "writeup exceeds the rendered JSON byte budget",
  );
export type RenderedWriteup = z.infer<typeof RenderedWriteup>;
export const FileView = z
  .object({
    view: z.literal("source").optional(),
    id: z.uuid(),
    path: FilePath,
    oldPath: FilePath.nullable(),
    role: FileRole,
    status: FileStatus.nullable(),
    topic: TopicSlug.nullable(),
    order: z
      .int()
      .min(0)
      .max(LIMITS.filesPerRevision - 1),
    mediaType: z.string(),
    flag: FileFlag.nullable(),
    hasOld: z.boolean(),
    hasNew: z.boolean(),
    viewed: z.enum(["viewed", "stale"]).optional(),
    viewedOn: z.int().positive().optional(),
    notes: z.array(AgentNoteView).max(LIMITS.agentNotesPerFile).optional(),
  })
  .refine(
    (file) => file.view === undefined || (file.role === "doc" && file.mediaType === "text/plain"),
    "only source doc rows have a view",
  );
export type FileView = z.infer<typeof FileView>;
export const ThreadView = z.object({
  id: z.uuid(),
  target: Target,
  state: ThreadState,
  placement: Placement,
  createdOn: z.int().positive(),
  comments: z.array(
    z.object({
      id: z.uuid(),
      author: z.enum(["user", "agent"]),
      body: CommentBody,
      // The body as server-rendered, sanitized HTML; null (or absent) means show `body` as plain text.
      html: z.string().nullable().optional(),
      outcome: Outcome.optional(),
      sent: z.boolean(),
      sentOn: z.int().positive().nullable(),
    }),
  ),
});
export type ThreadView = z.infer<typeof ThreadView>;
const contentUrl = z.string().refine((url) => {
  const match = /^\/content\/[A-Za-z0-9_-]+\/(.+)$/.exec(url);
  if (!match?.[1]) return false;
  try {
    const path = match[1].split("/").map(decodeURIComponent).join("/");
    return FilePath.safeParse(path).success && path.split("/").map(encodeURIComponent).join("/") === match[1];
  } catch {
    return false;
  }
}, "expected a percent-encoded content path");
const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const RevisionView = z
  .object({
    seq: z.int().positive(),
    base: commit.nullable(),
    head: z.union([commit, z.literal("worktree")]).nullable(),
    main: z.union([z.literal("writeup"), FilePath]).nullable(),
    writeupEmpty: z.boolean(),
    topics: z.array(TopicMeta).max(LIMITS.topicsPerReview + 1),
    files: z.array(FileView).max(LIMITS.filesPerRevision),
    writeup: RenderedWriteup,
    // Absent on revisions published before these fields existed.
    links: PublishLinks.optional(),
    repoUrl: RepoUrl.nullable().optional(),
    docs: z
      .array(
        z.discriminatedUnion("kind", [
          SourceContent.extend({
            path: FilePath,
            kind: z.literal("source"),
            title: DocTitle.optional(),
            unrendered: z.literal(true).optional(),
          }),
          z.object({
            path: FilePath,
            kind: z.literal("markdown"),
            title: DocTitle.optional(),
            headings: DocHeadings.optional(),
            blocks: z
              .array(RenderedBlock)
              .max(LIMITS.blocksPerRevision)
              .refine(
                (blocks) => renderedBytes(blocks) <= LIMITS.renderedBytesPerRevision,
                "doc exceeds the rendered JSON byte budget",
              ),
          }),
          z.object({
            path: FilePath,
            kind: z.literal("html"),
            contentUrl,
            title: DocTitle.optional(),
            headings: DocHeadings.optional(),
          }),
        ]),
      )
      .max(LIMITS.filesPerRevision),
    threads: z.array(ThreadView),
    changedBlocks: z.array(z.object({ blockId: BlockId, revision: z.int().positive() })),
  })
  .refine(
    (view) =>
      view.writeup.sections.reduce((total, section) => total + section.blocks.length, 0) +
        view.docs.reduce((total, doc) => total + (doc.kind === "markdown" ? doc.blocks.length : 0), 0) <=
      LIMITS.blocksPerRevision,
    "revision exceeds the rendered block count budget",
  )
  .refine((view) => {
    let bytes = renderedBytes(view.writeup);
    for (const doc of view.docs) {
      if (doc.title !== undefined || ("headings" in doc && doc.headings !== undefined))
        bytes += renderedBytes({ title: doc.title, headings: "headings" in doc ? doc.headings : undefined });
      // An empty array also represents an unrendered doc, which has no stored JSON bytes.
      if (doc.kind === "markdown" && doc.blocks.length) bytes += renderedBytes(doc.blocks);
      if (doc.kind === "source" && doc.lines.length)
        bytes += renderedBytes({ language: doc.language, lines: doc.lines });
      if (bytes > LIMITS.renderedBytesPerRevision) return false;
    }
    return bytes <= LIMITS.renderedBytesPerRevision;
  }, "revision exceeds the rendered JSON byte budget");
export type RevisionView = z.infer<typeof RevisionView>;
