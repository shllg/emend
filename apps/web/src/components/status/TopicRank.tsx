export function TopicRank({ rank, current = false }: { rank: number; current?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-grid h-5 min-w-[22px] shrink-0 place-items-center rounded-sm px-1 font-mono text-12 font-semibold leading-none tabular-nums ${current ? "bg-topic-solid text-topic-on-solid" : "bg-topic-bg text-topic-fg"}`}
    >
      {String(rank).padStart(2, "0")}
    </span>
  );
}
