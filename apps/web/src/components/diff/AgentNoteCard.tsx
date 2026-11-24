import type { AgentNoteView, FileView, Target } from "@recense/contract";
import { useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useReadOnlyReview } from "../../lib/read-only-review.ts";
import { useThreadJump } from "../../lib/thread-jump.ts";
import { Button } from "../ui/Button.tsx";
import { fileSideQuery, useFileTexts } from "./file-texts.ts";
import { linesTarget } from "./linesTarget.ts";

export function AgentNoteCard({
  note,
  file,
  onComment,
}: {
  note: AgentNoteView;
  file: FileView;
  onComment: (target: Target) => void;
}) {
  const readOnly = useReadOnlyReview();
  const cardId = `diff-note-${note.id}`;
  const jump = useThreadJump(cardId);
  const client = useQueryClient();
  const texts = useFileTexts();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const comment = async () => {
    if (readOnly) return;
    setError("");
    setPending(true);
    try {
      const text = await client.fetchQuery(fileSideQuery(file.id, note.side, texts));
      if (!live.current) return;
      const target = linesTarget(file, note.side, note.start, note.end, text);
      if ("error" in target) setError("This range is too large to quote. Select fewer lines in the diff.");
      else onComment(target);
    } catch {
      setError("Could not load these lines. Try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <article id={cardId} data-agent-note data-jump={jump || undefined} className="em-card em-agent-note">
      <div className="em-card__head">
        <Bot size={14} aria-hidden="true" />
        <span className="em-agent-note__label">Agent note</span>
        {note.ref && <span className="em-note-ref">ref {note.ref}</span>}
        <span className="em-agent-note__lines">
          {note.start === note.end ? `line ${note.end}` : `lines ${note.start}–${note.end}`}
        </span>
      </div>
      <div className="em-card__body">
        <p className="em-agent-note__summary">{note.summary}</p>
        {note.rationale && <p className="em-agent-note__rationale">{note.rationale}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
      {!readOnly && (
        <div className="em-card__foot">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void comment()}>
            Comment on these lines
          </Button>
        </div>
      )}
    </article>
  );
}
