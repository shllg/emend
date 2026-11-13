import { OTHER_TOPIC, type PlacementLocation, type RevisionView, type ThreadView } from "@emend/contract";
import { resolveFile, targetLabel, WRITEUP_SECTION_NAMES } from "../components/diff/targets.ts";
import { diffGroups } from "./diff-groups.ts";

type Input = Pick<RevisionView, "threads" | "topics" | "writeup" | "docs" | "files">;
export interface ThreadPlace {
  key: string;
  label: string;
  threads: ThreadView[];
}

/** Places and passages follow the readers, using the current placement rather than the saved target. */
export function threadPlaces({ threads, topics, writeup, docs, files }: Input): ThreadPlace[] {
  const sectionKey = (section: Input["writeup"]["sections"][number]) =>
    section.topic !== null ? `topic:${section.topic}` : `writeup:${section.key}`;
  const blocks = new Map<string, { key: string; index: number }>();
  for (const section of writeup.sections) {
    for (const block of section.blocks) blocks.set(block.id, { key: sectionKey(section), index: blocks.size });
  }
  const docBlocks = new Map(
    docs
      .filter((doc) => doc.kind === "markdown")
      .map((doc) => [doc.path, new Map(doc.blocks.map((block, i) => [block.id, i]))]),
  );
  const placeKey = (location: PlacementLocation): string => {
    switch (location.kind) {
      case "review":
        return "review";
      case "topic":
        return `topic:${location.slug}`;
      case "writeup-span": {
        const block = blocks.get(location.blockId);
        if (block) return block.key;
        const topic = /^t-(.+)-(?:why|example|body)-[\da-f]{8}(?:-\d+)?$/.exec(location.blockId)?.[1];
        return topic ? `topic:${topic}` : `writeup:${location.blockId.split("-")[0]}`;
      }
      case "doc-span":
      case "html-span":
      case "source-lines":
        return `doc:${location.path}`;
      case "file":
      case "lines":
        return `file:${resolveFile(files, location)?.path ?? location.path}`;
    }
  };
  const position = (location: PlacementLocation): number[] => {
    switch (location.kind) {
      case "topic":
        return [location.part === undefined ? 0 : location.part === "title" ? 1 : 2, location.start ?? 0];
      case "writeup-span":
        return [3, blocks.get(location.blockId)?.index ?? Number.MAX_SAFE_INTEGER, location.start];
      case "doc-span":
        return [0, docBlocks.get(location.path)?.get(location.blockId) ?? Number.MAX_SAFE_INTEGER, location.start];
      case "html-span":
        return [0, 0, location.start];
      case "source-lines":
        return [1, location.start];
      case "file":
        return [0];
      case "lines":
        return [1, location.start, location.end];
      case "review":
        return [];
    }
  };
  const groups = new Map<string, { thread: ThreadView; position: number[] }[]>();
  for (const thread of threads) {
    const location = thread.placement.status === "placed" ? thread.placement.location : null;
    const key = location ? placeKey(location) : "unplaced";
    const group = groups.get(key) ?? [];
    group.push({ thread, position: location ? position(location) : [] });
    groups.set(key, group);
  }
  const order = new Set(["review"]);
  for (const section of writeup.sections) order.add(sectionKey(section));
  for (const topic of topics) if (topic.slug !== OTHER_TOPIC.slug) order.add(`topic:${topic.slug}`);
  order.add(`topic:${OTHER_TOPIC.slug}`);
  for (const key of groups.keys()) if (key.startsWith("writeup:") || key.startsWith("topic:")) order.add(key);
  for (const doc of docs) order.add(`doc:${doc.path}`);
  for (const key of groups.keys()) if (key.startsWith("doc:")) order.add(key);
  for (const group of diffGroups({ topics, files }).values()) {
    for (const file of group.files) order.add(`file:${file.path}`);
  }
  for (const key of groups.keys()) if (key.startsWith("file:")) order.add(key);
  order.add("unplaced");

  const label = (key: string) => {
    if (key === "review") return "Whole review";
    if (key === "unplaced") return "Unplaced";
    if (key.startsWith("topic:")) return targetLabel({ kind: "topic", slug: key.slice(6) }, topics).label;
    if (key.startsWith("writeup:")) {
      const name = Object.entries(WRITEUP_SECTION_NAMES).find(([section]) => section === key.slice(8))?.[1];
      return `Writeup · ${name ?? key.slice(8)}`;
    }
    return key.slice(key.indexOf(":") + 1);
  };
  return [...order].flatMap((key) => {
    const group = groups.get(key);
    if (!group) return [];
    return [
      {
        key,
        label: label(key),
        threads: group
          .toSorted((a, b) => {
            for (let i = 0; i < Math.max(a.position.length, b.position.length); i++) {
              const difference = (a.position[i] ?? 0) - (b.position[i] ?? 0);
              if (difference) return difference;
            }
            return 0;
          })
          .map(({ thread }) => thread),
      },
    ];
  });
}
