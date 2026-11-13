import { docViewOf } from "./doc.ts";
import type { ImportBundle } from "./import.ts";

type Row<K extends keyof ImportBundle> = ImportBundle[K] extends (infer T)[] ? T : never;
const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((row) => [row.id, row]));
function group<T>(rows: T[], key: (row: T) => string | null) {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    if (id === null) continue;
    const items = result.get(id);
    if (items) items.push(row);
    else result.set(id, [row]);
  }
  return result;
}
function buildIndex(bundle: ImportBundle) {
  const revisions = new Map(
    bundle.revisions.map((row) => [
      row.id,
      {
        row,
        topics: [] as Row<"topics">[],
        files: [] as Row<"files">[],
        writeups: [] as Row<"writeups">[],
        threads: [] as Row<"threads">[],
        diffPaths: new Map<string, Row<"files">>(),
        sourcePaths: new Map<string, Row<"files">>(),
        docPaths: new Map<string, Row<"files">>(),
        anyPaths: new Map<string, Row<"files">>(),
        topicText: new Map<string, { title: string; summary: string }>(),
      },
    ]),
  );
  for (const row of bundle.topics) {
    const r = revisions.get(row.revisionId);
    r?.topics.push(row);
    r?.topicText.set(row.slug, { title: row.title, summary: row.summary });
  }
  for (const row of bundle.files) {
    const r = revisions.get(row.revisionId);
    if (!r) continue;
    r.files.push(row);
    r.anyPaths.set(row.path, row);
    (row.role === "diff"
      ? r.diffPaths
      : row.role === "doc" && docViewOf(row) === "source"
        ? r.sourcePaths
        : r.docPaths
    ).set(row.path, row);
  }
  for (const row of bundle.writeups) revisions.get(row.revisionId)?.writeups.push(row);
  for (const row of bundle.threads) revisions.get(row.createdRevisionId)?.threads.push(row);
  return {
    revisions,
    files: byId(bundle.files),
    threads: byId(bundle.threads),
    sends: byId(bundle.sends),
    deliveries: byId(bundle.deliveries),
    commentsBySend: group(bundle.comments, (c) => c.sendId),
    sendsByDelivery: group(bundle.sends, (s) => s.deliveryId),
    assetsByDoc: group(bundle.docAssets, (a) => a.docId),
    notesByFile: group(bundle.agentNotes ?? [], (note) => note.fileId),
  };
}
export type ImportIndex = ReturnType<typeof buildIndex>;
export type ImportRevisionIndex = ImportIndex["revisions"] extends Map<string, infer V> ? V : never;
const indexes = new WeakMap<ImportBundle, ImportIndex>();
/** The parsed bundle is immutable throughout validation and ingestion. Reuse its relation indexes. */
export function indexImportBundle(bundle: ImportBundle): ImportIndex {
  let index = indexes.get(bundle);
  if (!index) {
    index = buildIndex(bundle);
    indexes.set(bundle, index);
  }
  return index;
}
