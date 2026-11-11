import { randomUUID } from "node:crypto";
import type { DocHeading } from "@emend/contract";
import {
  FileFlag,
  FileRole,
  FileStatus,
  GoMode,
  Outcome,
  PairingPurpose,
  type PlacementLocation,
  type Target,
  ThreadState,
  TokenKind,
  UnplacedReason,
} from "@emend/contract";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  type SQLiteColumn,
  type SQLiteTableExtraConfigValue,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey().$defaultFn(randomUUID);
const ownerId = () =>
  text("owner_id")
    .notNull()
    .references(() => owners.id);
const createdAt = () => integer("created_at").notNull().$defaultFn(Date.now);
const updatedAt = () => integer("updated_at").notNull().$defaultFn(Date.now);
function enumValues<T extends string>(values: readonly T[]): [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error("A database enum must not be empty");
  return [first, ...rest];
}
const owned = (name: string, table: { ownerId: SQLiteColumn; id: SQLiteColumn }) => [
  index(`${name}_owner_idx`).on(table.ownerId),
  unique(`${name}_owner_id_unique`).on(table.ownerId, table.id),
];
const enumCheck = (name: string, column: SQLiteColumn, values: readonly string[]) =>
  check(
    name,
    sql`${column} in (${sql.join(
      values.map((value) => sql.raw(`'${value.replaceAll("'", "''")}'`)),
      sql`, `,
    )})`,
  );

export const owners = sqliteTable("owners", { id: id() });

export const instances = sqliteTable("instances", {
  id: id(),
  name: text("name").notNull(),
  isSelf: integer("is_self", { mode: "boolean" }).notNull().default(false),
  wasSelf: integer("was_self", { mode: "boolean" }).notNull().default(false),
  attachedAt: integer("attached_at"),
  lastSeenAt: integer("last_seen_at"),
});

export const repos = sqliteTable(
  "repos",
  {
    id: id(),
    ownerId: ownerId(),
    key: text("key").notNull(),
    name: text("name").notNull(),
  },
  (t) => [...owned("repos", t), unique("repos_owner_key_unique").on(t.ownerId, t.key)],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: id(),
    ownerId: ownerId(),
    originInstanceId: text("origin_instance_id")
      .notNull()
      .references(() => instances.id),
    reviewKey: text("review_key").notNull(),
    repoId: text("repo_id"),
    project: text("project"),
    branch: text("branch"),
    title: text("title").notNull(),
    state: text("state", { enum: ["open", "approved", "settled"] })
      .notNull()
      .default("open"),
    approvedRevision: text("approved_revision"),
    approvedAt: integer("approved_at"),
    movedToUrl: text("moved_to_url"),
    importedAt: integer("imported_at"),
    // A snooze is in effect while snoozed_at is set and snoozed_until is null or in the future.
    snoozedAt: integer("snoozed_at"),
    snoozedUntil: integer("snoozed_until"),
    // The last time a take returned closed, so emend ended an agent's wait.
    releasedAt: integer("released_at"),
    releasedReason: text("released_reason", { enum: ["snoozed", "retired"] }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    ...owned("reviews", t),
    index("reviews_owner_state_updated_idx").on(t.ownerId, t.state, t.updatedAt),
    enumCheck("reviews_released_reason_check", t.releasedReason, ["snoozed", "retired"]),
    unique("reviews_owner_origin_key_unique").on(t.ownerId, t.originInstanceId, t.reviewKey),
    foreignKey({ columns: [t.ownerId, t.repoId], foreignColumns: [repos.ownerId, repos.id] }),
    foreignKey({
      columns: [t.ownerId, t.id, t.approvedRevision],
      foreignColumns: [revisions.ownerId, revisions.reviewId, revisions.id],
    }),
    enumCheck("reviews_state_check", t.state, ["open", "approved", "settled"]),
  ],
);

/** A deleted review's id, so a repeated attach cannot copy it back. No content, key or origin is kept. */
export const reviewTombstones = sqliteTable(
  "review_tombstones",
  {
    ownerId: ownerId(),
    reviewId: text("review_id").notNull(),
    deletedAt: integer("deleted_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.reviewId] }), index("review_tombstones_owner_idx").on(t.ownerId)],
);

export const revisions = sqliteTable(
  "revisions",
  {
    id: id(),
    ownerId: ownerId(),
    reviewId: text("review_id").notNull(),
    seq: integer("seq").notNull(),
    base: text("base"),
    head: text("head"),
    main: text("main"),
    writeupEmpty: integer("writeup_empty", { mode: "boolean" }).notNull().default(sql`0`),
    contentKey: text("content_key").notNull(),
    createdAt: createdAt(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    ...owned("revisions", t),
    unique("revisions_review_seq_unique").on(t.reviewId, t.seq),
    uniqueIndex("revisions_content_key_unique").on(t.contentKey),
    unique("revisions_owner_review_id_unique").on(t.ownerId, t.reviewId, t.id),
    foreignKey({ columns: [t.ownerId, t.reviewId], foreignColumns: [reviews.ownerId, reviews.id] }),
    check("revisions_seq_positive", sql`${t.seq} > 0`),
  ],
);

export const agentWaiters = sqliteTable(
  "agent_waiters",
  {
    id: id(),
    ownerId: ownerId(),
    reviewId: text("review_id").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    ...owned("agent_waiters", t),
    index("agent_waiters_owner_review_expiry_idx").on(t.ownerId, t.reviewId, t.expiresAt),
    foreignKey({ columns: [t.ownerId, t.reviewId], foreignColumns: [reviews.ownerId, reviews.id] }),
  ],
);

export const blobs = sqliteTable(
  "blobs",
  {
    ownerId: ownerId(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    mediaType: text("media_type").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.sha256] }),
    index("blobs_owner_idx").on(t.ownerId),
    index("blobs_sha256_idx").on(t.sha256),
    check("blobs_size_nonnegative", sql`${t.size} >= 0`),
  ],
);

export const topics = sqliteTable(
  "topics",
  {
    id: id(),
    ownerId: ownerId(),
    revisionId: text("revision_id").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    importance: real("importance").notNull(),
    summary: text("summary").notNull(),
    attention: text("attention", { enum: ["critical", "review", "skim"] }),
    door: text("door", { enum: ["one-way", "two-way"] }),
    blastScope: text("blast_scope"),
    blastNote: text("blast_note"),
  },
  (t) => [
    ...owned("topics", t),
    unique("topics_owner_revision_slug_unique").on(t.ownerId, t.revisionId, t.slug),
    foreignKey({ columns: [t.ownerId, t.revisionId], foreignColumns: [revisions.ownerId, revisions.id] }),
    enumCheck("topics_door_check", t.door, ["one-way", "two-way"]),
    enumCheck("topics_attention_check", t.attention, ["critical", "review", "skim"]),
    check("topics_importance_range", sql`${t.importance} between 0 and 100`),
  ],
);

export const files = sqliteTable(
  "files",
  {
    id: id(),
    ownerId: ownerId(),
    revisionId: text("revision_id").notNull(),
    path: text("path").notNull(),
    oldPath: text("old_path"),
    role: text("role", { enum: enumValues(FileRole.options) }).notNull(),
    status: text("status", { enum: enumValues(FileStatus.options) }),
    topicSlug: text("topic_slug"),
    ord: integer("ord").notNull(),
    mediaType: text("media_type").notNull(),
    oldBlob: text("old_blob"),
    newBlob: text("new_blob"),
    renderedBlob: text("rendered_blob"),
    title: text("title"),
    headings: text("headings", { mode: "json" }).$type<DocHeading[]>(),
    flag: text("flag", { enum: enumValues(FileFlag.options) }),
    parentDocId: text("parent_doc_id"),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    ...owned("files", t),
    index("files_owner_revision_path_idx").on(t.ownerId, t.revisionId, t.path),
    index("files_owner_old_blob_idx").on(t.ownerId, t.oldBlob),
    index("files_owner_new_blob_idx").on(t.ownerId, t.newBlob),
    index("files_owner_rendered_blob_idx").on(t.ownerId, t.renderedBlob),
    unique("files_owner_revision_id_unique").on(t.ownerId, t.revisionId, t.id),
    foreignKey({ columns: [t.ownerId, t.revisionId], foreignColumns: [revisions.ownerId, revisions.id] }),
    foreignKey({
      columns: [t.ownerId, t.revisionId, t.topicSlug],
      foreignColumns: [topics.ownerId, topics.revisionId, topics.slug],
    }),
    foreignKey({
      columns: [t.ownerId, t.revisionId, t.parentDocId],
      foreignColumns: [files.ownerId, files.revisionId, files.id],
    }),
    ...[t.oldBlob, t.newBlob, t.renderedBlob].map((blob) =>
      foreignKey({ columns: [t.ownerId, blob], foreignColumns: [blobs.ownerId, blobs.sha256] }),
    ),
    enumCheck("files_role_check", t.role, FileRole.options),
    enumCheck("files_status_check", t.status, FileStatus.options),
    enumCheck("files_flag_check", t.flag, FileFlag.options),
  ],
);

export const agentNotes = sqliteTable(
  "agent_notes",
  {
    id: id(),
    ownerId: ownerId(),
    fileId: text("file_id").notNull(),
    side: text("side", { enum: ["old", "new"] }).notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    summary: text("summary").notNull(),
    rationale: text("rationale"),
    ref: text("ref"),
    ord: integer("ord").notNull(),
  },
  (t) => [
    ...owned("agent_notes", t),
    unique("agent_notes_owner_file_ord_unique").on(t.ownerId, t.fileId, t.ord),
    foreignKey({ columns: [t.ownerId, t.fileId], foreignColumns: [files.ownerId, files.id] }),
    enumCheck("agent_notes_side_check", t.side, ["old", "new"]),
    check("agent_notes_range_check", sql`${t.startLine} >= 1 and ${t.endLine} >= ${t.startLine}`),
    check("agent_notes_ord_check", sql`${t.ord} between 0 and 7`),
  ],
);

export const viewedFiles = sqliteTable(
  "viewed_files",
  {
    id: id(),
    ownerId: ownerId(),
    reviewId: text("review_id").notNull(),
    path: text("path").notNull(),
    revisionSeq: integer("revision_seq").notNull(),
    oldBlob: text("old_blob"),
    newBlob: text("new_blob"),
    createdAt: createdAt(),
  },
  (t) => [
    ...owned("viewed_files", t),
    unique("viewed_files_owner_review_path_unique").on(t.ownerId, t.reviewId, t.path),
    index("viewed_files_owner_old_blob_idx").on(t.ownerId, t.oldBlob),
    index("viewed_files_owner_new_blob_idx").on(t.ownerId, t.newBlob),
    foreignKey({ columns: [t.ownerId, t.reviewId], foreignColumns: [reviews.ownerId, reviews.id] }),
    ...[t.oldBlob, t.newBlob].map((blob) =>
      foreignKey({ columns: [t.ownerId, blob], foreignColumns: [blobs.ownerId, blobs.sha256] }),
    ),
    check("viewed_files_revision_seq_positive", sql`${t.revisionSeq} > 0`),
  ],
);

export const docAssets = sqliteTable(
  "doc_assets",
  {
    ownerId: ownerId(),
    revisionId: text("revision_id").notNull(),
    docId: text("doc_id").notNull(),
    assetId: text("asset_id").notNull(),
  },
  (t) => [
    index("doc_assets_owner_idx").on(t.ownerId),
    unique("doc_assets_owner_doc_asset_unique").on(t.ownerId, t.docId, t.assetId),
    ...[t.docId, t.assetId].map((fileId) =>
      foreignKey({
        columns: [t.ownerId, t.revisionId, fileId],
        foreignColumns: [files.ownerId, files.revisionId, files.id],
      }),
    ),
  ],
);

export const writeups = sqliteTable(
  "writeups",
  {
    id: id(),
    ownerId: ownerId(),
    revisionId: text("revision_id").notNull(),
    sourceBlob: text("source_blob").notNull(),
    renderedBlob: text("rendered_blob").notNull(),
  },
  (t) => [
    ...owned("writeups", t),
    unique("writeups_revision_unique").on(t.revisionId),
    index("writeups_owner_source_blob_idx").on(t.ownerId, t.sourceBlob),
    index("writeups_owner_rendered_blob_idx").on(t.ownerId, t.renderedBlob),
    foreignKey({ columns: [t.ownerId, t.revisionId], foreignColumns: [revisions.ownerId, revisions.id] }),
    ...[t.sourceBlob, t.renderedBlob].map((blob) =>
      foreignKey({ columns: [t.ownerId, blob], foreignColumns: [blobs.ownerId, blobs.sha256] }),
    ),
  ],
);

export const changedBlocks = sqliteTable(
  "changed_blocks",
  {
    id: id(),
    ownerId: ownerId(),
    revisionId: text("revision_id").notNull(),
    blockId: text("block_id").notNull(),
  },
  (t) => [
    ...owned("changed_blocks", t),
    unique("changed_blocks_revision_block_unique").on(t.revisionId, t.blockId),
    foreignKey({ columns: [t.ownerId, t.revisionId], foreignColumns: [revisions.ownerId, revisions.id] }),
  ],
);

export const threads = sqliteTable(
  "threads",
  {
    id: id(),
    ownerId: ownerId(),
    reviewId: text("review_id").notNull(),
    target: text("target", { mode: "json" }).$type<Target>().notNull(),
    state: text("state", { enum: enumValues(ThreadState.options) })
      .notNull()
      .default("open"),
    createdRevisionId: text("created_revision_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...owned("threads", t),
    unique("threads_owner_review_id_unique").on(t.ownerId, t.reviewId, t.id),
    foreignKey({ columns: [t.ownerId, t.reviewId], foreignColumns: [reviews.ownerId, reviews.id] }),
    foreignKey({
      columns: [t.ownerId, t.reviewId, t.createdRevisionId],
      foreignColumns: [revisions.ownerId, revisions.reviewId, revisions.id],
    }),
    enumCheck("threads_state_check", t.state, ThreadState.options),
  ],
);

export const placements = sqliteTable(
  "placements",
  {
    ownerId: ownerId(),
    reviewId: text("review_id").notNull(),
    threadId: text("thread_id").notNull(),
    revisionId: text("revision_id").notNull(),
    status: text("status", { enum: ["placed", "unplaced"] }).notNull(),
    location: text("location", { mode: "json" }).$type<PlacementLocation>(),
    carried: text("carried", { mode: "json" }).$type<{ path: string | null; side?: "old" | "new" }>(),
    reason: text("reason", { enum: enumValues(UnplacedReason.options) }),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.revisionId] }),
    index("placements_owner_idx").on(t.ownerId),
    foreignKey({
      columns: [t.ownerId, t.reviewId, t.threadId],
      foreignColumns: [threads.ownerId, threads.reviewId, threads.id],
    }),
    foreignKey({
      columns: [t.ownerId, t.reviewId, t.revisionId],
      foreignColumns: [revisions.ownerId, revisions.reviewId, revisions.id],
    }),
    enumCheck("placements_status_check", t.status, ["placed", "unplaced"]),
    // not-placed describes an absent row in an API response, never a stored placement.
    enumCheck(
      "placements_reason_check",
      t.reason,
      UnplacedReason.options.filter((reason) => reason !== "not-placed"),
    ),
    check(
      "placements_shape_check",
      sql`(${t.status} = 'placed' and ${t.location} is not null and ${t.reason} is null) or (${t.status} = 'unplaced' and ${t.location} is null and ${t.reason} is not null)`,
    ),
  ],
);

export const deliveries = sqliteTable(
  "deliveries",
  {
    id: id(),
    ownerId: ownerId(),
    reviewId: text("review_id").notNull(),
    leaseUntil: integer("lease_until").notNull(),
    confirmedAt: integer("confirmed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    ...owned("deliveries", t),
    unique("deliveries_owner_review_id_unique").on(t.ownerId, t.reviewId, t.id),
    foreignKey({ columns: [t.ownerId, t.reviewId], foreignColumns: [reviews.ownerId, reviews.id] }),
  ],
);

export const sends = sqliteTable(
  "sends",
  {
    id: id(),
    ownerId: ownerId(),
    reviewId: text("review_id").notNull(),
    revisionId: text("revision_id").notNull(),
    kind: text("kind", { enum: ["go", "approve"] }).notNull(),
    mode: text("mode", { enum: enumValues(GoMode.options) }),
    instruction: text("instruction"),
    deliveryId: text("delivery_id"),
    setAsideAt: integer("set_aside_at"),
    createdAt: createdAt(),
  },
  (t) => [
    ...owned("sends", t),
    unique("sends_owner_review_id_unique").on(t.ownerId, t.reviewId, t.id),
    foreignKey({ columns: [t.ownerId, t.reviewId], foreignColumns: [reviews.ownerId, reviews.id] }),
    foreignKey({
      columns: [t.ownerId, t.reviewId, t.revisionId],
      foreignColumns: [revisions.ownerId, revisions.reviewId, revisions.id],
    }),
    foreignKey({
      columns: [t.ownerId, t.reviewId, t.deliveryId],
      foreignColumns: [deliveries.ownerId, deliveries.reviewId, deliveries.id],
    }),
    enumCheck("sends_kind_check", t.kind, ["go", "approve"]),
    enumCheck("sends_mode_check", t.mode, GoMode.options),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: id(),
    ownerId: ownerId(),
    reviewId: text("review_id").notNull(),
    threadId: text("thread_id").notNull(),
    author: text("author", { enum: ["user", "agent"] }).notNull(),
    body: text("body").notNull(),
    outcome: text("outcome", { enum: enumValues(Outcome.options) }),
    sendId: text("send_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...owned("comments", t),
    index("comments_owner_review_thread_idx").on(t.ownerId, t.reviewId, t.threadId),
    index("comments_owner_review_send_idx").on(t.ownerId, t.reviewId, t.sendId),
    foreignKey({
      columns: [t.ownerId, t.reviewId, t.threadId],
      foreignColumns: [threads.ownerId, threads.reviewId, threads.id],
    }),
    foreignKey({
      columns: [t.ownerId, t.reviewId, t.sendId],
      foreignColumns: [sends.ownerId, sends.reviewId, sends.id],
    }),
    enumCheck("comments_author_check", t.author, ["user", "agent"]),
    enumCheck("comments_outcome_check", t.outcome, Outcome.options),
  ],
);

export const devices = sqliteTable(
  "devices",
  {
    id: id(),
    ownerId: ownerId(),
    kind: text("kind", { enum: ["browser", "machine"] }).notNull(),
    name: text("name").notNull(),
    instanceId: text("instance_id").references(() => instances.id),
    createdAt: createdAt(),
    lastSeenAt: integer("last_seen_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [...owned("devices", t), enumCheck("devices_kind_check", t.kind, ["browser", "machine"])],
);

export const tokens = sqliteTable(
  "tokens",
  {
    id: id(),
    ownerId: ownerId(),
    kind: text("kind", { enum: enumValues(TokenKind.options) }).notNull(),
    instanceId: text("instance_id").references(() => instances.id),
    deviceId: text("device_id"),
    name: text("name").notNull(),
    secretHash: text("secret_hash").notNull(),
    expiresAt: integer("expires_at"),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    ...owned("tokens", t),
    unique("tokens_secret_hash_unique").on(t.secretHash),
    foreignKey({ columns: [t.ownerId, t.deviceId], foreignColumns: [devices.ownerId, devices.id] }),
    enumCheck("tokens_kind_check", t.kind, TokenKind.options),
    check("tokens_agent_instance_check", sql`${t.kind} != 'agent' or ${t.instanceId} is not null`),
  ],
);

export const pairings = sqliteTable(
  "pairings",
  {
    id: id(),
    ownerId: ownerId(),
    purpose: text("purpose", { enum: enumValues(PairingPurpose.options) })
      .notNull()
      .default("device"),
    secretHash: text("secret_hash").notNull(),
    codeHash: text("code_hash").notNull(),
    createdBy: text("created_by").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
  },
  (t) => [
    ...owned("pairings", t),
    enumCheck("pairings_purpose_check", t.purpose, PairingPurpose.options),
    unique("pairings_secret_hash_unique").on(t.secretHash),
    foreignKey({ columns: [t.ownerId, t.createdBy], foreignColumns: [tokens.ownerId, tokens.id] }),
  ],
);
