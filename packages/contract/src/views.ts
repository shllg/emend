import { z } from "zod";
import { AgentNoteView } from "./agent-note.ts";
import { DocHeadings, DocTitle, SourceContent } from "./doc.ts";
import { InboxListGroup } from "./groups.ts";
import { LIMITS } from "./limits.ts";
import { IssueRefs, PublishLinks, RepoUrl } from "./links.ts";
import { NeedsYouKind, NewInRevisionSection, WriteupArea } from "./manifest.ts";
import { Placement } from "./placement.ts";
import { PublishRequest, Sha256 } from "./publish.ts";
import { FileFlag, FilePath, FileRole, FileStatus, TopicMeta, TopicSlug } from "./review.ts";
import { ApprovedActiveHours, ApprovedActiveLimit } from "./settings.ts";
import { BlockId, Target } from "./target.ts";
import { CommentBody, Outcome, ThreadState } from "./thread.ts";

export const AGENT_REVIEW_KEY_FEATURE = "agent-review-key";

/** A full commit object id: 40 (SHA-1) or 64 (SHA-256) lowercase hex characters. */
const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
/** What a revision was published against: a commit, `worktree` (uncommitted state) or nothing. */
const revisionHead = z.union([commit, z.literal("worktree")]).nullable();

export const PublishResponse = z.object({
  reviewId: z.uuid(),
  revision: z.int().positive(),
  url: z.url({ protocol: /^https?$/ }).max(LIMITS.pathChars),
  placed: z.int().nonnegative(),
  unplaced: z.int().nonnegative(),
  unrendered: z.array(FilePath).max(LIMITS.filesPerRevision).default([]),
  htmlLooks: z
    .array(z.object({ path: FilePath, look: z.enum(["emend", "custom"]), colorScheme: z.enum(["light"]).optional() }))
    .max(LIMITS.filesPerRevision)
    .optional(),
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
  project: z.string().min(1).max(LIMITS.titleChars).nullable().default(null),
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
  groupId: z.uuid().nullable().default(null),
  pinnedAt: z.iso.datetime().nullable().default(null),
  pinOrder: z.int().nonnegative().nullable().default(null),
  snoozed: z.boolean(),
  snoozedUntil: z.iso.datetime().nullable(),
  activeUntil: z.iso.datetime().nullable(),
  releasedAt: z.iso.datetime().nullable(),
  pickedUpAt: z.iso.datetime().nullable(),
  kind: z.enum(["review", "publish"]),
});
export type InboxItem = z.infer<typeof InboxItem>;
export const RelatedReview = z.object({
  id: z.uuid(),
  role: z.enum(["intent", "code"]),
  title: InboxItem.shape.title,
  state: InboxItem.shape.state,
});
export type RelatedReview = z.infer<typeof RelatedReview>;
export const InboxList = z.object({
  groups: z.array(InboxListGroup).max(LIMITS.groups).default([]),
  approvedActiveHours: ApprovedActiveHours,
  approvedActiveLimit: ApprovedActiveLimit,
  items: z.array(InboxItem).max(LIMITS.inboxItems * (ReviewList.options.length + 1) + LIMITS.pins),
  serverTime: z.iso.datetime(),
});
export type InboxList = z.infer<typeof InboxList>;
/** A revision's number and the head it was published against. */
export const AgentReviewRevision = z.object({ revision: z.int().positive(), head: revisionHead });
export type AgentReviewRevision = z.infer<typeof AgentReviewRevision>;
export const AgentReviewTurn = z.enum(["reviewer", "agent"]);
export type AgentReviewTurn = z.infer<typeof AgentReviewTurn>;
/**
 * One row of the agent's own list: no comments, writeup, docs or other owners' ids.
 * `newest` is the review's newest revision, or null for a review without any revision.
 * `approved` is null while no revision is approved, else the approved revision.
 * On an open review, `turn` is `agent` when a Send that is not set aside was made on the newest
 * revision, else `reviewer`. It is null when approved, settled or without a revision. The default
 * lets clients read lists from older servers or hubs that omit `turn`.
 */
export const AgentReviewItem = z.object({
  id: z.uuid(),
  title: PublishRequest.shape.title,
  branch: PublishRequest.shape.branch,
  state: ReviewState,
  turn: AgentReviewTurn.nullable().default(null),
  newest: AgentReviewRevision.nullable(),
  approved: AgentReviewRevision.nullable(),
  updatedAt: z.iso.datetime(),
  url: z.url({ protocol: /^https?$/ }).max(LIMITS.pathChars),
});
export type AgentReviewItem = z.infer<typeof AgentReviewItem>;
export const AgentReviewList = z.object({ items: z.array(AgentReviewItem).max(LIMITS.agentReviews) });
export type AgentReviewList = z.infer<typeof AgentReviewList>;
/**
 * Query of `GET /api/v1/agent/reviews`: `head` is a full commit object id, no prefix or `worktree`.
 * `key` is a stored review key: 64 lowercase hex characters, the `reviewKey` emend publish sends.
 */
export const AgentReviewQuery = z.object({ head: commit.optional(), key: Sha256.optional() });
export type AgentReviewQuery = z.infer<typeof AgentReviewQuery>;
export const ReviewView = InboxItem.extend({
  related: z
    .array(RelatedReview)
    .max(LIMITS.relatedReviews + 1)
    .default([]),
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
  z.enum([
    "overview",
    "tldr",
    "whyItMatters",
    "newInRevision",
    "needsYou",
    "review",
    "checked",
    "notChecked",
    "outOfScope",
    "whereToLook",
    "context",
    "deviations",
    "decisions",
    "glossary",
  ]),
  z.templateLiteral(["t-", TopicSlug, "-", z.enum(["why", "example", "body"])]),
]);

/** Wire representation of core's server-rendered Markdown blocks. */
export const RenderedBlock = z.object({
  id: BlockId,
  section: z.union([sectionKey, z.string().regex(/^doc-[0-9a-f]{8}$/)]),
  kind: z.enum(["heading", "paragraph", "item", "code", "table", "quote", "diagram", "chart"]),
  html: renderedText,
  text: renderedText,
  source: renderedText.optional(),
});
export type RenderedBlock = z.infer<typeof RenderedBlock>;
export const GlossaryTerm = z.object({
  term: z.string().min(1).max(LIMITS.glossaryTermChars),
  definition: z.string().max(LIMITS.glossaryDefinitionChars),
  blockId: BlockId,
});
export type GlossaryTerm = z.infer<typeof GlossaryTerm>;
export const RenderedWriteup = z
  .object({
    area: WriteupArea.optional().catch(undefined),
    newInRevision: z
      .array(
        z.object({
          topic: TopicSlug.optional(),
          section: NewInRevisionSection.optional(),
          blockId: BlockId.refine((id) => !id.startsWith("newInRevision-") && !id.startsWith("doc-")).optional(),
          blockIds: z.array(BlockId.refine((id) => id.startsWith("newInRevision-"))).max(LIMITS.blocksPerRevision),
        }),
      )
      .min(1)
      .max(LIMITS.newInRevisionItems)
      .optional()
      .catch(undefined),
    needsYou: z
      .array(
        z.object({
          kind: NeedsYouKind,
          topic: TopicSlug.optional(),
          blockIds: z.array(BlockId.refine((id) => id.startsWith("needsYou-"))).max(LIMITS.blocksPerRevision),
        }),
      )
      .max(LIMITS.needsYouItems)
      .optional()
      .catch(undefined),
    terms: z.array(GlossaryTerm).max(LIMITS.glossaryTerms).optional(),
    sections: z
      .array(
        z.object({
          key: sectionKey,
          label: z.string().max(LIMITS.titleChars + " — Example".length),
          topic: TopicSlug.nullable(),
          blocks: z.array(RenderedBlock).max(LIMITS.blocksPerRevision),
        }),
      )
      .max(13 + 3 * LIMITS.topicsPerReview),
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
    counts: z
      .object({
        additions: z.int().min(0).max(LIMITS.diffSideBytes),
        deletions: z.int().min(0).max(LIMITS.diffSideBytes),
      })
      .optional(),
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
export const HtmlDocChanges = z
  .object({
    parts: z.int().nonnegative().max(LIMITS.htmlPartsPerDoc),
    marks: z
      .array(z.object({ index: z.int().nonnegative(), revision: z.int().positive() }))
      .max(LIMITS.htmlPartsPerDoc),
  })
  .refine(
    ({ parts, marks }) =>
      marks.every((mark, index) => mark.index < parts && mark.index > (marks[index - 1]?.index ?? -1)),
    "mark indexes must be within parts and strictly increasing",
  );
export type HtmlDocChanges = z.infer<typeof HtmlDocChanges>;

export const RevisionView = z
  .object({
    seq: z.int().positive(),
    base: commit.nullable(),
    head: revisionHead,
    main: z.union([z.literal("writeup"), FilePath]).nullable(),
    writeupEmpty: z.boolean(),
    topics: z.array(TopicMeta).max(LIMITS.topicsPerReview + 1),
    files: z.array(FileView).max(LIMITS.filesPerRevision),
    writeup: RenderedWriteup,
    // Absent on revisions published before these fields existed.
    links: PublishLinks.optional(),
    issueRefs: IssueRefs.optional(),
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
            terms: z.array(GlossaryTerm).max(LIMITS.glossaryTerms).optional(),
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
            // Absent on revisions published before parts were stored.
            changes: HtmlDocChanges.optional(),
            images: z.array(FilePath).max(LIMITS.filesPerRevision).optional(),
            look: z.enum(["emend", "custom"]).optional(),
            colorScheme: z.enum(["light"]).optional(),
            title: DocTitle.optional(),
            headings: DocHeadings.optional(),
          }),
        ]),
      )
      .max(LIMITS.filesPerRevision),
    threads: z.array(ThreadView),
    changedSince: z.int().positive().optional(),
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
