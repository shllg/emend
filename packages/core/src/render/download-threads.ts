import type { Outcome, Placement, Target, ThreadState, TopicMeta, UnplacedReason } from "@emend/contract";

export type DownloadComment = {
  author: "user" | "agent";
  sent: boolean;
  body: string;
  html: string | null;
  createdAt: number;
  outcome?: Outcome;
};
export type DownloadThreadInput = {
  target: Target;
  placement: Placement;
  state: ThreadState;
  createdOn: number;
  comments: DownloadComment[];
};
export type DownloadThread = {
  where: string;
  state: ThreadState;
  quote?: string;
  lines?: string[];
  note?: string;
  comments: DownloadComment[];
};
export type FileThreads = {
  /** Whole-review threads (base file only). */
  top: DownloadThread[];
  /** Block id to the threads shown right after that block. */
  blocks: Map<string, DownloadThread[]>;
  /** Topic slug to the threads shown in that topic's section. */
  topics: Map<string, DownloadThread[]>;
  /** Source line number (1-based) to the threads shown after that line. */
  lines: Map<number, DownloadThread[]>;
  /** An HTML doc's own threads, shown at the end of its body. */
  doc: DownloadThread[];
  /** Threads with no place in this file's content. */
  end: DownloadThread[];
};
export type DownloadFile = { kind: "writeup" } | { kind: "markdown" | "source" | "html"; path: string };

// Same sentences as the thread card in the app.
const reasons: Record<UnplacedReason, string> = {
  "block-gone": "The block this comment was on is gone.",
  ambiguous: "The quoted text now appears more than once.",
  "topic-gone": "The topic this comment was on is gone.",
  "file-gone": "The file this comment was on is no longer in the diff.",
  "lines-gone": "The lines this comment was on are gone.",
  "not-placed": "This comment has no place in this revision.",
};

const emptyThreads = (): FileThreads => ({
  top: [],
  blocks: new Map(),
  topics: new Map(),
  lines: new Map(),
  doc: [],
  end: [],
});
function push<K>(map: Map<K, DownloadThread[]>, key: K, thread: DownloadThread) {
  const list = map.get(key);
  if (list) list.push(thread);
  else map.set(key, [thread]);
}
const range = (start: number, end: number) => (start === end ? `line ${start}` : `lines ${start}–${end}`);

type Spot =
  | { kind: "review" }
  | { kind: "topic"; slug: string }
  | { kind: "writeup-span"; blockId: string }
  | { kind: "doc-span"; path: string; blockId: string }
  | { kind: "html-span"; path: string }
  | { kind: "source-lines"; path: string; start: number; end: number }
  | { kind: "lines"; path: string; side: "old" | "new"; start: number; end: number }
  | { kind: "file"; path: string };

function whereLabel(spot: Spot, titles: Map<string, string>): string {
  switch (spot.kind) {
    case "review":
      return "Whole review";
    case "topic":
      return `Topic · ${titles.get(spot.slug) ?? spot.slug}`;
    case "writeup-span":
      return "Writeup";
    case "doc-span":
    case "html-span":
    case "file":
      return spot.path;
    case "source-lines":
      return `${spot.path} · ${range(spot.start, spot.end)} (source)`;
    case "lines":
      return `${spot.path} · ${range(spot.start, spot.end)}${spot.side === "old" ? " (old)" : ""}`;
  }
}

const order = new WeakMap<DownloadThread, number>();
/** The position of a thread in the router's input, to keep input order when a page moves threads. */
export const threadOrder = (thread: DownloadThread) => order.get(thread) ?? 0;

/** Decides, per file of one download, where each sent thread is shown. Unsent comments are dropped. */
export function routeDownloadThreads(input: {
  threads: DownloadThreadInput[];
  seq: number;
  topics: TopicMeta[];
  base: DownloadFile;
  docs: DownloadFile[];
}): { base: FileThreads; docs: FileThreads[] } {
  const base = emptyThreads();
  const docs = input.docs.map(emptyThreads);
  const files: { file: DownloadFile; threads: FileThreads }[] = [
    { file: input.base, threads: base },
    ...input.docs.map((file, index) => ({ file, threads: docs[index] ?? emptyThreads() })),
  ];
  const titles = new Map(input.topics.map((topic) => [topic.slug, topic.title]));
  const find = (kind: "markdown" | "source" | "html", path: string) =>
    files.find(({ file }) => file.kind === kind && file.path === path)?.threads;

  let count = 0;
  for (const item of input.threads) {
    const comments = item.comments.filter((comment) => !(comment.author === "user" && !comment.sent));
    if (!comments.length) continue;
    const target = item.target;
    const thread: DownloadThread = { where: "", state: item.state, comments };
    order.set(thread, count++);
    if (target.kind === "writeup-span" || target.kind === "doc-span" || target.kind === "html-span")
      thread.quote = target.quote;
    else if (target.kind === "lines" || target.kind === "source-lines") thread.lines = target.lines;

    if (item.placement.status === "unplaced") {
      thread.where = whereLabel(target, titles);
      const reason = reasons[item.placement.reason];
      thread.note = item.createdOn === input.seq ? reason : `${reason} Made on revision ${item.createdOn}.`;
      base.end.push(thread);
      continue;
    }
    const location = item.placement.location;
    thread.where = whereLabel(location, titles);
    const writeupBase = input.base.kind === "writeup";
    switch (location.kind) {
      case "review":
        base.top.push(thread);
        break;
      case "topic":
        if (writeupBase) push(base.topics, location.slug, thread);
        else base.end.push(thread);
        break;
      case "writeup-span":
        if (writeupBase) push(base.blocks, location.blockId, thread);
        else base.end.push(thread);
        break;
      case "doc-span": {
        const target = find("markdown", location.path);
        if (target) push(target.blocks, location.blockId, thread);
        else base.end.push(thread);
        break;
      }
      case "html-span": {
        const target = find("html", location.path);
        if (target) target.doc.push(thread);
        else base.end.push(thread);
        break;
      }
      case "source-lines": {
        const target = find("source", location.path);
        if (target) push(target.lines, location.end, thread);
        else base.end.push(thread);
        break;
      }
      default:
        base.end.push(thread);
    }
  }
  return { base, docs };
}
