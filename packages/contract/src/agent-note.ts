import { z } from "zod";
import { LIMITS } from "./limits.ts";
import { OTHER_TOPIC } from "./review.ts";

export const AGENT_NOTE_QUOTES_FEATURE = "note-quotes";

const rangedNote = z.object({
  side: z.enum(["old", "new"]),
  start: z.int().positive(),
  end: z.int().positive(),
  summary: z
    .string()
    .min(1)
    .max(160)
    .refine((text) => text.trim().length > 0, "summary must not be blank")
    .refine((text) => !/[\r\n\u0085\u2028\u2029]/.test(text), "summary must be one line"),
  rationale: z
    .string()
    .max(1200)
    .refine((text) => text.trim().length > 0, "rationale must not be blank")
    .optional(),
  ref: z
    .string()
    .length(1)
    .regex(/^[A-Z]$/)
    .optional(),
});

export const AgentNote = rangedNote
  .partial({ start: true, end: true })
  .extend({
    quote: z
      .string()
      .min(1)
      .max(2000)
      .refine((text) => text.trim().length > 0, "quote must not be blank")
      .optional(),
  })
  .refine((note) => (note.start === undefined) === (note.end === undefined), "start and end go together")
  .refine(
    (note) => note.quote !== undefined || (note.start !== undefined && note.end !== undefined),
    "a note needs a quote, or start and end",
  )
  .refine((note) => note.start === undefined || note.end === undefined || note.end >= note.start, {
    path: ["end"],
    message: "end must not precede start",
  });
export type AgentNote = z.infer<typeof AgentNote>;
export const AgentNoteView = rangedNote
  .extend({ id: z.uuid() })
  .refine((note) => note.end >= note.start, { path: ["end"], message: "end must not precede start" });
export type AgentNoteView = z.infer<typeof AgentNoteView>;
export const AgentNotes = z.array(AgentNote).max(LIMITS.agentNotesPerFile);

/** Refs belong to a topic in one revision, including the generated Other changes topic. */
export function validateAgentNotes(
  files: { path: string; topic?: string; notes?: AgentNote[] }[],
  ctx: z.RefinementCtx,
) {
  let count = 0;
  const refs = new Set<string>();
  for (const [fileIndex, file] of files.entries()) {
    count += file.notes?.length ?? 0;
    for (const [noteIndex, note] of (file.notes ?? []).entries()) {
      if (!note.ref) continue;
      const key = `${file.topic ?? OTHER_TOPIC.slug}:${note.ref}`;
      if (refs.has(key))
        ctx.addIssue({
          code: "custom",
          path: ["files", fileIndex, "notes", noteIndex, "ref"],
          message: `${file.path}: note ${noteIndex}: duplicate ref ${note.ref} in topic`,
        });
      refs.add(key);
    }
  }
  if (count > LIMITS.agentNotesPerRevision)
    ctx.addIssue({ code: "custom", path: ["files"], message: "too many agent notes in revision" });
}
