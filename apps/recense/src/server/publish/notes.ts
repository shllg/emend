import type { AgentNoteView, PublishFile } from "@recense/contract";
import type { agentNotes } from "../../db/schema.ts";
import { ApiError, agentNoteDetail } from "../http/errors.ts";
import { WorkTimeout } from "./executor.ts";
import type { Executor, WorkResult } from "./work.ts";

/** Batch every quote on the same content into one worker job, but report errors in request order. */
export async function resolveNoteRanges(
  files: PublishFile[],
  read: (hash: string) => Promise<ArrayBuffer>,
  execute: Executor,
) {
  const quotes = new Map<string, Set<string>>();
  for (const file of files) {
    for (const note of file.notes ?? []) {
      const hash = note.side === "old" ? file.oldBlob : file.newBlob;
      if (!hash || note.quote === undefined) continue;
      const batch = quotes.get(hash) ?? new Set<string>();
      batch.add(note.quote);
      quotes.set(hash, batch);
    }
  }

  const sides = new Map<string, Extract<WorkResult, { kind: "note-quotes" | "line-count" }>>();
  const resolved = new Map<PublishFile, Omit<AgentNoteView, "id">[]>();
  for (const file of files) {
    if (!file.notes?.length) continue;
    const notes: Omit<AgentNoteView, "id">[] = [];
    for (const [index, note] of file.notes.entries()) {
      const hash = note.side === "old" ? file.oldBlob : file.newBlob;
      if (file.role !== "diff" || file.flag || !hash)
        throw new ApiError("invalid_request", agentNoteDetail(file.path, index));
      if (file.oldBlob === file.newBlob)
        throw new ApiError("invalid_request", agentNoteDetail(file.path, index, "unchanged"));
      let side = sides.get(hash);
      if (!side) {
        const batch = quotes.get(hash);
        const bytes = await read(hash);
        let result: WorkResult;
        try {
          result = await execute(
            batch ? { kind: "note-quotes", bytes, quotes: [...batch] } : { kind: "line-count", bytes },
          );
        } catch (error) {
          if (error instanceof WorkTimeout)
            throw new ApiError("too_large", agentNoteDetail(file.path, index, "timeout"));
          throw error;
        }
        if (result.kind !== "note-quotes" && result.kind !== "line-count") throw new ApiError("invalid_request");
        side = result;
        sides.set(hash, side);
      }
      const { quote, start, end, ...fields } = note;
      if (quote === undefined) {
        if (start === undefined || end === undefined || start > side.count || end > side.count)
          throw new ApiError("invalid_request", agentNoteDetail(file.path, index));
        notes.push({ ...fields, start, end });
      } else {
        const match = side.kind === "note-quotes" ? side.matches.get(quote) : undefined;
        if (!match) throw new Error("Missing quote result");
        if (typeof match === "string") throw new ApiError("invalid_request", agentNoteDetail(file.path, index, match));
        if (start !== undefined && (start !== match.start || end !== match.end))
          throw new ApiError("invalid_request", agentNoteDetail(file.path, index, "quote_range"));
        notes.push({ ...fields, ...match });
      }
    }
    resolved.set(file, notes);
  }
  return resolved;
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
