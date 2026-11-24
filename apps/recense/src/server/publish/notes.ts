import type { AgentNoteView, PublishFile } from "@recense/contract";
import type { agentNotes } from "../../db/schema.ts";
import { ApiError, agentNoteDetail } from "../http/errors.ts";
import type { Executor } from "./work.ts";

/** Count lines off the event loop; unchanged lines need no patch or hunk parsing. */
export async function validateNoteRanges(
  files: PublishFile[],
  read: (hash: string) => Promise<ArrayBuffer>,
  execute: Executor,
) {
  const counts = new Map<string, number>();
  for (const file of files) {
    for (const [index, note] of (file.notes ?? []).entries()) {
      const hash = note.side === "old" ? file.oldBlob : file.newBlob;
      if (file.role !== "diff" || file.flag || !hash)
        throw new ApiError("invalid_request", agentNoteDetail(file.path, index));
      if (file.oldBlob === file.newBlob)
        throw new ApiError("invalid_request", agentNoteDetail(file.path, index, "unchanged"));
      let count = counts.get(hash);
      if (count === undefined) {
        const result = await execute({ kind: "line-count", bytes: await read(hash) });
        if (result.kind !== "line-count") throw new ApiError("invalid_request");
        count = result.count;
        counts.set(hash, count);
      }
      if (note.start > count || note.end > count)
        throw new ApiError("invalid_request", agentNoteDetail(file.path, index));
    }
  }
}

export function noteView(row: typeof agentNotes.$inferSelect): AgentNoteView {
  return {
    id: row.id,
    side: row.side,
    start: row.startLine,
    end: row.endLine,
    summary: row.summary,
    ...(row.rationale === null ? {} : { rationale: row.rationale }),
    ...(row.ref === null ? {} : { ref: row.ref }),
  };
}
