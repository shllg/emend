import type { rankedTopics } from "../../lib/topics.ts";
import { TopicRank } from "../status/TopicRank.tsx";
import { AttentionChip } from "./TopicChips.tsx";

export function TopicsMap({
  topics,
  href,
}: {
  topics: ReturnType<typeof rankedTopics>;
  href: (slug: string) => string | undefined;
}) {
  return (
    <ol className="-mx-2.5 mb-2 flex list-none flex-col gap-0.5">
      {topics.map(({ topic, rank }) => {
        const target = href(topic.slug);
        return (
          <li
            key={topic.slug}
            className="relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-0.5 rounded-md px-2.5 py-2 hover:bg-hover"
          >
            <span className="mt-px">
              <TopicRank rank={rank} />
            </span>
            <span dir="auto" className="wrap-anywhere text-[15px] font-medium leading-[1.35] text-fg-reading-strong">
              {target ? (
                <a href={target} className="after:absolute after:inset-0 after:rounded-md after:content-['']">
                  {topic.title}
                </a>
              ) : (
                topic.title
              )}
            </span>
            <AttentionChip attention={topic.attention} />
            <p dir="auto" className="col-span-2 col-start-2 text-pretty wrap-anywhere text-14 leading-[1.45] text-fg-2">
              {topic.summary}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
