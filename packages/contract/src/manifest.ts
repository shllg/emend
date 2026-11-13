import { z } from "zod";
import { AgentNotes, validateAgentNotes } from "./agent-note.ts";
import { DocTitle, DocView, docViewOf, validateDocView } from "./doc.ts";
import { LIMITS } from "./limits.ts";
import { PublishLinks, RepoUrl } from "./links.ts";
import { FilePath, OTHER_TOPIC, TopicMeta, TopicSlug } from "./review.ts";

const encoder = new TextEncoder();
const markdown = z
  .string()
  .refine(
    (text) => encoder.encode(text).byteLength <= LIMITS.writeupSectionBytes,
    "writeup section exceeds the UTF-8 byte limit",
  );

const normalizeGlossaryForm = (text: string) => text.normalize("NFC").replace(/\s+/gu, " ").trim();
const glossaryForm = z
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
  term: glossaryForm,
  definition: z
    .string()
    .min(1)
    .max(LIMITS.glossaryDefinitionChars)
    .refine((text) => /\S/.test(text), "glossary definition must not be blank"),
  aliases: z.array(glossaryForm).max(LIMITS.glossaryAliases).optional(),
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

const writeupInput = z.object({
  overview: markdown,
  tldr: markdown,
  outOfScope: markdown.optional(),
  whereToLook: markdown.optional(),
  context: markdown.optional(),
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
  return [
    writeup.overview,
    writeup.tldr,
    writeup.outOfScope,
    writeup.whereToLook,
    writeup.context,
    writeup.decisions,
    ...(Array.isArray(writeup.glossary)
      ? writeup.glossary.flatMap((entry) => [entry.term, entry.definition, ...(entry.aliases ?? [])])
      : [writeup.glossary]),
    ...Object.values(writeup.topics).flatMap((topic) => [topic.why, topic.example, topic.body]),
  ];
}

const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a full commit hash");
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
          })
          .superRefine(validateDocView)
          .refine((file) => file.role === "doc" || file.title === undefined, {
            path: ["title"],
            message: "only doc files have titles",
          })
          .refine((file) => file.role === "diff" || file.notes === undefined, {
            path: ["notes"],
            message: "only diff files have agent notes",
          }),
      )
      .max(LIMITS.filesPerRevision),
    media: z
      .array(z.object({ path: FilePath, source: source.optional() }))
      .max(LIMITS.mediaPerRevision)
      .optional(),
    writeup: WriteupInput,
    links: PublishLinks.optional(),
    // null opts out of the address the CLI derives from the remote. A string that is not
    // https://host/owner/name is dropped, and the CLI derives one instead.
    repoUrl: RepoUrl.nullable().optional().catch(undefined),
  })
  .superRefine((manifest, ctx) => {
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
