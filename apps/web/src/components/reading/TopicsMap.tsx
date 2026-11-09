import { plural } from "../../lib/count.ts";
import type { rankedTopics } from "../../lib/topics.ts";
import { TopicRank } from "../status/TopicRank.tsx";
import { TopicMeta } from "./TopicMeta.tsx";

export function TopicsMap({
  topics,
  fileCount,
  href,
}: {
  topics: ReturnType<typeof rankedTopics>;
  fileCount: (slug: string) => number;
  href: (slug: string) => string | undefined;
}) {
  return (
    <ol className="-mx-2.5 mb-2 flex list-none flex-col gap-0.5">
      {topics.map(({ topic, rank }) => {
        const target = href(topic.slug);
        const count = fileCount(topic.slug);
        return (
          <li
            key={topic.slug}
            className="relative grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0.5 rounded-md px-2.5 py-2 hover:bg-hover"
          >
            <span className="mt-px">
              <TopicRank rank={rank} />
            </span>
            <span className="wrap-anywhere text-[15px] font-medium leading-[1.35] text-fg-reading-strong">
              {target ? (
                <a href={target} className="after:absolute after:inset-0 after:rounded-md after:content-['']">
                  {topic.title}
                </a>
              ) : (
                topic.title
              )}
            </span>
            <p className="col-start-2 text-pretty wrap-anywhere text-14 leading-[1.45] text-fg-2">{topic.summary}</p>
            {(topic.attention || topic.door || topic.blastRadius || count > 0) && (
              <div className="col-start-2 mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-fg-3 [font:var(--type-meta)]">
                <TopicMeta topic={topic} />
                {count > 0 && (
                  <span>
                    {count} {plural(count, "file")}
                  </span>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
