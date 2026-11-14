import type { TopicMeta as Topic } from "@emend/contract";
import { AttentionChip, undoSentence } from "./TopicChips.tsx";

export function TopicMeta({ topic, note = false, blast = true }: { topic: Topic; note?: boolean; blast?: boolean }) {
  return (
    <>
      <AttentionChip attention={topic.attention} />
      {topic.door && <span>{undoSentence(topic.door)}</span>}
      {blast && <BlastRadius topic={topic} note={note} />}
    </>
  );
}

export function BlastRadius({ topic, note = false }: { topic: Topic; note?: boolean }) {
  return topic.blastRadius ? (
    <span className="min-w-0 wrap-anywhere">
      Blast radius{" "}
      <span className="font-mono text-[11.5px] font-stretch-mono text-fg-2">{topic.blastRadius.scope}</span>
      {note && topic.blastRadius.note && <> · {topic.blastRadius.note}</>}
    </span>
  ) : null;
}
