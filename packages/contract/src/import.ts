import { z } from "zod";
import { AgentNoteView, validateAgentNotes } from "./agent-note.ts";
import { DocTitle, DocView, isRenderedHtmlDoc, validateDocView } from "./doc.ts";
import { indexImportBundle } from "./import-index.ts";
import { LIMITS } from "./limits.ts";
import { PublishRequest, Sha256 } from "./publish.ts";
import { FileFlag, FilePath, FileRole, FileStatus, TopicMeta, TopicSlug } from "./review.ts";
import { GoMode, SendRequest } from "./send.ts";
import { Target } from "./target.ts";
import { CommentBody, Outcome, ThreadState } from "./thread.ts";

const id = z.uuid();
const time = z.iso.datetime();
const row = { id };
const revisionRow = { ...row, revisionId: id };
const reviewRow = { ...row, reviewId: id };
const dates = { createdAt: time, updatedAt: time };

const ImportRows = z.object({
  review: z.object({
    ...row,
    originInstanceId: id,
    reviewKey: Sha256,
    repo: PublishRequest.shape.repo,
    branch: PublishRequest.shape.branch,
    title: PublishRequest.shape.title,
    state: z.enum(["open", "approved", "settled"]),
    approvedRevision: id.nullable(),
    ...dates,
  }),
  revisions: z
    .array(
      z.object({
        ...reviewRow,
        seq: z.int().positive(),
        base: PublishRequest.shape.base,
        head: PublishRequest.shape.head,
        main: z.union([z.literal("writeup"), FilePath]).nullable(),
        writeupEmpty: z.boolean(),
        createdAt: time,
      }),
    )
    .min(1),
  topics: z.array(TopicMeta.extend(revisionRow)),
  files: z.array(
    z
      .object({
        ...revisionRow,
        path: FilePath,
        oldPath: FilePath.nullable(),
        role: FileRole,
        status: FileStatus.nullable(),
        topicSlug: TopicSlug.nullable(),
        ord: z
          .int()
          .min(0)
          .max(LIMITS.filesPerRevision - 1),
        oldBlob: Sha256.nullable(),
        newBlob: Sha256.nullable(),
        renderedBlob: Sha256.nullable(),
        title: DocTitle.nullable().optional(),
        view: DocView.optional(),
        flag: FileFlag.nullable(),
        parentDocId: id.nullable(),
      })
      .superRefine(validateDocView),
  ),
  docAssets: z.array(z.object({ revisionId: id, docId: id, assetId: id })),
  agentNotes: z
    .array(
      AgentNoteView.safeExtend({
        fileId: id,
        ord: z
          .int()
          .min(0)
          .max(LIMITS.agentNotesPerFile - 1),
      }),
    )
    .max(LIMITS.importRevisions * LIMITS.agentNotesPerRevision)
    .optional(),
  writeups: z.array(z.object({ ...revisionRow, sourceBlob: Sha256, renderedBlob: Sha256 })),
  threads: z.array(z.object({ ...reviewRow, target: Target, state: ThreadState, createdRevisionId: id, ...dates })),
  comments: z.array(
    z
      .object({
        ...reviewRow,
        threadId: id,
        author: z.enum(["user", "agent"]),
        body: CommentBody,
        outcome: Outcome.nullable(),
        sendId: id.nullable(),
        ...dates,
      })
      .refine((c) => (c.author === "user" ? c.outcome === null : c.outcome !== null && c.sendId === null)),
  ),
  sends: z.array(
    z
      .object({
        ...reviewRow,
        revisionId: id,
        kind: z.enum(["go", "approve"]),
        mode: GoMode.nullable(),
        instruction: SendRequest.options[0].shape.instruction.unwrap().nullable(),
        deliveryId: id.nullable(),
        setAsideAt: time.nullable(),
        createdAt: time,
      })
      .refine((s) => (s.kind === "go" ? s.mode !== null : s.mode === null && s.instruction === null)),
  ),
  deliveries: z.array(z.object({ ...reviewRow, leaseUntil: time, confirmedAt: time.nullable(), createdAt: time })),
});
const BundleRows = ImportRows.extend({
  revisions: ImportRows.shape.revisions.max(LIMITS.importRevisions),
  threads: ImportRows.shape.threads.max(LIMITS.importThreads),
  comments: ImportRows.shape.comments.max(LIMITS.importComments),
  sends: ImportRows.shape.sends.max(LIMITS.importSends),
  deliveries: ImportRows.shape.deliveries.max(LIMITS.importDeliveries),
  writeups: ImportRows.shape.writeups.max(LIMITS.importRevisions),
});
export type ImportBundle = z.infer<typeof BundleRows>;
export const ImportBundle = BundleRows.superRefine((bundle, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const all = [
    bundle.review,
    ...bundle.revisions,
    ...bundle.topics,
    ...bundle.files,
    ...(bundle.agentNotes ?? []),
    ...bundle.writeups,
    ...bundle.threads,
    ...bundle.comments,
    ...bundle.sends,
    ...bundle.deliveries,
  ];
  if (new Set(all.map((r) => r.id)).size !== all.length) issue("duplicate row id");
  const index = indexImportBundle(bundle);
  const { revisions, threads, files, sends, deliveries } = index;
  for (const note of bundle.agentNotes ?? [])
    if (files.get(note.fileId)?.role !== "diff") issue("agent note must reference a diff file");
  for (const [fileId, notes] of index.notesByFile) {
    if (notes.length > LIMITS.agentNotesPerFile) issue("too many agent notes in file");
    if (new Set(notes.map((note) => note.ord)).size !== notes.length) issue("duplicate agent note order");
    if (!files.has(fileId)) issue("missing agent note file");
  }
  for (const r of [...bundle.revisions, ...bundle.threads, ...bundle.comments, ...bundle.sends, ...bundle.deliveries])
    if (r.reviewId !== bundle.review.id) issue("foreign review reference");
  for (const r of [...bundle.files, ...bundle.topics, ...bundle.writeups, ...bundle.sends, ...bundle.docAssets])
    if (!revisions.has(r.revisionId)) issue("missing revision");
  for (const t of bundle.threads) if (!revisions.has(t.createdRevisionId)) issue("missing thread creation revision");
  for (const c of bundle.comments) {
    if (!threads.has(c.threadId)) issue("missing comment thread");
    if (c.sendId !== null && (!sends.has(c.sendId) || sends.get(c.sendId)?.kind !== "go")) issue("missing comment Go");
  }
  for (const s of bundle.sends) {
    if (s.deliveryId !== null && !deliveries.has(s.deliveryId)) issue("missing delivery");
    const comments = index.commentsBySend.get(s.id) ?? [];
    if (comments.length > LIMITS.commentsPerHandoff) issue("too many comments in Send");
    if (s.kind === "go" && !comments.length && !s.instruction?.trim()) issue("empty Send");
    for (const c of comments)
      if (
        (revisions.get(threads.get(c.threadId)?.createdRevisionId ?? "")?.row.seq ?? 0) >
        (revisions.get(s.revisionId)?.row.seq ?? 0)
      )
        issue("Send precedes thread");
  }
  for (const d of bundle.deliveries) if (!index.sendsByDelivery.has(d.id)) issue("delivery has no Send");
  if (bundle.review.approvedRevision !== null && !revisions.has(bundle.review.approvedRevision))
    issue("missing approved revision");
  if ((bundle.review.state === "approved") !== (bundle.review.approvedRevision !== null))
    issue("inconsistent approval");
  const unique = (keys: string[]) => {
    if (new Set(keys).size !== keys.length) issue("duplicate relationship");
  };
  unique(bundle.docAssets.map((a) => `${a.docId}:${a.assetId}`));
  for (const a of bundle.docAssets) {
    const doc = files.get(a.docId),
      asset = files.get(a.assetId);
    if (
      doc?.revisionId !== a.revisionId ||
      asset?.revisionId !== a.revisionId ||
      doc?.role !== "doc" ||
      !isRenderedHtmlDoc(doc) ||
      asset?.role !== "asset"
    )
      issue("invalid doc asset association");
  }
  for (const f of bundle.files) {
    const parent = f.parentDocId === null ? undefined : files.get(f.parentDocId);
    if (
      f.parentDocId !== null &&
      (f.role !== "asset" || parent?.role !== "doc" || parent.revisionId !== f.revisionId || !isRenderedHtmlDoc(parent))
    )
      issue("invalid parent doc");
  }
  for (const [offset, revision] of bundle.revisions.entries()) {
    if (revision.seq !== offset + 1) issue("revisions must be complete and in sequence order");
    const rows = revisions.get(revision.id);
    if (!rows) continue;
    validateAgentNotes(
      rows.files.map((file) => ({
        path: file.path,
        topic: file.topicSlug ?? undefined,
        notes: index.notesByFile.get(file.id),
      })),
      ctx,
    );
    unique(rows.files.map((f) => String(f.ord)));
    if (rows.files.length > LIMITS.filesPerRevision) issue("too many files");
    if (rows.topics.length > LIMITS.topicsPerReview + 1) issue("too many topics");
    if (rows.writeups.length !== 1) issue("revision requires one writeup");
  }
});

/** Reuse publish's file, topic, path and writeup validators for each copied revision. */
export function importPublishInput(
  bundle: ImportBundle,
  revisionId: string,
  writeup: unknown,
  meta: { links?: unknown; repoUrl?: unknown } = {},
): unknown {
  const index = indexImportBundle(bundle);
  const rows = index.revisions.get(revisionId);
  const revision = rows?.row;
  const files = [...(rows?.files ?? [])].sort((a, b) => a.ord - b.ord);
  return {
    reviewKey: bundle.review.reviewKey,
    repo: bundle.review.repo,
    branch: bundle.review.branch,
    title: bundle.review.title,
    base: revision?.base,
    head: revision?.head,
    main: revision?.main ?? undefined,
    topics: rows?.topics ?? [],
    writeup,
    links: meta.links,
    repoUrl: meta.repoUrl,
    files: files.map((f) => ({
      ...f,
      status: f.status ?? undefined,
      title: f.title ?? undefined,
      topic: f.topicSlug ?? undefined,
      notes: index.notesByFile.get(f.id)?.toSorted((a, b) => a.ord - b.ord),
      parent: f.parentDocId === null ? undefined : index.files.get(f.parentDocId)?.path,
      assets: isRenderedHtmlDoc(f)
        ? (index.assetsByDoc.get(f.id) ?? []).map((a) => index.files.get(a.assetId)?.path)
        : undefined,
    })),
  };
}
export const ImportResult = z.object({ skipped: z.boolean(), deleted: z.boolean().optional() });
export type ImportResult = z.infer<typeof ImportResult>;
