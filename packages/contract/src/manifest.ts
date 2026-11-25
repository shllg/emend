import { z } from "zod";
import { AgentNotes, validateAgentNotes } from "./agent-note.ts";
import { DocTitle, DocView, docViewOf, validateDocView } from "./doc.ts";
import { LIMITS } from "./limits.ts";
import { ManifestIssueRefs, PublishLinks, RepoUrl } from "./links.ts";
import { FileFlag, FilePath, FileStatus, OTHER_TOPIC, TopicMeta, TopicSlug } from "./review.ts";

const encoder = new TextEncoder();
const markdown = z
  .string()
  .refine(
    (text) => encoder.encode(text).byteLength <= LIMITS.writeupSectionBytes,
    "writeup section exceeds the UTF-8 byte limit",
  );
const nonBlankMarkdown = markdown.refine((text) => /\S/.test(text), "must not be blank");

/** Accepted from older agents; shape and size are checked, never topic agreement, and it is never shown. */
export const ReviewVerdict = z
  .object({
    level: z.enum(["skim", "topics", "everything"]),
    topics: z.array(TopicSlug).min(1).max(LIMITS.topicsPerReview).optional(),
    reason: nonBlankMarkdown,
  })
  .superRefine((review, ctx) => {
    if (review.level === "topics" && review.topics === undefined) {
      ctx.addIssue({ code: "custom", path: ["topics"], message: "the topics level names one or more topics" });
    }
    if (review.level !== "topics" && review.topics !== undefined) {
      ctx.addIssue({ code: "custom", path: ["topics"], message: "only the topics level names topics" });
    }
    const seen = new Set<string>();
    for (const [index, slug] of (review.topics ?? []).entries()) {
      if (seen.has(slug)) {
        ctx.addIssue({ code: "custom", path: ["topics", index], message: "duplicate topic slug" });
      }
      seen.add(slug);
    }
  });
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export const normalizeGlossaryForm = (text: string) => text.normalize("NFC").replace(/\s+/gu, " ").trim();
export const GlossaryForm = z
  .string()
  .min(1)
  .max(LIMITS.glossaryTermChars)
  .refine(
    (text) => normalizeGlossaryForm(text).length <= LIMITS.glossaryTermChars,
    "glossary term exceeds the character limit after normalization",
  )
  .refine((text) => /\S/.test(text), "glossary term must not be blank")
  .refine((text) => text.isWellFormed(), "glossary term must be well-formed UTF-16")
  .refine(
    (text) =>
      !Array.from(text).some((char) => {
        const code = char.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
      }),
    "glossary term must not contain control or line-break characters",
  );

export const GlossaryEntry = z.object({
  term: GlossaryForm,
  definition: z
    .string()
    .min(1)
    .max(LIMITS.glossaryDefinitionChars)
    .refine((text) => /\S/.test(text), "glossary definition must not be blank"),
  aliases: z.array(GlossaryForm).max(LIMITS.glossaryAliases).optional(),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntry>;

export const Glossary = z
  .array(GlossaryEntry)
  .max(LIMITS.glossaryTerms)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      for (const [formIndex, form] of [entry.term, ...(entry.aliases ?? [])].entries()) {
        const key = normalizeGlossaryForm(form).toLowerCase();
        if (seen.has(key))
          ctx.addIssue({
            code: "custom",
            path: formIndex === 0 ? [index, "term"] : [index, "aliases", formIndex - 1],
            message: "duplicate glossary term",
          });
        seen.add(key);
      }
    }
  });
export type Glossary = z.infer<typeof Glossary>;

export const WriteupArea = z
  .string()
  .min(1)
  .max(LIMITS.areaChars)
  .refine((text) => /\S/.test(text), "area must not be blank")
  .refine((text) => text.isWellFormed(), "area must be well-formed UTF-16")
  .refine(
    (text) => !/[\p{Cc}\p{Cf}\u2028\u2029\u115f\u1160\u3164\uffa0\u2800]/u.test(text),
    "area must be plain visible text",
  );
export type WriteupArea = z.infer<typeof WriteupArea>;

export const NewInRevisionSection = z.enum([
  "overview",
  "tldr",
  "whyItMatters",
  "checked",
  "notChecked",
  "outOfScope",
  "whereToLook",
  "context",
  "deviations",
  "decisions",
  "glossary",
]);
export type NewInRevisionSection = z.infer<typeof NewInRevisionSection>;

export const NewInRevisionItem = z
  .object({
    text: z
      .string()
      .min(1)
      .max(LIMITS.newInRevisionChars)
      .refine((text) => /\S/.test(text), "newInRevision text must not be blank")
      .refine((text) => text.isWellFormed(), "newInRevision text must be well-formed UTF-16")
      .refine((text) => !/[\r\n\u2028\u2029]/u.test(text), "newInRevision text must be one line"),
    topic: TopicSlug.optional(),
    section: NewInRevisionSection.optional(),
    quote: z
      .string()
      .min(1)
      .max(LIMITS.newInRevisionQuoteChars)
      .refine((quote) => /\S/.test(quote), "newInRevision quote must not be blank")
      .refine((quote) => /[^\s\p{White_Space}*_`]/u.test(quote), "newInRevision quote must contain text")
      .refine((quote) => quote.isWellFormed(), "newInRevision quote must be well-formed UTF-16")
      .refine((quote) => !/[\r\n\u2028\u2029]/u.test(quote), "newInRevision quote must be one line")
      .optional(),
  })
  .refine((item) => item.topic === undefined || item.section === undefined, {
    path: ["section"],
    message: "a newInRevision item names a topic or a section, not both",
  });
export type NewInRevisionItem = z.infer<typeof NewInRevisionItem>;

export const NeedsYouKind = z.enum(["decide", "accept", "confirm-drift", "answer"]);
export type NeedsYouKind = z.infer<typeof NeedsYouKind>;

export const NeedsYouItem = z.object({
  kind: NeedsYouKind,
  text: z
    .string()
    .min(1)
    .max(LIMITS.needsYouChars)
    .refine((text) => /\S/.test(text), "needsYou text must not be blank")
    .refine((text) => text.isWellFormed(), "needsYou text must be well-formed UTF-16")
    .refine((text) => !/[\r\n\u2028\u2029]/u.test(text), "needsYou text must be one line"),
  topic: TopicSlug.optional(),
});
export type NeedsYouItem = z.infer<typeof NeedsYouItem>;

export const CheckedKind = z.enum(["ran", "read", "reasoned"]);
export type CheckedKind = z.infer<typeof CheckedKind>;

export const CheckedItem = z.object({ kind: CheckedKind, text: nonBlankMarkdown });
export type CheckedItem = z.infer<typeof CheckedItem>;

export const CheckedList = z
  .array(CheckedItem)
  .min(1, "at least 1 item")
  .max(LIMITS.checkedItems, `at most ${LIMITS.checkedItems} checked items`)
  .refine(
    (items) =>
      items.reduce((bytes, item) => bytes + encoder.encode(item.text).byteLength, 0) <= LIMITS.writeupSectionBytes,
    "writeup section exceeds the UTF-8 byte limit",
  );
export type CheckedList = z.infer<typeof CheckedList>;

const writeupInput = z.object({
  overview: markdown,
  tldr: markdown,
  whyItMatters: nonBlankMarkdown.optional(),
  newInRevision: z.array(NewInRevisionItem).max(LIMITS.newInRevisionItems, "at most 12 newInRevision items").optional(),
  needsYou: z
    .array(NeedsYouItem)
    .max(LIMITS.needsYouItems, `at most ${LIMITS.needsYouItems} needsYou items`)
    .optional(),
  area: WriteupArea.optional(),
  review: ReviewVerdict.optional(),
  checked: z.union([nonBlankMarkdown, CheckedList]).optional(),
  notChecked: nonBlankMarkdown.optional(),
  outOfScope: markdown.optional(),
  whereToLook: markdown.optional(),
  context: markdown.optional(),
  deviations: nonBlankMarkdown.optional(),
  decisions: markdown.nullable(),
  glossary: z.union([markdown, Glossary]).optional(),
  topics: z
    .record(TopicSlug, z.object({ why: markdown, example: markdown.optional(), body: markdown.optional() }))
    .refine((topics) => Object.keys(topics).length <= LIMITS.topicsPerReview, "too many writeup topics")
    .transform((topics) => Object.assign(Object.create(null) as typeof topics, topics)),
});
export type WriteupInput = z.infer<typeof writeupInput>;

export const WriteupInput = writeupInput.refine((writeup) => {
  return (
    writeupMarkdown(writeup).reduce<number>((bytes, section) => bytes + encoder.encode(section ?? "").byteLength, 0) <=
    LIMITS.writeupBytes
  );
}, "writeup exceeds the total UTF-8 byte limit");

export function writeupMarkdown(writeup: WriteupInput): (string | null | undefined)[] {
  return [...shownWriteupMarkdown(writeup), writeup.review?.reason];
}

/** True when no shown writeup text has non-whitespace content; the hidden verdict reason counts only toward byte limits. */
export function writeupIsEmpty(writeup: WriteupInput): boolean {
  return shownWriteupMarkdown(writeup).every((section) => !section?.trim());
}

function shownWriteupMarkdown(writeup: WriteupInput): (string | null | undefined)[] {
  return [
    writeup.overview,
    writeup.tldr,
    ...(writeup.whyItMatters !== undefined ? [writeup.whyItMatters] : []),
    ...(writeup.newInRevision ?? []).map((item) => item.text),
    ...(writeup.needsYou ?? []).map((item) => item.text),
    ...(Array.isArray(writeup.checked) ? writeup.checked.map((item) => item.text) : [writeup.checked]),
    writeup.notChecked,
    writeup.outOfScope,
    writeup.whereToLook,
    writeup.context,
    writeup.deviations,
    writeup.decisions,
    ...(Array.isArray(writeup.glossary)
      ? writeup.glossary.flatMap((entry) => [entry.term, entry.definition, ...(entry.aliases ?? [])])
      : [writeup.glossary]),
    ...Object.values(writeup.topics).flatMap((topic) => [topic.why, topic.example, topic.body]),
  ];
}

const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a full commit hash");
export const PreparedDoc = z.enum(["included", "deleted", "differs-from-head", "refused"]);
export type PreparedDoc = z.infer<typeof PreparedDoc>;

const lineCount = z.number().int().nonnegative().max(LIMITS.diffSideBytes);
export const PreparedFile = z
  .object({
    status: FileStatus,
    oldPath: FilePath.optional(),
    added: lineCount.optional(),
    removed: lineCount.optional(),
    flag: FileFlag.optional(),
    lockfile: z.literal(true).optional(),
    doc: PreparedDoc.optional(),
    docRefusal: z
      .string()
      .min(1)
      .max(LIMITS.errorMessageChars)
      .regex(/^[^\r\n\v\f\u0085\u2028\u2029]+$/u)
      .optional(),
  })
  .refine((file) => file.docRefusal === undefined || file.doc === "refused", {
    path: ["docRefusal"],
    message: "only a refused doc has a refusal reason",
  });
export type PreparedFile = z.infer<typeof PreparedFile>;

const source = z
  .string()
  .min(1)
  .max(LIMITS.pathChars)
  .refine((path) => path.isWellFormed(), "source must be well-formed UTF-16")
  .refine(
    (path) => !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    "source must not contain control characters",
  );

/** Image types a writeup may embed. No SVG: opened directly it is a scriptable document. */
export const MEDIA_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif"]);

export const PublishManifest = z
  .object({
    version: z.literal(1),
    title: z
      .string()
      .min(1)
      .max(LIMITS.titleChars)
      .refine((title) => /\S/.test(title), "title must not be blank"),
    base: commit.optional(),
    head: z.union([commit, z.literal("worktree")]).optional(),
    main: z.union([z.literal("writeup"), FilePath]).optional(),
    topics: z.array(TopicMeta).max(LIMITS.topicsPerReview),
    files: z
      .array(
        z
          .object({
            path: FilePath,
            role: z.enum(["diff", "doc"]),
            topic: TopicSlug.optional(),
            source: source.optional(),
            title: DocTitle.optional(),
            view: DocView.optional(),
            notes: AgentNotes.optional(),
            prepared: PreparedFile.optional(),
          })
          .superRefine(validateDocView)
          .refine((file) => file.role === "doc" || file.title === undefined, {
            path: ["title"],
            message: "only doc files have titles",
          })
          .refine((file) => file.role === "diff" || file.notes === undefined, {
            path: ["notes"],
            message: "only diff files have agent notes",
          })
          .refine((file) => file.role === "diff" || file.prepared === undefined, {
            path: ["prepared"],
            message: "only diff files have prepared facts",
          })
          .refine((file) => file.prepared?.doc === undefined || docViewOf({ path: file.path }) === "rendered", {
            path: ["prepared", "doc"],
            message: "only Markdown and HTML paths have a prepared doc result",
          }),
      )
      .max(LIMITS.filesPerRevision),
    media: z
      .array(z.object({ path: FilePath, source: source.optional() }))
      .max(LIMITS.mediaPerRevision)
      .optional(),
    writeup: WriteupInput,
    links: PublishLinks.optional(),
    issueRefs: ManifestIssueRefs.optional(),
    intentReview: z.uuid().optional(),
    // null opts out of the address the CLI derives from the remote. A string that is not
    // https://host/owner/name is dropped, and the CLI derives one instead.
    repoUrl: RepoUrl.nullable().optional().catch(undefined),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.intentReview !== undefined && manifest.writeup.deviations === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["writeup", "deviations"],
        message: "deviations is required with intentReview",
      });
    } else if (manifest.writeup.deviations !== undefined && manifest.intentReview === undefined) {
      ctx.addIssue({ code: "custom", path: ["intentReview"], message: "intentReview is required with deviations" });
    }
    validateAgentNotes(manifest.files, ctx);
    if (
      manifest.main !== undefined &&
      manifest.main !== "writeup" &&
      !manifest.files.some((file) => file.role === "doc" && file.path === manifest.main)
    ) {
      ctx.addIssue({ code: "custom", path: ["main"], message: "main is not a doc of this revision" });
    }
    if ((manifest.base === undefined) !== (manifest.head === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [manifest.base === undefined ? "base" : "head"],
        message: "base and head must be supplied together",
      });
    }
    const topics = new Set<string>();
    for (const [index, topic] of manifest.topics.entries()) {
      if (topic.slug === OTHER_TOPIC.slug) {
        ctx.addIssue({ code: "custom", path: ["topics", index, "slug"], message: "topic slug other is reserved" });
      }
      if (topics.has(topic.slug)) {
        ctx.addIssue({ code: "custom", path: ["topics", index, "slug"], message: "duplicate topic slug" });
      }
      topics.add(topic.slug);
    }
    for (const [index, item] of (manifest.writeup.newInRevision ?? []).entries()) {
      if (item.topic !== undefined && !topics.has(item.topic)) {
        ctx.addIssue({
          code: "custom",
          path: ["writeup", "newInRevision", index, "topic"],
          message: "newInRevision topic is not declared",
        });
      }
    }
    for (const [index, item] of (manifest.writeup.needsYou ?? []).entries()) {
      if (item.topic !== undefined && !topics.has(item.topic)) {
        ctx.addIssue({
          code: "custom",
          path: ["writeup", "needsYou", index, "topic"],
          message: "needsYou topic is not declared",
        });
      }
    }
    const paths = new Set<string>();
    for (const [index, file] of manifest.files.entries()) {
      const key = `${file.role}:${file.role === "doc" ? docViewOf(file) : ""}:${file.path}`;
      if (paths.has(key)) {
        ctx.addIssue({ code: "custom", path: ["files", index, "path"], message: "duplicate file path" });
      }
      paths.add(key);
      if (file.topic !== undefined && !topics.has(file.topic)) {
        ctx.addIssue({ code: "custom", path: ["files", index, "topic"], message: "file topic is not declared" });
      }
    }
    const docPaths = new Set(manifest.files.filter((file) => file.role === "doc").map((file) => file.path));
    const mediaPaths = new Set<string>();
    for (const [index, item] of (manifest.media ?? []).entries()) {
      const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["media", index, "path"], message });
      if (!MEDIA_EXTENSIONS.has(item.path.split(".").at(-1)?.toLowerCase() ?? "")) issue("media must be an image file");
      if (item.path.split("/").some((part) => part.startsWith("."))) issue("media path must not be hidden");
      if (item.path.includes(":")) issue("media path must not contain a colon");
      if (mediaPaths.has(item.path)) issue("duplicate media path");
      mediaPaths.add(item.path);
      if (docPaths.has(item.path)) issue("media path is already a doc");
    }
    for (const slug of Object.keys(manifest.writeup.topics)) {
      if (!topics.has(slug)) {
        ctx.addIssue({ code: "custom", path: ["writeup", "topics", slug], message: "writeup topic is not declared" });
      }
    }
  });
export type PublishManifest = z.infer<typeof PublishManifest>;
