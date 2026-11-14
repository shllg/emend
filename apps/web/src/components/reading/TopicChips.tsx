import type { TopicMeta } from "@emend/contract";

export function AttentionChip({ attention }: { attention: TopicMeta["attention"] }) {
  return attention ? (
    <span className="em-topic-chip" data-attention={attention}>
      {attention === "critical" ? "High" : attention === "review" ? "Medium" : "Low"}
      <span className="sr-only"> risk</span>
    </span>
  ) : null;
}

export function TopicChips({ topic }: { topic: TopicMeta }) {
  return <AttentionChip attention={topic.attention} />;
}

export function undoSentence(door: NonNullable<TopicMeta["door"]>) {
  return door === "two-way" ? "Undo: a revert" : "Undo: a revert is not enough";
}
