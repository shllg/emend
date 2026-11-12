import { randomBytes } from "node:crypto";
import type { ImportBundle } from "@emend/contract";
import { docViewOf } from "@emend/contract";
import { and, eq, type InferInsertModel, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Queries } from "../../db/client.ts";
import * as t from "../../db/schema.ts";
import type { AppDeps } from "../app.ts";
import { machineDevice } from "../auth/machines.ts";
import type { Principal } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";
import { yieldToLoop } from "../pacing.ts";
import { fileMediaType } from "../publish/media.ts";
import { checkImportSignal } from "./lifecycle.ts";
import { prepareImport } from "./prepare.ts";

const idTables = [
  t.reviews,
  t.revisions,
  t.topics,
  t.files,
  t.agentNotes,
  t.writeups,
  t.changedBlocks,
  t.threads,
  t.comments,
  t.sends,
  t.deliveries,
  t.agentWaiters,
  t.repos,
  t.devices,
  t.tokens,
  t.pairings,
  t.instances,
  t.owners,
];
const skipOutcome = (outcome: true | "deleted") =>
  outcome === "deleted" ? { skipped: true, deleted: true } : { skipped: true };
async function preflight(ownerId: string, q: Queries, principal: Principal, bundle: ImportBundle, now: number) {
  await machineDevice(ownerId, q, principal, now);
  if (bundle.review.originInstanceId !== principal.instanceId) throw new ApiError("wrong_origin");
  // A review deleted on the hub stays deleted: a repeated attach must not copy it back.
  const tombstone = await q
    .select({ id: t.reviewTombstones.reviewId })
    .from(t.reviewTombstones)
    .where(and(eq(t.reviewTombstones.ownerId, ownerId), eq(t.reviewTombstones.reviewId, bundle.review.id)))
    .get();
  if (tombstone) return "deleted" as const;
  const existing = await q
    .select({ origin: t.reviews.originInstanceId })
    .from(t.reviews)
    .where(and(eq(t.reviews.ownerId, ownerId), eq(t.reviews.id, bundle.review.id)))
    .get();
  if (existing) {
    if (existing.origin !== principal.instanceId) throw new ApiError("wrong_origin");
    return true;
  }
  // Global primary keys need a collision check, not a foreign-row read. Only the
  // boolean invariant escapes the subquery, with the same refusal for either owner.
  const collision = await q
    .select({ yes: sql<number>`exists(select 1 from ${t.reviews} where ${t.reviews.id} = ${bundle.review.id})` })
    .from(t.owners)
    .where(eq(t.owners.id, ownerId))
    .get();
  if (collision?.yes) throw new ApiError("wrong_origin");
  const key = await q
    .select({ id: t.reviews.id })
    .from(t.reviews)
    .where(
      and(
        eq(t.reviews.ownerId, ownerId),
        eq(t.reviews.originInstanceId, bundle.review.originInstanceId),
        eq(t.reviews.reviewKey, bundle.review.reviewKey),
      ),
    )
    .get();
  if (key) throw new ApiError("invalid_request");
  return false;
}
async function checkIds(ownerId: string, q: Queries, bundle: ImportBundle, signal?: AbortSignal) {
  const ids = [
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
  ].map((r) => r.id);
  for (let offset = 0; offset < ids.length; offset += 500) {
    checkImportSignal(signal);
    const batch = JSON.stringify(ids.slice(offset, offset + 500));
    const probes = sql.join(
      idTables.map((table) => sql`select 1 from ${table} where ${table.id} in (select value from incoming)`),
      sql` union all `,
    );
    const collision = await q
      .select({ yes: sql<number>`exists(with incoming as (select value from json_each(${batch})) ${probes})` })
      .from(t.owners)
      .where(eq(t.owners.id, ownerId))
      .get();
    if (collision?.yes) throw new ApiError("invalid_request");
    await yieldToLoop("import-check-ids");
  }
}

export async function importReview(principal: Principal, bundle: ImportBundle, deps: AppDeps, signal?: AbortSignal) {
  checkImportSignal(signal);
  const { ownerId } = principal;
  const early = await deps.db.read((q) => preflight(ownerId, q, principal, bundle, deps.now()));
  if (early) return skipOutcome(early);
  const prepared = await prepareImport(ownerId, bundle, deps, signal);
  try {
    return await deps.db.transaction(
      async (q) => {
        checkImportSignal(signal);
        async function insert<T extends SQLiteTable, Row>(
          table: T,
          source: Row[],
          mapRow: (row: Row) => InferInsertModel<T>,
          ignoreConflict = false,
        ) {
          for (let offset = 0; offset < source.length; offset += 500) {
            checkImportSignal(signal);
            const statement = q.insert(table).values(source.slice(offset, offset + 500).map(mapRow));
            await (ignoreConflict ? statement.onConflictDoNothing() : statement);
            await yieldToLoop("import-insert");
          }
        }
        const now = deps.now();
        const at = (value: string) => Math.min(Date.parse(value), now);
        const nullableAt = (value: string | null) => (value === null ? null : at(value));
        const again = await preflight(ownerId, q, principal, bundle, deps.now());
        if (again) return skipOutcome(again);
        await checkIds(ownerId, q, bundle, signal);
        const project =
          bundle.review.project ?? (bundle.review.repo?.name === ".git" ? null : (bundle.review.repo?.name ?? null));
        let repoId: string | null = null;
        if (project !== null && bundle.review.repo) {
          await q
            .insert(t.repos)
            .values({ ownerId, ...bundle.review.repo })
            .onConflictDoNothing({ target: [t.repos.ownerId, t.repos.key] });
          const repo = await q
            .select({ id: t.repos.id })
            .from(t.repos)
            .where(and(eq(t.repos.ownerId, ownerId), eq(t.repos.key, bundle.review.repo.key)))
            .get();
          if (!repo) throw new Error("Missing repository");
          repoId = repo.id;
          await yieldToLoop("import-insert");
        }
        await insert(
          t.blobs,
          [...prepared.staged],
          ([sha256, size]) => ({ ownerId, sha256, size, mediaType: "application/json" }),
          true,
        );
        await q.insert(t.reviews).values({
          ...bundle.review,
          ownerId,
          repoId,
          project,
          approvedRevision: null,
          approvedAt: null,
          movedToUrl: null,
          binnedAt: nullableAt(bundle.review.binnedAt ?? null),
          importedAt: deps.now(),
          createdAt: at(bundle.review.createdAt),
          updatedAt: at(bundle.review.updatedAt),
        });
        await yieldToLoop("import-insert");
        await insert(t.revisions, bundle.revisions, (r) => ({
          ...r,
          ownerId,
          writeupEmpty: prepared.empty.get(r.id),
          contentKey: randomBytes(32).toString("base64url"),
          createdAt: at(r.createdAt),
        }));
        await insert(t.topics, bundle.topics, (r) => ({
          ...r,
          ownerId,
          attention: r.attention,
          blastScope: r.blastRadius?.scope,
          blastNote: r.blastRadius?.note,
        }));
        await insert(t.writeups, bundle.writeups, (r) => {
          const rendered = prepared.rendered.get(r.revisionId);
          if (!rendered) throw new Error("Missing rendering");
          return { ...r, ownerId, sourceBlob: rendered.sourceBlob, renderedBlob: rendered.renderedBlob };
        });
        // Parent documents precede assets even across batch boundaries.
        await insert(
          t.files,
          [...bundle.files].sort((a, b) => Number(a.role === "asset") - Number(b.role === "asset")),
          (r) => ({
            ...r,
            ownerId,
            title:
              r.role === "doc"
                ? (prepared.rendered
                    .get(r.revisionId)
                    ?.[docViewOf(r) === "source" ? "sourceMetadata" : "metadata"].get(r.path)?.title ?? null)
                : null,
            headings:
              r.role === "doc"
                ? (prepared.rendered
                    .get(r.revisionId)
                    ?.[docViewOf(r) === "source" ? "sourceMetadata" : "metadata"].get(r.path)?.headings ?? null)
                : null,
            mediaType: fileMediaType(r),
            renderedBlob:
              r.role === "doc"
                ? (prepared.rendered
                    .get(r.revisionId)
                    ?.[docViewOf(r) === "source" ? "sourceBlobs" : "docBlobs"].get(r.path) ?? null)
                : null,
          }),
        );
        await insert(t.agentNotes, bundle.agentNotes ?? [], (note) => ({
          ...note,
          ownerId,
          startLine: note.start,
          endLine: note.end,
        }));
        await insert(t.docAssets, bundle.docAssets, (r) => ({ ...r, ownerId }));
        await insert(t.changedBlocks, prepared.changedBlocks, (r) => ({ ...r, ownerId }));
        await insert(t.threads, bundle.threads, (r) => ({
          ...r,
          ownerId,
          createdAt: at(r.createdAt),
          updatedAt: at(r.updatedAt),
        }));
        await insert(t.placements, prepared.placements, (r) => ({ ...r, ownerId }));
        const confirmed = new Set(bundle.deliveries.filter((d) => d.confirmedAt !== null).map((d) => d.id));
        await insert(
          t.deliveries,
          bundle.deliveries.filter((r) => r.confirmedAt !== null),
          (r) => ({
            ...r,
            ownerId,
            leaseUntil: at(r.leaseUntil),
            confirmedAt: nullableAt(r.confirmedAt),
            createdAt: at(r.createdAt),
          }),
        );
        await insert(t.sends, bundle.sends, (r) => {
          const released = r.deliveryId !== null && !confirmed.has(r.deliveryId);
          return {
            ...r,
            ownerId,
            deliveryId: released ? null : r.deliveryId,
            setAsideAt: released ? null : nullableAt(r.setAsideAt),
            createdAt: at(r.createdAt),
          };
        });
        await insert(t.comments, bundle.comments, (r) => ({
          ...r,
          ownerId,
          createdAt: at(r.createdAt),
          updatedAt: at(r.updatedAt),
        }));
        await q
          .update(t.reviews)
          .set({ approvedRevision: bundle.review.approvedRevision })
          .where(and(eq(t.reviews.ownerId, ownerId), eq(t.reviews.id, bundle.review.id)));
        checkImportSignal(signal);
        return { skipped: false };
      },
      { offThread: true },
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Constraint failures are malformed or colliding input; never expose SQLite details.
    if (constraintFailure(error)) throw new ApiError("invalid_request");
    throw error;
  } finally {
    // The rows are committed or the import failed; either way the staged files need no pin now.
    deps.blobs.release(prepared.holds);
  }
}

function constraintFailure(error: unknown): boolean {
  return error instanceof Error && (/constraint failed/i.test(error.message) || constraintFailure(error.cause));
}
