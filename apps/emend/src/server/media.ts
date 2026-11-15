import { and, eq, exists, inArray, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Queries } from "../db/client.ts";
import { docAssets, files } from "../db/schema.ts";

const MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
const doc = alias(files, "media_doc");

/** App-origin images: writeup media or an image listed by a Markdown doc of the same revision. */
export function mediaAsset(q: Queries, ownerId: string) {
  return and(
    eq(files.ownerId, ownerId),
    eq(files.role, "asset"),
    inArray(files.mediaType, MEDIA_TYPES),
    or(
      isNull(files.parentDocId),
      exists(
        q
          .select({ id: docAssets.assetId })
          .from(docAssets)
          .innerJoin(
            doc,
            and(
              eq(doc.ownerId, ownerId),
              eq(doc.id, docAssets.docId),
              eq(doc.revisionId, files.revisionId),
              eq(doc.role, "doc"),
              eq(doc.mediaType, "text/markdown"),
            ),
          )
          .where(
            and(
              eq(docAssets.ownerId, ownerId),
              eq(docAssets.revisionId, files.revisionId),
              eq(docAssets.assetId, files.id),
            ),
          ),
      ),
    ),
  );
}
