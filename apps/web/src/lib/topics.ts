import { OTHER_TOPIC, type TopicMeta } from "@recense/contract";

// The revision is already in review order; Other never consumes a rank.
export function rankedTopics(topics: TopicMeta[]) {
  return topics.filter((topic) => topic.slug !== OTHER_TOPIC.slug).map((topic, index) => ({ topic, rank: index + 1 }));
}
