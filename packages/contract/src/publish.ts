import { z } from "zod";
import { AgentNotes, validateAgentNotes } from "./agent-note.ts";
import { DocTitle, DocView, docViewOf, isRenderedHtmlDoc, validateDocView } from "./doc.ts";
import { LIMITS } from "./limits.ts";
import { PublishLinks, RepoUrl } from "./links.ts";
import { MEDIA_EXTENSIONS, PublishManifest, WriteupInput } from "./manifest.ts";
import { FileFlag, FilePath, FileRole, FileStatus, OTHER_TOPIC, TopicMeta, TopicSlug } from "./review.ts";

export const ASSET_EXTENSIONS = new Set(
  "js mjs css png jpg jpeg gif svg webp avif ico bmp woff woff2 ttf otf mp4 webm ogg mp3 wav m4a".split(" "),
);

// The manifest module defines the set so it can validate `media` without importing this module.
export { MEDIA_EXTENSIONS };

export const Sha256 = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
export const PublishFile = z
  .object({
    path: FilePath,
    title: DocTitle.optional(),
    view: DocView.optional(),
    oldPath: FilePath.nullable(),
    role: FileRole,
    status: FileStatus.optional(),
    topic: TopicSlug.optional(),
    oldBlob: Sha256.nullable(),
    newBlob: Sha256.nullable(),
    flag: FileFlag.nullable(),
    parent: FilePath.optional(),
    assets: z.array(FilePath).max(LIMITS.filesPerRevision).optional(),
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
  });
export type PublishFile = z.infer<typeof PublishFile>;
export const PublishRequest = z
  .object({
    reviewId: z.uuid().optional(),
    reviewKey: Sha256,
    repo: z.object({ key: Sha256, name: z.string().min(1).max(LIMITS.titleChars) }).nullable(),
    branch: z.string().min(1).max(LIMITS.pathChars).nullable(),
    title: PublishManifest.shape.title,
    base: PublishManifest.shape.base.unwrap().nullable(),
    head: PublishManifest.shape.head.unwrap().nullable(),
    main: PublishManifest.shape.main,
    topics: z.array(TopicMeta).max(LIMITS.topicsPerReview + 1),
    writeup: WriteupInput,
    links: PublishLinks.optional(),
    repoUrl: RepoUrl.optional(),
    files: z.array(PublishFile).max(LIMITS.filesPerRevision),
  })
  .superRefine((request, ctx) => {
    validateAgentNotes(request.files, ctx);
    if (
      request.main !== undefined &&
      request.main !== "writeup" &&
      !request.files.some((file) => file.role === "doc" && file.path === request.main)
    ) {
      ctx.addIssue({ code: "custom", path: ["main"], message: "main is not a doc of this revision" });
    }
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if ((request.base === null) !== (request.head === null)) issue("base and head must be supplied together");
    const topics = new Set(request.topics.map((topic) => topic.slug));
    if (topics.size !== request.topics.length) issue("duplicate topic slug");
    if (request.topics.filter((t) => t.slug !== OTHER_TOPIC.slug).length > LIMITS.topicsPerReview)
      issue("too many topics");
    const other = request.topics.find((t) => t.slug === OTHER_TOPIC.slug);
    if (other && (other.importance !== 100 || other.title !== OTHER_TOPIC.title || request.topics.at(-1) !== other))
      issue("Other changes must rank last");
    const keys = new Set(
      request.files.map(
        (file) =>
          `${file.role === "diff" ? "diff" : file.role === "doc" && docViewOf(file) === "source" ? "source" : "doc"}:${file.path}`,
      ),
    );
    const paths = new Map(
      request.files
        .filter((file) => file.role !== "diff" && !(file.role === "doc" && docViewOf(file) === "source"))
        .map((file) => [file.path, file]),
    );
    if (keys.size !== request.files.length) issue("duplicate file path in namespace");
    const listed = new Set(request.files.flatMap((file) => file.assets ?? []));
    let mediaCount = 0;
    for (const file of request.files) {
      if (file.topic && !topics.has(file.topic)) issue("file topic is not declared");
      if (isRenderedHtmlDoc(file)) {
        if (!file.assets) issue("HTML docs must list their assets");
        const folder = file.path.slice(0, file.path.lastIndexOf("/") + 1);
        if (new Set(file.assets).size !== file.assets?.length) issue("duplicate HTML asset reference");
        for (const path of file.assets ?? [])
          if (paths.get(path)?.role !== "asset" || !path.startsWith(folder))
            issue("HTML assets must be request assets inside the doc folder");
      } else if (file.assets !== undefined) issue("only HTML docs list assets");
      if (file.role === "asset" && file.parent === undefined) {
        // A parentless asset is writeup media.
        if (request.files.some((doc) => doc.role === "doc" && doc.path === file.path))
          issue("media path is already a doc");
        mediaCount++;
        if (
          !MEDIA_EXTENSIONS.has(file.path.split(".").at(-1)?.toLowerCase() ?? "") ||
          file.path.split("/").some((part) => part.startsWith("."))
        )
          issue("media must be a visible image file");
        if (file.path.includes(":")) issue("media path must not contain a colon");
        if (file.topic !== undefined || file.assets !== undefined || file.notes !== undefined)
          issue("media has no topic, assets or notes");
        if (listed.has(file.path)) issue("media is already a doc asset");
      } else if (file.role === "asset") {
        const parent = file.parent ? paths.get(file.parent) : undefined;
        if (!parent || !isRenderedHtmlDoc(parent)) issue("asset parent must be an HTML doc");
        const folder = parent?.path.slice(0, parent.path.lastIndexOf("/") + 1);
        if (
          !ASSET_EXTENSIONS.has(file.path.split(".").at(-1)?.toLowerCase() ?? "") ||
          folder === undefined ||
          !file.path.startsWith(folder) ||
          file.path.split("/").some((part) => part.startsWith("."))
        )
          issue("asset must be a visible allowed file inside its parent folder");
      } else if (file.parent !== undefined) issue("only assets have a parent");
      if (
        file.role !== "diff" &&
        (file.oldBlob !== null || file.oldPath !== null || file.newBlob === null || file.flag !== null)
      )
        issue("docs and assets require one unflagged new blob");
      if (file.flag !== null && (file.oldBlob !== null || file.newBlob !== null)) issue("flagged files have no blobs");
    }
    if (mediaCount > LIMITS.mediaPerRevision) issue("too many media files");
    for (const slug of Object.keys(request.writeup.topics))
      if (!topics.has(slug)) issue("writeup topic is not declared");
    for (const slug of request.writeup.review?.topics ?? [])
      if (!topics.has(slug)) issue("review topic is not declared");
  });
export type PublishRequest = z.infer<typeof PublishRequest>;
