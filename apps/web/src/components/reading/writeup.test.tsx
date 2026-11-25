// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import {
  type FileView,
  OTHER_TOPIC,
  type RenderedBlock,
  RenderedWriteup,
  type ThreadView,
  type TopicMeta,
  type WriteupInput,
} from "@recense/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderWriteup } from "../../../../../packages/core/src/render/writeup.ts";
import type { CodeFocus } from "../../lib/code-focus.ts";
import { ReadOnlyReview } from "../../lib/read-only-review.ts";
import { revealReadingTarget } from "../../lib/reading-reveal.ts";
import { blockAnchor } from "../../lib/selection.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import { BlockView } from "./BlockView.tsx";
import { DocView } from "./DocView.tsx";
import { ReadingFoldContext } from "./ReadingGroup.tsx";
import { Writeup } from "./Writeup.tsx";

const reviewId = "11111111-1111-4111-8111-111111111111";
const topic: TopicMeta = {
  slug: "seed",
  title: "Plant a seed",
  summary: "A synthetic garden",
  importance: 10,
  door: "one-way",
  blastRadius: { scope: "garden", note: "The seed bed" },
};
const second: TopicMeta = {
  slug: "water",
  title: "Water the garden",
  summary: "Keep it growing",
  importance: 5,
  door: "two-way",
};
const other: TopicMeta = { ...OTHER_TOPIC, summary: "", importance: 0 };
const block: RenderedBlock = {
  id: "overview-12345678",
  section: "overview",
  kind: "paragraph",
  text: "Plant  a\nseed.",
  html: "<p>Plant  a\nseed.</p>",
};
const file: FileView = {
  id: reviewId,
  path: "seed.txt",
  oldPath: null,
  role: "diff",
  topic: topic.slug,
  order: 0,
  status: "modified",
  mediaType: "text/plain",
  flag: "binary",
  hasOld: false,
  hasNew: false,
};
const plain = (
  key: "overview" | "tldr" | "decisions" | "glossary",
  label: string,
): RenderedWriteup["sections"][number] => ({
  key,
  label,
  topic: null,
  blocks: [],
});
const section = (slug: string, suffix: "why" | "example" | "body"): RenderedWriteup["sections"][number] => ({
  key: `t-${slug}-${suffix}`,
  label: "Do not parse this label",
  topic: slug,
  blocks: [],
});
const props = { reviewId, revision: 2, threads: [], changedBlocks: [] };
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
function mount(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 100, 200, 20),
  ] as unknown as DOMRectList);
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  window.getSelection()?.removeAllRanges();
  fetchMock = vi.fn(async () => Response.json({ threadId: reviewId, commentId: reviewId }, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([false, true])("the full opening progresses through all four layers (phone=%s)", async (phone) => {
  const topics: TopicMeta[] = [
    { ...topic, attention: "skim" },
    { ...second, attention: "critical" },
  ];
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        area: "Garden",
        tldr: "Healthy plants.",
        whyItMatters: "More plants survive.",
        newInRevision: [{ text: "Added watering instructions." }],
        needsYou: [{ kind: "decide", text: "Choose a seed." }],
        overview: "- **Goal:** Healthy plants.\n- **Change:** More water.\n- Keep the soil loose.",
        checked: "Seeds grow.",
        whereToLook: "- **Biggest risk:** Flooding.\n- **Look yourself:** Water the seeds.\n- Inspect the soil.",
        context: "A small garden.",
        decisions: "Keep the soil.",
        glossary: "- **Seed:** A new plant.",
        topics: { seed: { why: "Plant seeds." }, water: { why: "Water daily." } },
      },
      topics,
    ),
  );
  const { container } = mount(<Writeup {...props} topics={topics} writeup={writeup} phone={phone} />);
  const groups = [...container.querySelectorAll<HTMLElement>("[data-reading-section]")];
  expect(groups.map((group) => [group.dataset.readingSection, group.dataset.depthLayer])).toEqual([
    ["tldr", "decide"],
    ["newInRevision", "decide"],
    ["needsYou", "decide"],
    ["risk", "decide"],
    ["whereToLook", "decide"],
    ["frame", "frame"],
    ["overview", "frame"],
    ["topics-map", "frame"],
    ["t-seed-why", "topics"],
    ["t-water-why", "topics"],
    ["decisions", "trail"],
    ["context", "trail"],
    ["glossary", "trail"],
  ]);
  expect(container.querySelector('[data-fact="furtherDown"] dd')?.textContent).toBe(
    "Decisions & drift · Context · Glossary",
  );
  expect(container.querySelector('[data-fact="topics"]')).toBeNull();
  const divider = screen.getByText("Above: what you approve. Below: detail.");
  expect(container.querySelectorAll(".em-depth-divider")).toHaveLength(1);
  expect(divider.previousElementSibling?.getAttribute("data-reading-section")).toBe("topics-map");
  expect(divider.nextElementSibling?.id).toBe("topic-seed");
  expect(divider.hasAttribute("data-reading-section")).toBe(false);
  expect(screen.queryByRole("list", { name: "Writeup depth" })).toBeNull();
});

test("the old layout keeps its introduction, then index and ranked topics, then trail", () => {
  const { container } = mount(
    <Writeup
      {...props}
      topics={[topic, second]}
      writeup={{
        sections: [
          plain("overview", "Overview"),
          plain("tldr", "TL;DR"),
          plain("decisions", "Decisions"),
          plain("glossary", "Glossary"),
          section("water", "why"),
          section("seed", "why"),
        ],
      }}
    />,
  );
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-reading-section]")].map((group) => group.dataset.readingSection),
  ).toEqual(["overview", "tldr", "topics-map", "t-seed-why", "t-water-why", "decisions", "glossary"]);
});

test("legacy news and needs sections remain in Decide ahead of Risk", async () => {
  const writeup = await newsWriteup();
  const { container } = mount(
    <Writeup {...props} topics={[topic]} writeup={{ ...writeup, newInRevision: undefined, needsYou: undefined }} />,
  );
  expect(
    [...container.querySelectorAll<HTMLElement>('[data-depth-layer="decide"]')].map(
      (group) => group.dataset.readingSection,
    ),
  ).toEqual(["tldr", "newInRevision", "needsYou", "risk"]);
});

test("the divider is absent when nothing follows Frame and for Markdown documents", () => {
  const view = mount(<Writeup {...props} topics={[topic]} writeup={{ sections: [plain("overview", "Overview")] }} />);
  expect(view.container.querySelector('[data-reading-section="topics-map"]')).not.toBeNull();
  expect(view.container.querySelector(".em-depth-divider")).toBeNull();
  view.unmount();
  const doc = { path: "garden.md", kind: "markdown" as const, blocks: [block] };
  const rendered = mount(
    <DocView {...props} docs={[doc]} openDoc={doc} search={{ tab: "docs" }} targeted={false} onOpenDoc={() => {}} />,
  );
  expect(rendered.container.querySelector("[data-depth-layer], .em-depth-divider")).toBeNull();
});

test.each([false, true])("the marker renders into the provided header slot (phone=%s)", (phone) => {
  const slot = document.createElement("div");
  document.body.append(slot);
  try {
    const view = mount(
      <Writeup {...props} phone={phone} depthSlot={slot} writeup={{ sections: [plain("overview", "Overview")] }} />,
    );
    const marker = within(slot).getByRole("list", { name: "Writeup depth" });
    expect(marker.querySelector('[aria-current="step"]')?.textContent).toBe("Decide");
    expect(marker.hasAttribute("data-compact")).toBe(phone);
    expect(view.container.querySelector(".em-depth-marker")).toBeNull();
    view.unmount();
    expect(slot.childElementCount).toBe(0);
  } finally {
    slot.remove();
  }
});

function topicReader(threads: ThreadView[] = [], value = topic, overview = false) {
  return mount(
    <Writeup
      {...props}
      threads={threads}
      topics={[value]}
      writeup={{
        sections: [
          ...(overview ? [plain("overview", "Overview")] : []),
          { ...section(value.slug, "why"), blocks: [block] },
        ],
      }}
    />,
  );
}
function selectTopic(container: HTMLElement, part: "title" | "summary") {
  const element = container.querySelector<HTMLElement>(`[data-topic-part="${part}"]`);
  const node = element?.firstChild;
  if (!node || !element) throw new Error("Missing topic text");
  const quote = part === "title" ? "seed" : "synthetic";
  const from = (node.textContent ?? "").indexOf(quote);
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, from + quote.length);
  const selection = window.getSelection();
  if (!selection) throw new Error("Missing selection");
  selection.removeAllRanges();
  selection.addRange(range);
  return { element, node, selection };
}
async function saveTopicComment() {
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Explain this topic" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  return JSON.parse(fetchMock.mock.calls[0]?.[1].body).target;
}

test.each(["title", "summary"] as const)("mouse selection on the topic %s saves the quote and topic", async (part) => {
  const { container } = topicReader();
  const { element } = selectTopic(container, part);
  expect(element.hasAttribute("data-block-id")).toBe(false);
  fireEvent.mouseUp(element);
  fireEvent.click(screen.getByRole("button", { name: "Comment on selection" }));
  expect(await saveTopicComment()).toEqual({
    kind: "topic",
    slug: topic.slug,
    part,
    ...(part === "title"
      ? { quote: "seed", prefix: "Plant a ", suffix: "" }
      : { quote: "synthetic", prefix: "A ", suffix: " garden" }),
  });
});

test("Comment on topic saves a slug-only target even when the topic is folded", async () => {
  const { container } = topicReader([], { ...topic, attention: "skim" });
  const button = screen.getByRole("button", { name: "Comment on topic" });
  fireEvent.click(button);
  expect(screen.getByLabelText("Comment").closest("[hidden]")).toBeNull();
  expect(await saveTopicComment()).toEqual({ kind: "topic", slug: topic.slug });
  await waitFor(() => expect(container.querySelector("textarea")).toBeNull());
});

test.each(["title", "summary"] as const)(
  "phone touch selection on the topic %s survives collapse and saves through the composer sheet",
  async (part) => {
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: 390 >= Number(query.match(/\d+/)?.[0] ?? Infinity),
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.useFakeTimers();
    const { container } = topicReader();
    const { node, selection } = selectTopic(container, part);
    document.dispatchEvent(new Event("selectionchange"));
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
    act(() => void vi.advanceTimersByTime(250));
    const prompt = screen.getByRole("button", { name: "Comment on selection" });
    expect(fireEvent.pointerDown(prompt, { pointerType: "touch" })).toBe(false);
    selection.collapse(node, 0);
    document.dispatchEvent(new Event("selectionchange"));
    act(() => void vi.advanceTimersByTime(250));
    expect(prompt.isConnected).toBe(true);
    fireEvent.pointerUp(prompt, { pointerType: "touch" });
    fireEvent.click(prompt);
    vi.useRealTimers();
    const sheet = screen.getByRole("dialog", { name: "New comment" });
    const form = within(sheet).getByLabelText("Comment").closest("form");
    expect(form?.classList.contains("em-composer--sheet")).toBe(true);
    expect(await saveTopicComment()).toEqual({
      kind: "topic",
      slug: topic.slug,
      part,
      ...(part === "title"
        ? { quote: "seed", prefix: "Plant a ", suffix: "" }
        : { quote: "synthetic", prefix: "A ", suffix: " garden" }),
    });
  },
);

test.each(["paragraph", "summary"])("selection from a topic title to a %s reports cross-block", (end) => {
  const { container } = topicReader();
  const { element, node, selection } = selectTopic(container, "title");
  const last = container.querySelector(
    end === "summary" ? '[data-topic-part="summary"]' : "[data-block-id] p",
  )?.firstChild;
  if (!last) throw new Error("Missing selection end");
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(last, 3);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(element);
  expect(screen.getByText("Select text within one paragraph").getAttribute("role")).toBe("status");
  expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
});

test("blast radius text has no comment anchor", () => {
  const { container } = topicReader();
  const blast = container.querySelector(".em-topic-blast");
  if (!blast) throw new Error("Missing blast radius");
  expect(blast.querySelector("[data-topic-part], [data-block-id]")).toBeNull();
  const range = document.createRange();
  range.selectNodeContents(blast);
  window.getSelection()?.addRange(range);
  fireEvent.mouseUp(blast);
  expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
});

test("whole-topic and quoted threads share the title chip when folded and both count", () => {
  const whole: ThreadView = {
    id: reviewId,
    createdOn: 1,
    state: "open",
    target: { kind: "topic", slug: topic.slug },
    placement: { status: "placed", location: { kind: "topic", slug: topic.slug } },
    comments: [{ id: reviewId, author: "user", body: "Whole topic feedback", sent: false, sentOn: null }],
  };
  const quoted: ThreadView = {
    ...whole,
    id: "22222222-2222-4222-8222-222222222222",
    target: { kind: "topic", slug: topic.slug, part: "title", quote: "seed", prefix: "Plant a ", suffix: "" },
    placement: { status: "placed", location: { kind: "topic", slug: topic.slug, part: "title", start: 8, end: 12 } },
    comments: whole.comments.map((comment) => ({ ...comment, body: "Quoted topic feedback" })),
  };
  topicReader([whole, quoted], { ...topic, attention: "skim" }, true);
  const group = screen.getByRole("region", { name: "Topic 1: Plant a seed" });
  expect(group.querySelectorAll("[data-thread-card]")).toHaveLength(0);
  expect(within(group).getByText("2 comments")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "2 comments" }));
  expect(screen.getByText("Whole topic feedback")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("Quoted topic feedback")).toBeTruthy();
  expect(screen.getByRole("dialog").querySelector(".em-thread-quote")?.textContent).toBe("seed");
  expect(screen.getByRole("navigation", { name: "Writeup outline" }).textContent).toContain("2 comments");
});

test("a hostile topic title and summary remain literal React text", () => {
  const title = "<img src=x onerror=alert(1)>";
  const { container } = topicReader([], { ...topic, title, summary: "<script>alert(1)</script>" });
  expect(container.querySelector('[data-topic-part="title"]')?.textContent).toBe(title);
  expect(container.querySelector('[data-topic-part="summary"]')?.textContent).toBe("<script>alert(1)</script>");
  expect(container.querySelector("img, script, [onerror]")).toBeNull();
});

test("new writeups show the opening hierarchy before topics", async () => {
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        tldr: "Failed requests now stop after three attempts.",
        review: { level: "topics", topics: ["seed"], reason: "Check the retry boundary." },
        checked: "Unit tests cover three attempts.",
        notChecked: "Browser behavior.",
        overview: "- **Goal:** Bound retries.\n- **Change:** Three attempts.",
        outOfScope: "- The delay between attempts.",
        whereToLook: "- **Biggest risk:** Losing the final attempt.\n- **Check first:** The retry loop.",
        context: "- **Scope:** The request loop in `retry.ts`.",
        decisions: "Keep the existing delay.",
        glossary: "- **Budget:** The number of attempts.",
        topics: { seed: { why: "Retries must end." } },
      },
      [topic],
    ),
  );
  const { container } = mount(<Writeup {...props} topics={[topic]} writeup={writeup} />);
  expect(
    [...container.querySelectorAll("[data-reading-section]")].map((group) =>
      group.getAttribute("data-reading-section"),
    ),
  ).toEqual([
    "tldr",
    "overview",
    "whereToLook",
    "checked",
    "notChecked",
    "outOfScope",
    "topics-map",
    "t-seed-why",
    "decisions",
    "context",
    "glossary",
  ]);
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "TL;DR",
    "Overview",
    "Where to look",
    "Checked",
    "Not checked",
    "Out of scope",
    "Topics",
    "Topic 1: Plant a seed",
    "Decisions & drift",
    "Context",
  ]);
  for (const [key, classes] of [
    ["tldr", ["em-writeup-card"]],
    ["outOfScope", ["em-writeup-quiet"]],
    ["whereToLook", ["em-writeup-callout", "em-writeup-guide"]],
    ["context", ["em-writeup-muted"]],
    ["decisions", ["em-writeup-callout", "em-writeup-decisions"]],
  ] as const) {
    const group = container.querySelector(`[data-reading-section="${key}"]`);
    expect(group).toBeTruthy();
    for (const name of classes) expect(group?.classList.contains(name)).toBe(true);
    expect(group?.querySelector("h2")?.className).toBe("em-writeup-kicker");
    expect(group?.querySelector("details, [hidden], [aria-expanded]")).toBeNull();
    expect(group?.querySelector("[data-block-id]")).toBeTruthy();
  }
  expect(screen.getByRole("heading", { name: "Overview" }).classList.contains("em-writeup-kicker")).toBe(false);
  for (const label of ["Checked", "Not checked"]) {
    expect(screen.getByRole("region", { name: label }).className).toBe("em-reading-group");
    expect(screen.getByRole("heading", { name: label }).classList.contains("em-writeup-kicker")).toBe(false);
  }
});

test.each(["checked", "notChecked", "context"] as const)(
  "the topics index separates the frame and trail for %s",
  (key) => {
    const sections: RenderedWriteup["sections"] = [
      { key, label: "Intro", topic: null, blocks: [] },
      section("seed", "why"),
    ];
    const { container } = mount(<Writeup {...props} topics={[topic]} writeup={{ sections }} />);
    expect(
      [...container.querySelectorAll("[data-reading-section]")].map((group) =>
        group.getAttribute("data-reading-section"),
      ),
    ).toEqual(key === "context" ? ["topics-map", "t-seed-why", key] : [key, "topics-map", "t-seed-why"]);
  },
);

test.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
])("writeup order and grouped topics (overview=%s, tldr=%s)", (overview, tldr) => {
  const sections = [
    ...(overview ? [plain("overview", "Overview")] : []),
    ...(tldr ? [plain("tldr", "TL;DR")] : []),
    plain("decisions", "Decisions and drift"),
    plain("glossary", "Glossary"),
    section("seed", "why"),
    section("seed", "example"),
    section("seed", "body"),
    section("water", "body"),
    { ...section("missing", "why"), label: "Unknown topic — Why" },
  ];
  const { container } = mount(<Writeup {...props} topics={[other, topic, second]} writeup={{ sections }} />);
  const introKeys = [
    ...(overview ? ["overview"] : []),
    ...(tldr ? ["tldr"] : []),
    "topics-map",
    "t-seed-why",
    "t-water-body",
    "t-missing-why",
    "decisions",
    "glossary",
  ];
  expect(
    [...container.querySelectorAll("[data-reading-section]")]
      .slice(0, introKeys.length)
      .map((group) => group.getAttribute("data-reading-section")),
  ).toEqual(introKeys);
  if (overview) expect(screen.getByRole("region", { name: "Overview" }).className).toBe("em-reading-group");
  if (tldr) expect(screen.getByRole("region", { name: "TL;DR" }).className).toBe("em-reading-group em-writeup-card");
  expect(screen.getByRole("region", { name: "Decisions & drift" }).className).toBe(
    "em-reading-group em-writeup-callout em-writeup-decisions",
  );
  expect(container.querySelector("details.em-writeup-glossary")).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    ...(overview ? ["Overview"] : []),
    ...(tldr ? ["TL;DR"] : []),
    "Topics",
    "Topic 1: Plant a seed",
    "Topic 2: Water the garden",
    "Unknown topic — Why",
    "Decisions & drift",
  ]);
  expect(container.querySelectorAll("section#topic-seed")).toHaveLength(1);
  const seed = screen.getByRole("region", { name: "Topic 1: Plant a seed" });
  expect(
    within(seed)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent),
  ).toEqual(["Why", "Example"]);
  expect(within(seed).getByText("Details").tagName).toBe("SUMMARY");
  expect(within(seed).getByText(/The seed bed/)).toBeTruthy();
  const unknown = screen.getByRole("region", { name: "Unknown topic — Why" });
  expect(within(unknown).queryByText(/Topic \d/)).toBeNull();
  expect(unknown.querySelector("[aria-hidden]")).toBeNull();
  expect(container.querySelector("#topic-missing")).toBeNull();
});

test.each([false, true])("topics map ranks, metadata and link destinations (phone=%s)", (phone) => {
  const plainTopic = { ...topic, slug: "rest", title: "Rest", door: undefined, blastRadius: undefined };
  mount(
    <Writeup
      {...props}
      phone={phone}
      search={{ tab: "writeup", rev: 2, thread: reviewId }}
      topics={[
        { ...topic, attention: "skim" },
        other,
        { ...second, attention: "critical" },
        { ...plainTopic, attention: "review" },
      ]}
      files={[
        file,
        { ...file, topic: "water" },
        { ...file, topic: "water", path: "rain.txt" },
        { ...file, role: "doc", topic: "rest" },
      ]}
      writeup={{ sections: [section("seed", "body")] }}
    />,
  );
  const map = within(screen.getByRole("region", { name: "Topics" }));
  const rows = map.getAllByRole("listitem");
  expect(rows.map((row) => row.querySelector("[aria-hidden]")?.textContent)).toEqual(["01", "02", "03"]);
  expect(rows.map((row) => row.querySelector("[data-attention]")?.textContent)).toEqual([
    "Low risk",
    "High risk",
    "Medium risk",
  ]);
  expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual([
    topic.summary,
    second.summary,
    plainTopic.summary,
  ]);
  expect(map.queryByText(/Undo:|Blast radius:|The seed bed|\d+ files?/)).toBeNull();
  expect(map.getByRole("link", { name: topic.title }).getAttribute("href")).toBe(
    `/r/${reviewId}?tab=writeup&rev=2#topic-seed`,
  );
  expect(map.getByRole("link", { name: second.title }).getAttribute("href")).toBe(
    `/r/${reviewId}?tab=${phone ? "diff" : "writeup"}&rev=2#diff-topic-water`,
  );
  expect(map.queryByRole("link", { name: "Rest" })).toBeNull();
  expect(map.getByText("Rest")).toBeTruthy();
  expect(screen.getByRole("link", { name: `Files in diff: ${topic.title}` }).getAttribute("href")).toBe(
    `/r/${reviewId}?tab=${phone ? "diff" : "writeup"}&rev=2#diff-topic-seed`,
  );
});

test.each([{ topics: [] }, { topics: [other] }])("map is absent without ranked topics: %j", ({ topics }) => {
  mount(<Writeup {...props} topics={topics} writeup={{ sections: [] }} />);
  expect(screen.queryByRole("heading", { name: "Topics" })).toBeNull();
});

test("topics without metadata or diff files omit their meta line and jump link", () => {
  const bare = { ...second, door: undefined };
  mount(
    <Writeup
      {...props}
      topics={[bare]}
      files={[file, { ...file, role: "doc", topic: bare.slug }]}
      writeup={{ sections: [section(bare.slug, "body")] }}
    />,
  );
  const group = screen.getByRole("region", { name: `Topic 1: ${bare.title}` });
  expect(within(group).queryByRole("link")).toBeNull();
  expect(within(group).queryByText(/Undo:|Blast radius/)).toBeNull();
});

test.each(["writeup", "doc"])(
  "gutter comments save a whole-block %s target and mark only the active block",
  async (kind) => {
    const heading: RenderedBlock = {
      ...block,
      id: "overview-23456789",
      kind: "heading",
      text: "Growing",
      html: "<h2>Growing</h2>",
    };
    const diagram: RenderedBlock = {
      ...block,
      id: "overview-34567890",
      kind: "diagram",
      text: "graph TD; A-->B",
      source: "graph TD; A-->B",
      html: "",
    };
    const blocks = [block, heading, diagram];
    const { container } = mount(
      kind === "writeup" ? (
        <Writeup
          {...props}
          writeup={{ sections: [{ ...plain("overview", "Overview"), blocks }] }}
          changedBlocks={[{ blockId: block.id, revision: 2 }]}
        />
      ) : (
        <DocView
          {...props}
          docs={[{ path: "garden.md", kind: "markdown", blocks }]}
          openDoc={{ path: "garden.md", kind: "markdown", blocks }}
          search={{ tab: "docs", doc: "garden.md" }}
          targeted={false}
          onOpenDoc={() => {}}
          changedBlocks={[{ blockId: block.id, revision: 2 }]}
        />
      ),
    );
    expect(screen.getAllByRole("button", { name: "Comment on block" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Comment on diagram" })).toHaveLength(1);
    expect(screen.getAllByText("Changed in rev 2")).toHaveLength(1);
    const changed = screen.getByText("Changed in rev 2").closest(".em-reading-block");
    expect(changed?.querySelector('[aria-hidden="true"].bg-changed-line')).toBeTruthy();
    expect(container.querySelectorAll(".bg-changed-line")).toHaveLength(1);
    const button = screen.getByRole("button", { name: "Comment on block" });
    // A remaining selection must not be captured when the gutter is pressed.
    const text = container.querySelector("[data-block-id] p")?.firstChild;
    if (!text) throw new Error("Missing block text");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(button);
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
    fireEvent.click(button);
    expect(container.querySelectorAll("[data-commenting]")).toHaveLength(1);
    expect(changed?.hasAttribute("data-commenting")).toBe(true);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Keep growing" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).target).toEqual({
      kind: kind === "writeup" ? "writeup-span" : "doc-span",
      ...(kind === "doc" ? { path: "garden.md" } : {}),
      ...blockAnchor(block),
    });
    await waitFor(() => expect(container.querySelector("[data-commenting]")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Comment on diagram" }));
    expect(container.querySelector("[data-commenting] [data-block-id]")?.getAttribute("data-block-id")).toBe(
      diagram.id,
    );
  },
);

test("an HTML doc keeps its sandbox note in the doc bar above the frame", () => {
  const doc = { kind: "html" as const, path: "one.html", contentUrl: "/content/synthetic/one.html" };
  const { container } = mount(
    <DocView
      {...props}
      docs={[doc]}
      openDoc={doc}
      targeted={false}
      search={{ tab: "docs", doc: doc.path }}
      onOpenDoc={() => {}}
      onHeading={() => {}}
    />,
  );
  const note = screen.getByText("Sandboxed, scripts off");
  expect(note.closest(".em-doc-bar")).not.toBeNull();
  for (const frame of container.querySelectorAll("iframe")) {
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.className).toContain("bg-[#fff]");
    expect(note.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
});

test("hostile metadata stays text and server-sanitized Markdown remains inert", async () => {
  const hostile = "<script>evil()</script><img src=x onerror=evil()><svg onload=evil()></svg>";
  const markdown = `${hostile}\n\n[bad](javascript:evil())\n\nRaw <b>HTML</b>\n\n\`\`\`mermaid\ngraph TD; A-->B; click A evil "click"\n\`\`\``;
  const evilTopic = {
    ...topic,
    title: hostile,
    summary: hostile,
    blastRadius: { scope: "<img/onerror=evil()>", note: hostile },
  };
  const writeup = await renderWriteup(
    {
      overview: markdown,
      tldr: "",
      outOfScope: markdown,
      whereToLook: markdown,
      context: markdown,
      decisions: null,
      glossary: markdown,
      topics: { seed: { why: markdown, body: markdown } },
    },
    [evilTopic],
  );
  const { container } = mount(
    <>
      <Writeup {...props} topics={[evilTopic]} writeup={RenderedWriteup.parse(writeup)} />
      <DocView
        {...props}
        docs={[{ path: hostile, kind: "markdown", blocks: [] }]}
        openDoc={{ path: hostile, kind: "markdown", blocks: [] }}
        search={{ tab: "docs" }}
        targeted={false}
        onOpenDoc={() => {}}
      />
    </>,
  );
  expect(screen.getAllByText(hostile).length).toBeGreaterThanOrEqual(3);
  expect(container.querySelector("script, svg[onload], [onerror], [onclick]")).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(container.querySelectorAll(".em-prose").length).toBeGreaterThan(0);
  for (const frame of container.querySelectorAll("iframe")) {
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("/mermaid-frame.html");
  }
});

test.each([
  ["critical", "High risk"],
  ["review", "Medium risk"],
  ["skim", "Low risk"],
  [undefined, undefined],
] as const)("topic chips and folding for attention %s", (attention, expected) => {
  const value = { ...topic, attention };
  const why = { ...section("seed", "why"), blocks: [block] };
  const { container } = mount(<Writeup {...props} topics={[value]} files={[file]} writeup={{ sections: [why] }} />);
  const group = screen.getByRole("region", { name: "Topic 1: Plant a seed" });
  const chip = group.querySelector("[data-attention]");
  expect(chip?.textContent).toBe(expected);
  if (attention) expect(chip?.querySelector(".sr-only")?.textContent).toBe(" risk");
  const map = screen.getByRole("region", { name: "Topics" });
  expect(map.querySelector("[data-attention]")?.textContent).toBe(expected);
  expect(container.querySelector("[data-door]")).toBeNull();
  expect(within(group).getByText(topic.summary)).toBeTruthy();
  expect(within(group).getByText("garden").tagName).toBe("STRONG");
  expect(within(group).getByText(/Blast radius:.*The seed bed/)).toBeTruthy();
  expect(within(group).getByRole("link", { name: `Files in diff: ${topic.title}` }).textContent).toBe(
    "1 file · Files in diff →",
  );
  const fold = within(group).getByRole("button", {
    name: `Topic 1: ${topic.title}`,
  });
  const title = within(group).getByRole("heading", { level: 2 });
  expect(fold.getAttribute("aria-labelledby")).toBe(title.id);
  expect(title.textContent).toBe(`Topic 1: ${topic.title}`);
  const header = title.parentElement;
  if (!header) throw new Error("Missing topic header");
  expect(within(header).getByText("01").closest("h2")).toBeNull();
  expect(within(header).queryByText(/Changed in rev/)).toBeNull();
  const body = document.getElementById(fold.getAttribute("aria-controls") ?? "");
  expect(fold.getAttribute("aria-expanded")).toBe(String(attention !== "skim"));
  expect(body?.hasAttribute("hidden")).toBe(attention === "skim");
  fireEvent.click(fold);
  expect(within(group).getByRole("button", { name: `Topic 1: ${topic.title}` })).toBe(fold);
  expect(fold.getAttribute("aria-expanded")).toBe(String(attention === "skim"));
  expect(body?.hasAttribute("hidden")).toBe(attention !== "skim");
  expect(container.querySelectorAll(`[data-block-id="${block.id}"]`)).toHaveLength(1);
});

test.each([
  ["one-way", "Undo: a revert is not enough"],
  ["two-way", "Undo: a revert"],
  [undefined, undefined],
] as const)("topic undo sentence for %s", (door, expected) => {
  const { container } = mount(
    <Writeup {...props} topics={[{ ...topic, door }]} writeup={{ sections: [section("seed", "why")] }} />,
  );
  const group = screen.getByRole("region", { name: "Topic 1: Plant a seed" });
  const undo = group.querySelector(".em-topic-undo");
  expect(undo?.textContent).toBe(expected);
  if (expected) {
    expect(undo?.classList.contains("text-warning-fg")).toBe(false);
    expect(undo?.previousElementSibling?.className).toBe("em-topic-summary");
    expect(undo?.nextElementSibling?.className).toBe("em-topic-blast");
    const map = within(screen.getByRole("region", { name: "Topics" }));
    expect(map.queryByText(expected)).toBeNull();
  } else {
    expect(container.textContent).not.toContain("Undo:");
  }
  expect(container.querySelector("[data-door], .text-warning-fg")).toBeNull();
  expect(container.textContent).not.toMatch(/One-way|Two-way/);
});

test("front matter cards, lead Why, Example panels and folded Details keep the original comment anchors", async () => {
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        overview: "Overview text",
        tldr: "Summary text",
        decisions: "Drift: A changed assumption.\n\ndRiFt: Another change.\n\nA decision.",
        glossary: "- Seed: a start.\n- Bed: a place.",
        topics: {
          seed: { why: "A reason.", example: "| Before | After |\n| --- | --- |\n| One | Two |", body: "A detail." },
        },
      },
      [topic],
    ),
  );
  const { container } = mount(<Writeup {...props} topics={[topic]} files={[file]} writeup={writeup} />);
  expect(screen.getByRole("heading", { name: "TL;DR" }).closest(".em-writeup-card")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Decisions & drift" }).closest(".em-writeup-decisions")).toBeTruthy();
  expect(container.querySelectorAll("[data-drift]")).toHaveLength(2);
  for (const drift of container.querySelectorAll<HTMLElement>("[data-drift]")) {
    expect(within(drift).getByRole("button", { name: "Comment on block" })).toBeTruthy();
  }
  const why = screen.getByRole("heading", { name: "Why", level: 3 });
  const example = screen.getByRole("heading", { name: "Example", level: 3 });
  expect(why.closest(".em-writeup-why")?.querySelector("[data-block-id]")?.textContent).toBe("A reason.");
  expect(why.className).toBe("sr-only");
  expect(why.closest(".em-writeup-callout")).toBeNull();
  expect(example.closest(".em-writeup-example")?.querySelector("table")).toBeTruthy();
  expect(example.className).toBe("em-writeup-kicker");
  const summary = screen.getByText("Details");
  const details = summary.closest("details");
  expect(details?.className).toBe("em-writeup-details");
  expect(details?.open).toBe(false);
  const files = screen.getByRole("list", { name: "Files" });
  expect(files.previousElementSibling).toBe(details);
  expect(files.closest("details")).toBeNull();
  expect(files.parentElement?.lastElementChild).toBe(files);
  fireEvent.click(summary);
  expect(details?.open).toBe(true);
  expect(details?.querySelector("[data-block-id]")?.textContent).toBe("A detail.");
  expect(details?.querySelector(".em-topic-file-chips")).toBeNull();
  const ids = ["overview", "tldr", "t-seed-why", "t-seed-example", "t-seed-body", "decisions", "glossary"].flatMap(
    (key) =>
      writeup.sections.flatMap((section) => (section.key === key ? section.blocks.map((block) => block.id) : [])),
  );
  expect(
    [...container.querySelectorAll("[data-block-id]")].map((element) => element.getAttribute("data-block-id")),
  ).toEqual(ids);
  expect(screen.getByText("Glossary · 2 terms").closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByText("Glossary · 2 terms"));
  const glossary = screen.getByText("Glossary · 2 terms").closest("details");
  expect(glossary?.open).toBe(true);
  expect(glossary && within(glossary).getAllByRole("button", { name: "Comment on block" })).toHaveLength(2);
});

test("glossary without list items counts blocks", () => {
  mount(<Writeup {...props} writeup={{ sections: [{ ...plain("glossary", "Glossary"), blocks: [block] }] }} />);
  expect(screen.getByText("Glossary · 1 term").closest("details")?.open).toBe(false);
});

test("literal hostile title, summary and blast note appear in the topic section", () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const { container } = mount(
    <Writeup
      {...props}
      topics={[{ ...topic, title: hostile, summary: hostile, blastRadius: { scope: "garden", note: hostile } }]}
      writeup={{ sections: [section("seed", "why")] }}
    />,
  );
  const group = screen.getByRole("region", { name: `Topic 1: ${hostile}` });
  expect(within(group).getByRole("heading", { level: 2 }).textContent).toContain(hostile);
  expect(group.querySelector(".em-topic-summary")?.textContent).toBe(hostile);
  expect(group.querySelector(".em-topic-blast")?.textContent).toBe(`Blast radius: garden — ${hostile}`);
  expect(container.querySelector("img, [onerror]")).toBeNull();
});

test.each(["critical", "review", "skim", undefined] as const)(
  "changed topics start open and keep their newest change visible when folded (%s)",
  (attention) => {
    const newer = { ...block, id: "t-seed-body-23456789" };
    mount(
      <Writeup
        {...props}
        revision={4}
        topics={[{ ...topic, attention }]}
        changedBlocks={[
          { blockId: newer.id, revision: 3 },
          { blockId: block.id, revision: 2 },
        ]}
        writeup={{
          sections: [
            { ...section("seed", "why"), blocks: [block] },
            { ...section("seed", "body"), blocks: [newer] },
          ],
        }}
      />,
    );
    const button = screen.getByRole("button", { name: "Topic 1: Plant a seed", expanded: true });
    const header = button.parentElement;
    if (!header) throw new Error("Missing topic header");
    expect(within(header).queryByText("Changed in rev 3")).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(within(header).getByText("Changed in rev 3")).toBeTruthy();
    expect(within(header).queryByText("Changed in rev 2")).toBeNull();
    expect(document.getElementById(button.getAttribute("aria-controls") ?? "")?.hasAttribute("hidden")).toBe(true);
  },
);

test("Details shows a hidden block's change only while folded", async () => {
  const body = { ...block, id: "t-seed-body-12345678", section: "t-seed-body" };
  mount(
    <Writeup
      {...props}
      revision={2}
      topics={[topic]}
      changedBlocks={[{ blockId: body.id, revision: 2 }]}
      writeup={{ sections: [{ ...section(topic.slug, "body"), blocks: [body] }] }}
    />,
  );
  const summary = screen.getByText("Details", { selector: "summary" });
  const details = summary.closest("details");
  if (!details) throw new Error("Missing Details");
  expect(within(summary).getByText("Changed in rev 2")).toBeTruthy();
  expect(summary.textContent).toContain("Changed in revision 2");
  expect(details.open).toBe(false);

  fireEvent.click(summary);
  await waitFor(() => expect(within(summary).queryByText(/Changed in rev/)).toBeNull());
  expect(details.open).toBe(true);
  const changedBlock = details.querySelector<HTMLElement>(".em-reading-block");
  if (!changedBlock) throw new Error("Missing changed detail block");
  expect(within(changedBlock).getByText("Changed in rev 2")).toBeTruthy();

  fireEvent.click(summary);
  await waitFor(() => expect(within(summary).getByText("Changed in rev 2")).toBeTruthy());
  expect(details.open).toBe(false);
});

test("closed Details shows the newest change among its body blocks", () => {
  const older = { ...block, id: "t-seed-body-12345678", section: "t-seed-body" };
  const newer = { ...block, id: "t-seed-body-23456789", section: "t-seed-body" };
  mount(
    <Writeup
      {...props}
      revision={3}
      topics={[topic]}
      changedBlocks={[
        { blockId: newer.id, revision: 3 },
        { blockId: older.id, revision: 2 },
      ]}
      writeup={{ sections: [{ ...section(topic.slug, "body"), blocks: [newer, older] }] }}
    />,
  );
  const summary = screen.getByText("Details", { selector: "summary" });
  expect(within(summary).getByText("Changed in rev 3")).toBeTruthy();
  expect(within(summary).queryByText("Changed in rev 2")).toBeNull();
  expect(summary.closest("details")?.open).toBe(false);
});

test.each([false, true])("unchanged Details has no summary marker (changed why=%s)", (changedWhy) => {
  const why = { ...block, id: "t-seed-why-12345678", section: "t-seed-why" };
  const body = { ...block, id: "t-seed-body-23456789", section: "t-seed-body" };
  mount(
    <Writeup
      {...props}
      topics={[topic]}
      changedBlocks={changedWhy ? [{ blockId: why.id, revision: 2 }] : []}
      writeup={{
        sections: [
          { ...section(topic.slug, "why"), blocks: [why] },
          { ...section(topic.slug, "body"), blocks: [body] },
        ],
      }}
    />,
  );
  const summary = screen.getByText("Details", { selector: "summary" });
  expect(summary.closest("details")?.open).toBe(false);
  expect(within(summary).queryByText(/Changed in rev/)).toBeNull();
  fireEvent.click(summary);
  expect(summary.closest("details")?.open).toBe(true);
  expect(within(summary).queryByText(/Changed in rev/)).toBeNull();
});

test("a changed glossary stays folded and opens on navigation", () => {
  mount(
    <Writeup
      {...props}
      changedBlocks={[{ blockId: block.id, revision: 2 }]}
      writeup={{ sections: [{ ...plain("glossary", "Glossary"), blocks: [block] }] }}
    />,
  );
  const glossary = screen.getByText("Glossary · 1 term").closest("details");
  expect(glossary?.open).toBe(false);
  const target = document.getElementById(`block-${block.id}`);
  expect(target).toBeTruthy();
  act(() => {
    target?.dispatchEvent(new Event("recense:reveal-reading", { bubbles: true }));
  });
  expect(glossary?.open).toBe(true);
  expect(glossary && within(glossary).getByRole("button", { name: "Comment on block" })).toBeTruthy();
});

test("a glossary shows an entry's change only while folded", async () => {
  const entry = { ...block, id: "glossary-12345678", section: "glossary" };
  mount(
    <Writeup
      {...props}
      revision={2}
      changedBlocks={[{ blockId: entry.id, revision: 2 }]}
      writeup={{ sections: [{ ...plain("glossary", "Glossary"), blocks: [entry] }] }}
    />,
  );
  const summary = screen.getByText("Glossary · 1 term");
  const glossary = summary.closest("details");
  if (!glossary) throw new Error("Missing glossary");
  expect(within(summary).getByText("Changed in rev 2")).toBeTruthy();
  expect(summary.textContent).toContain("Changed in revision 2");
  expect(glossary.open).toBe(false);

  fireEvent.click(summary);
  await waitFor(() => expect(within(summary).queryByText(/Changed in rev/)).toBeNull());
  expect(glossary.open).toBe(true);
  const changedBlock = glossary.querySelector<HTMLElement>(".em-reading-block");
  if (!changedBlock) throw new Error("Missing changed glossary entry");
  expect(within(changedBlock).getByText("Changed in rev 2")).toBeTruthy();

  fireEvent.click(summary);
  await waitFor(() => expect(within(summary).getByText("Changed in rev 2")).toBeTruthy());
  expect(glossary.open).toBe(false);
});

test("an unchanged glossary has no summary marker", () => {
  const entry = { ...block, id: "glossary-12345678", section: "glossary" };
  mount(<Writeup {...props} writeup={{ sections: [{ ...plain("glossary", "Glossary"), blocks: [entry] }] }} />);
  const summary = screen.getByText("Glossary · 1 term");
  expect(summary.closest("details")?.open).toBe(false);
  expect(within(summary).queryByText(/Changed in rev/)).toBeNull();
  fireEvent.click(summary);
  expect(summary.closest("details")?.open).toBe(true);
  expect(within(summary).queryByText(/Changed in rev/)).toBeNull();
});

test("loose-list and blockquote Drift blocks are tinted without changing their text or anchors", async () => {
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        overview: "",
        tldr: "",
        decisions:
          "- Drift: A loose-list change.\n\n- A decision.\n\n> dRiFt: A quoted change.\n\nA paragraph mentions drift: later.",
        topics: {},
      },
      [],
    ),
  );
  const decisions = writeup.sections.find((section) => section.key === "decisions");
  if (!decisions) throw new Error("Missing decisions");
  const driftBlocks = decisions.blocks.filter((block) => /^drift:/i.test(block.text.trimStart()));
  expect(driftBlocks).toHaveLength(2);
  expect(driftBlocks.every((block) => block.text.startsWith("\n"))).toBe(true);
  const { container } = mount(<Writeup {...props} writeup={writeup} />);
  expect(container.querySelectorAll("[data-drift]")).toHaveLength(2);
  for (const block of decisions.blocks) {
    const element = document.getElementById(`block-${block.id}`);
    expect(element?.getAttribute("data-block-text")).toBe(block.text);
    expect(element?.closest(".em-reading-block")?.hasAttribute("data-drift")).toBe(driftBlocks.includes(block));
  }
  const first = driftBlocks[0];
  if (!first) throw new Error("Missing Drift block");
  const wrapper = document.getElementById(`block-${first.id}`)?.closest<HTMLElement>(".em-reading-block");
  if (!wrapper) throw new Error("Missing commentable Drift block");
  fireEvent.click(within(wrapper).getByRole("button", { name: "Comment on block" }));
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Explain this drift" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).target).toEqual({ kind: "writeup-span", ...blockAnchor(first) });
});

test("a writeup image renders inline with its caption and takes a block comment", async () => {
  const hash = "a".repeat(64);
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        overview: "![Before](media/before.png) ![After](media/after.png)",
        tldr: "",
        decisions: null,
        topics: {},
      },
      [],
      {
        media: new Map([
          ["media/before.png", hash],
          ["media/after.png", "b".repeat(64)],
        ]),
      },
    ),
  );
  const { container } = mount(<Writeup {...props} writeup={writeup} />);
  const images = container.querySelectorAll<HTMLImageElement>(".em-prose .recense-media img");
  expect(images).toHaveLength(2);
  expect(images[0]?.getAttribute("src")).toBe(`/api/v1/media/${hash}`);
  expect(images[0]?.getAttribute("alt")).toBe("Before");
  expect(container.querySelector("p.recense-media-row")).toBeTruthy();
  expect([...container.querySelectorAll(".recense-media-caption")].map((caption) => caption.textContent)).toEqual([
    "Before",
    "After",
  ]);
  const wrapper = container.querySelector<HTMLElement>(".recense-media")?.closest<HTMLElement>(".em-reading-block");
  if (!wrapper) throw new Error("Missing commentable image block");
  fireEvent.click(within(wrapper).getByRole("button", { name: "Comment on block" }));
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Which one is new?" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  const target = JSON.parse(fetchMock.mock.calls[0]?.[1].body).target;
  expect(target.kind).toBe("writeup-span");
  expect(target.quote ?? target.text ?? JSON.stringify(target)).toContain("Before");
});

test("each writeup image's wrapper gets its size as custom properties, and nothing invalid does", async () => {
  const hash = "a".repeat(64);
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        overview: "![Sized](media/sized.png)\n\n![Unsized](media/unsized.png)",
        tldr: "",
        decisions: null,
        topics: {},
      },
      [],
      {
        media: new Map([
          ["media/sized.png", hash],
          ["media/unsized.png", "b".repeat(64)],
        ]),
        mediaSizes: new Map([[hash, { width: 640, height: 480 }]]),
      },
    ),
  );
  const { container } = mount(<Writeup {...props} writeup={writeup} />);
  const wrappers = container.querySelectorAll<HTMLElement>("span.recense-media");
  expect(wrappers).toHaveLength(2);
  expect(wrappers[0]?.classList.contains("recense-media-sized")).toBe(true);
  expect(wrappers[1]?.classList.contains("recense-media-sized")).toBe(false);
  expect(wrappers[0]?.querySelector("img")?.getAttribute("width")).toBe("640");
  expect(wrappers[0]?.style.getPropertyValue("--recense-media-w")).toBe("640");
  expect(wrappers[0]?.style.getPropertyValue("--recense-media-h")).toBe("480");
  expect(wrappers[1]?.style.getPropertyValue("--recense-media-w")).toBe("");
  expect(wrappers[1]?.style.getPropertyValue("--recense-media-h")).toBe("");
  cleanup();

  const crafted = (attributes: string): RenderedBlock => ({
    ...block,
    html: `<p><span class="recense-media recense-media-sized"><img src="/api/v1/media/${hash}" alt="x" ${attributes}><span class="recense-media-caption">x</span></span></p>`,
  });
  for (const attributes of [
    'width="0" height="10"',
    'width="99999999" height="10"',
    'width="1e3" height="10"',
    'width="70000" height="10"',
    'width="10"',
  ]) {
    const view = mount(<BlockView block={crafted(attributes)} />);
    const wrapper = view.container.querySelector<HTMLElement>("span.recense-media");
    expect(wrapper?.style.getPropertyValue("--recense-media-w"), attributes).toBe("");
    expect(wrapper?.style.getPropertyValue("--recense-media-h"), attributes).toBe("");
    cleanup();
  }
  const legacy: RenderedBlock = {
    ...block,
    html: `<p><span class="recense-media"><img src="/api/v1/media/${hash}" alt="x" width="2000" height="100"><span class="recense-media-caption">x</span></span></p>`,
  };
  const view = mount(<BlockView block={legacy} />);
  const wrapper = view.container.querySelector<HTMLElement>("span.recense-media");
  expect(wrapper?.style.getPropertyValue("--recense-media-w")).toBe("");
  expect(wrapper?.style.getPropertyValue("--recense-media-h")).toBe("");
});

test("a block stored before the rename, with emend-* classes, still sizes its images and finds its pair", async () => {
  const hash = "a".repeat(64);
  const stored: RenderedBlock = {
    ...block,
    html: `<p class="emend-media-row emend-media-pair"><span class="emend-media emend-media-sized"><img src="/api/v1/media/${hash}" alt="x" width="640" height="480"><span class="emend-media-caption">x</span></span><span class="emend-media"><img src="/api/v1/media/${hash}" alt="y"><span class="emend-media-caption">y</span></span></p>`,
  };
  const { container } = mount(<BlockView block={stored} />);
  const wrapper = container.querySelector<HTMLElement>("span.emend-media");
  expect(wrapper?.style.getPropertyValue("--recense-media-w")).toBe("640");
  expect(wrapper?.style.getPropertyValue("--recense-media-h")).toBe("480");
  // The before/after switch shows for an old pair.
  expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
});

test.each([
  { opening: true, phone: false },
  { opening: true, phone: true },
  { opening: false, phone: false },
  { opening: false, phone: true },
])("labels every checked item once (opening=$opening, phone=$phone)", async ({ opening, phone }) => {
  const rendered = await renderWriteup(
    {
      tldr: "",
      overview: "",
      topics: {},
      decisions: "",
      ...(opening ? { area: "Garden" } : {}),
      checked: [
        { kind: "ran", text: "Watered the bed.\n\nAll seeds sprouted." },
        { kind: "read", text: "Read the schedule.\n\nWatering starts at dawn." },
        { kind: "reasoned", text: "Every bed gets water." },
      ],
    },
    [],
  );
  const { container } = mount(<Writeup {...props} phone={phone} writeup={RenderedWriteup.parse(rendered)} />);
  const items = [...container.querySelectorAll("ul.em-proofs > li.em-proof")];
  expect(items.map((item) => [item.getAttribute("data-proof-kind"), item.firstElementChild?.textContent])).toEqual([
    ["ran", "Ran"],
    ["read", "Read"],
    ["reasoned", "Reasoned"],
  ]);
  expect(
    items.map((item) =>
      [...item.querySelectorAll("[data-block-id]")].map((block) => block.getAttribute("data-block-id")),
    ),
  ).toEqual(rendered.checked?.map((item) => item.blockIds));
  for (const id of rendered.checked?.flatMap((item) => item.blockIds) ?? []) {
    expect(container.querySelectorAll(`[id="block-${id}"]`)).toHaveLength(1);
  }
  if (opening) {
    expect(items[0]?.closest('[data-fact="proof"]')).toBeTruthy();
    const fold = container.querySelector('[data-fact="assurance"] details');
    expect(fold?.querySelector("summary")?.textContent).toBe("and 2 more checks");
    expect(items.slice(1).every((item) => fold?.contains(item))).toBe(true);
  } else {
    expect(container.querySelectorAll('[data-reading-section="checked"] .em-proof-kind')).toHaveLength(3);
  }
});

test("omits checks with no visible blocks and counts each referenced block once", () => {
  const first = { ...block, id: "checked-11111111", section: "checked" };
  const second = { ...first, id: "checked-22222222" };
  const writeup: RenderedWriteup = {
    area: "Garden",
    sections: [{ key: "checked", label: "Checked", topic: null, blocks: [first, second] }],
    checked: [
      { kind: "ran", blockIds: ["checked-00000000"] },
      { kind: "read", blockIds: [first.id] },
      { kind: "reasoned", blockIds: [first.id, second.id] },
    ],
  };
  const { container } = mount(<Writeup {...props} writeup={writeup} />);
  expect(container.querySelector('[data-fact="proof"] .em-proof-kind')?.textContent).toBe("Read");
  expect(container.querySelector('[data-fact="assurance"] summary')?.textContent).toBe("and 1 more check");
  expect(container.querySelectorAll(`[id="block-${first.id}"]`)).toHaveLength(1);
  expect(container.querySelectorAll(`[id="block-${second.id}"]`)).toHaveLength(1);
});

test.each([
  {},
  { checked: [] },
  { checked: [{ kind: "unknown", blockIds: ["checked-12345678"] }] },
  { checked: [{ kind: "ran", blockIds: ["checked-00000000"] }] },
])("falls back to unlabelled Proof and Assurance for missing or unusable checked metadata %j", async (metadata) => {
  const rendered = await renderWriteup(
    { tldr: "", overview: "", topics: {}, decisions: "", area: "Garden", checked: "One.\n\nTwo." },
    [],
  );
  const { container } = mount(<Writeup {...props} writeup={RenderedWriteup.parse({ ...rendered, ...metadata })} />);
  expect(container.querySelector(".em-proofs, .em-proof-kind")).toBeNull();
  expect(container.querySelector('[data-fact="proof"] dd > .em-reading-block .em-prose')?.textContent).toBe("One.");
  expect(container.querySelector('[data-fact="assurance"] details > .em-reading-block .em-prose')?.textContent).toBe(
    "Two.",
  );
  expect(container.querySelector('[data-fact="assurance"] summary')?.textContent).toBe("and 1 more check");
});

test("the new opening lifts commentable facts into Risk and Frame in order, with links below", async () => {
  const topics = [{ ...topic, attention: "review" as const }];
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        tldr: "The seed bed stays healthy.",
        whyItMatters: "More plants survive.",
        area: "Garden",
        review: { level: "topics", topics: [topic.slug], reason: "Check the seed bed." },
        checked: "- Unit tests.\n- Browser checks.\n- Manual checks.",
        notChecked: "- Dry weather.\n- Frost.",
        overview: "- **Goal:** Healthy plants.\n- **Change:** More water.",
        outOfScope: "Harvesting.\n\nPruning.",
        whereToLook: "- **Biggest risk:** Flooding.\n- **Look yourself:** Water the seeds.",
        context: "A small garden.",
        decisions: "Keep the soil.",
        glossary: "- **Seed:** A new plant.",
        topics: { seed: { why: "The soil dries.", example: "A seed grows.", body: "Water daily." } },
      },
      topics,
    ),
  );
  // Older revisions stored a verdict immediately before the checks.
  const checkedIndex = writeup.sections.findIndex((section) => section.key === "checked");
  if (checkedIndex === -1) throw new Error("Missing checked section");
  writeup.sections.splice(checkedIndex, 0, {
    key: "review",
    label: "Review",
    topic: null,
    blocks: [
      {
        ...block,
        id: "review-12345678",
        section: "review",
        text: "Read topic “Plant a seed”. Check the seed bed.",
        html: "<p><strong>Read topic “Plant a seed”.</strong> Check the seed bed.</p>",
      },
    ],
  });
  const firstBlock = (key: string) => {
    const first = writeup.sections.find((section) => section.key === key)?.blocks[0];
    if (!first) throw new Error(`Missing ${key}`);
    return first;
  };
  const changedBlocks = ["tldr", "context", "t-seed-why", "review"].map((key) => ({
    blockId: firstBlock(key).id,
    revision: 3,
  }));
  const { container } = mount(
    <Writeup
      {...props}
      revision={3}
      changedSince={2}
      changedBlocks={changedBlocks}
      search={{ tab: "writeup", rev: 3 }}
      topics={topics}
      writeup={writeup}
    />,
  );
  expect(
    [...container.querySelectorAll("[data-reading-section]")].map((group) =>
      group.getAttribute("data-reading-section"),
    ),
  ).toEqual(["tldr", "risk", "frame", "topics-map", "t-seed-why", "decisions", "context", "glossary"]);
  const card = container.querySelector<HTMLElement>('[data-reading-section="tldr"]');
  expect(card?.classList.contains("em-writeup-card")).toBe(true);
  expect(card && within(card).getByRole("heading", { level: 3, name: "Why it matters" })).toBeTruthy();
  expect(card?.querySelector(".em-writeup-matters")?.textContent).toContain("More plants survive.");
  expect(container.querySelectorAll("[data-fact-group] h3")).toHaveLength(0);
  for (const name of ["Risk", "Frame"]) {
    const headings = screen.getAllByRole("heading", { name });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.tagName).toBe("H2");
    expect(headings[0]?.className).toBe("em-writeup-kicker");
  }
  expect(container.querySelector('[data-fact="topics"]')).toBeNull();
  for (const [group, labels, keys] of [
    [
      "risk",
      ["Biggest risk", "Undo", "Proof", "Gaps", "Look yourself", "Assurance"],
      ["risk", "undo", "proof", "gaps", "look", "assurance"],
    ],
    [
      "frame",
      ["Goal", "Change", "Out of scope", "Further down", "Changed"],
      ["goal", "change", "outOfScope", "furtherDown", "since"],
    ],
  ] as const) {
    const wrapper = container.querySelector(`[data-fact-group="${group}"]`);
    expect(wrapper?.querySelector("h3")).toBeNull();
    expect([...(wrapper?.querySelectorAll("dt") ?? [])].map((label) => label.textContent)).toEqual(labels);
    expect([...(wrapper?.querySelectorAll("[data-fact]") ?? [])].map((row) => row.getAttribute("data-fact"))).toEqual(
      keys,
    );
  }
  const summary = container.querySelector('[data-fact="assurance"] summary');
  expect(container.querySelector(".em-proof-kind")).toBeNull();
  expect(summary?.textContent).toBe("and 2 more checks");
  expect(summary?.closest("details")?.open).toBe(false);
  for (const [key, count] of [
    ["proof", 1],
    ["assurance", 2],
    ["gaps", 2],
    ["outOfScope", 2],
  ] as const)
    expect(container.querySelectorAll(`[data-fact="${key}"] [data-block-id]`)).toHaveLength(count);
  for (const key of ["risk", "look", "goal", "change"])
    expect(container.querySelector(`[data-fact="${key}"]`)?.hasAttribute("data-hide-label")).toBe(true);
  expect(container.querySelector('[data-fact="read"], [data-fact="review"]')).toBeNull();
  expect(container.textContent).not.toMatch(/Read everything|Read topic/);
  for (const section of writeup.sections) {
    for (const block of section.blocks)
      expect(container.querySelectorAll(`[id="block-${block.id}"]`)).toHaveLength(section.key === "review" ? 0 : 1);
  }
  expect(
    [...container.querySelectorAll('[data-fact="furtherDown"] a')].map((link) => [
      link.textContent,
      link.getAttribute("href"),
    ]),
  ).toEqual(
    [
      ["decisions", "Decisions & drift"],
      ["context", "Context"],
      ["glossary", "Glossary"],
    ].map(([key, label]) => [label, `/r/${reviewId}?tab=writeup&rev=3#block-${firstBlock(key ?? "").id}`]),
  );
  expect(container.querySelector('[data-fact="furtherDown"] dd')?.textContent).toBe(
    "Decisions & drift · Context · Glossary",
  );
  expect(
    [...container.querySelectorAll('[data-fact="since"] a')].map((link) => [
      link.textContent,
      link.getAttribute("href"),
    ]),
  ).toEqual([
    ["TL;DR", `/r/${reviewId}?tab=writeup&rev=3#block-${firstBlock("tldr").id}`],
    ["Context", `/r/${reviewId}?tab=writeup&rev=3#block-${firstBlock("context").id}`],
    [topic.title, `/r/${reviewId}?tab=writeup&rev=3#block-${firstBlock("t-seed-why").id}`],
  ]);
  expect(container.querySelector('[data-fact="since"] dd')?.textContent).toBe(
    "Since revision 2: TL;DR, Context and topic “Plant a seed”.",
  );
});

test.each([true, false])("Changed links to a topic's changed body block (metadata=%s)", async (metadata) => {
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        area: "Garden",
        overview: "",
        tldr: "Healthy plants.",
        decisions: "",
        topics: { seed: { why: "The soil dries.", body: "Water daily." } },
      },
      [topic],
    ),
  );
  const body = writeup.sections.find((section) => section.key === "t-seed-body")?.blocks[0];
  if (!body) throw new Error("Missing topic body");
  const { container } = mount(
    <Writeup
      {...props}
      revision={3}
      changedSince={2}
      changedBlocks={[{ blockId: body.id, revision: 3 }]}
      topics={metadata ? [topic] : []}
      writeup={writeup}
    />,
  );
  const links = container.querySelectorAll('[data-fact="since"] a');
  expect(links).toHaveLength(1);
  expect(links[0]?.textContent).toBe(metadata ? topic.title : topic.slug);
  expect(links[0]?.getAttribute("href")).toBe(`/r/${reviewId}#block-${body.id}`);
  const target = container.querySelector<HTMLElement>(`#block-${body.id}`);
  if (!target) throw new Error("Missing changed body target");
  if (metadata) {
    const details = target.closest("details.em-writeup-details");
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toContain("Details");
    expect(details?.hasAttribute("open")).toBe(false);
    act(() => revealReadingTarget(target));
    expect(details?.hasAttribute("open")).toBe(true);
  } else {
    expect(container.querySelector("#topic-seed")).toBeNull();
    expect(target.closest("[data-reading-section]")?.getAttribute("data-reading-section")).toBe("t-seed-body");
  }
});

test.each(["Read everything.", "Read topic “Plant a seed”."])(
  "an older-layout revision omits its stored verdict: %s",
  (verdict) => {
    const review: RenderedBlock = {
      ...block,
      id: "review-12345678",
      section: "review",
      text: verdict,
      html: `<p><strong>${verdict}</strong></p>`,
    };
    const { container } = mount(
      <Writeup
        {...props}
        writeup={{
          sections: [
            { ...plain("overview", "Overview"), blocks: [block] },
            { key: "review", label: "Review", topic: null, blocks: [review] },
          ],
        }}
      />,
    );
    expect(container.querySelector('[data-reading-section="review"], [data-fact-group]')).toBeNull();
    expect(container.querySelector(`#block-${review.id}`)).toBeNull();
    expect(container.textContent).not.toContain(verdict);
    expect(screen.queryByRole("heading", { name: "Review" })).toBeNull();
  },
);

test.each(["sent", "resolved"] as const)("comments on hidden writeup text stay visible (state=%s)", (state) => {
  const review: RenderedBlock = {
    ...block,
    id: "review-12345678",
    section: "review",
    text: "Read everything.",
    html: "<p>Read everything.</p>",
  };
  const writeup: RenderedWriteup = {
    sections: [
      { ...plain("overview", "Overview"), blocks: [block] },
      { key: "review", label: "Review", topic: null, blocks: [review] },
    ],
  };
  const verdictThread: ThreadView = {
    id: reviewId,
    createdOn: 1,
    state,
    target: { kind: "writeup-span", ...blockAnchor(review) },
    placement: {
      status: "placed",
      location: { kind: "writeup-span", blockId: review.id, start: 0, end: 16 },
    },
    comments: [{ id: reviewId, author: "user", body: "A synthetic verdict question", sent: true, sentOn: 1 }],
  };
  const overviewId = "22222222-2222-4222-8222-222222222222";
  const overviewThread: ThreadView = {
    id: overviewId,
    createdOn: 1,
    state: "sent",
    target: { kind: "writeup-span", ...blockAnchor(block) },
    placement: {
      status: "placed",
      location: { kind: "writeup-span", blockId: block.id, start: 0, end: blockAnchor(block).quote.length },
    },
    comments: [{ id: overviewId, author: "user", body: "A synthetic overview question", sent: true, sentOn: 1 }],
  };
  const { container, unmount } = mount(
    <Writeup {...props} writeup={writeup} threads={[verdictThread, overviewThread]} />,
  );
  const hiddenComments = screen.getByRole("region", { name: "Comments on hidden text" });
  expect(hiddenComments.closest("[hidden]")).toBeNull();
  const cards = within(hiddenComments).getAllByRole("article");
  expect(cards).toHaveLength(1);
  expect(cards[0]?.id).toBe(`thread-${verdictThread.id}`);
  expect(within(hiddenComments).getByText("The writeup no longer shows the text this comment is on.")).toBeTruthy();
  expect(within(hiddenComments).getByText("A synthetic verdict question")).toBeTruthy();
  expect(hiddenComments.querySelector(`#thread-${overviewThread.id}`)).toBeNull();
  expect(container.querySelector("#block-review-12345678")).toBeNull();

  unmount();
  mount(<Writeup {...props} writeup={writeup} threads={[overviewThread]} />);
  expect(screen.queryByRole("region", { name: "Comments on hidden text" })).toBeNull();
});

test.each([false, true])("changed comments on hidden writeup text link to their card (read-only=%s)", (readOnly) => {
  const review: RenderedBlock = {
    ...block,
    id: "review-12345678",
    section: "review",
    text: "Read everything.",
    html: "<p>Read everything.</p>",
  };
  const thread: ThreadView = {
    id: reviewId,
    createdOn: 1,
    state: "answered",
    target: { kind: "writeup-span", ...blockAnchor(review) },
    placement: {
      status: "placed",
      location: { kind: "writeup-span", blockId: review.id, start: 0, end: 16 },
    },
    comments: [
      { id: reviewId, author: "user", body: "A synthetic verdict question", sent: true, sentOn: 1 },
      {
        id: "22222222-2222-4222-8222-222222222222",
        author: "agent",
        body: "A synthetic reply",
        sent: false,
        sentOn: null,
      },
    ],
  };
  mount(
    <ReadOnlyReview value={readOnly}>
      <Writeup
        {...props}
        revision={3}
        changedBlocks={[{ blockId: review.id, revision: 3 }]}
        threads={[thread]}
        writeup={{
          sections: [
            { ...plain("overview", "Overview"), blocks: [block] },
            { key: "review", label: "Review", topic: null, blocks: [review] },
          ],
        }}
      />
    </ReadOnlyReview>,
  );
  const hiddenComments = screen.getByRole("region", { name: "Comments on hidden text" });
  expect(hiddenComments.getAttribute("data-depth-layer")).toBe("trail");
  expect([...document.querySelectorAll("[data-reading-section]")].at(-1)).toBe(hiddenComments);
  const card = within(hiddenComments).getByRole("article");
  const href = within(card).getByRole("link", { name: "Changed in revision 3" }).getAttribute("href");
  expect(card.id).toBe(`thread-${thread.id}`);
  expect(href?.endsWith(`#thread-${thread.id}`)).toBe(true);
  if (readOnly) expect(href).toBe(`#thread-${thread.id}`);
  else expect(href).toBe(`/r/${reviewId}?rev=3&tab=writeup#thread-${thread.id}`);
  expect(document.querySelector('a[href*="#block-review-12345678"]')).toBeNull();
});

test("an opening without labelled lines keeps its available rows and the unlifted sections below", async () => {
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        area: "Garden",
        tldr: "Healthy plants.",
        overview: "- Plant seeds.\n- Add water.",
        checked: "One check.",
        whereToLook: "Water the seeds.",
        decisions: "",
        topics: {},
      },
      [],
    ),
  );
  const { container } = mount(<Writeup {...props} writeup={writeup} />);
  expect([...container.querySelectorAll("[data-fact] dt")].map((label) => label.textContent)).toEqual(["Proof"]);
  expect(
    [...container.querySelectorAll("[data-reading-section]")].map((group) =>
      group.getAttribute("data-reading-section"),
    ),
  ).toEqual(["tldr", "risk", "whereToLook", "overview", "decisions"]);
  expect(container.querySelector('[data-reading-section="overview"]')?.classList.contains("em-writeup-pair")).toBe(
    true,
  );
  expect(screen.getByRole("heading", { name: "Overview" }).className).not.toContain("em-writeup-kicker");
  expect(container.querySelector('[data-reading-section="whereToLook"]')?.classList.contains("em-writeup-guide")).toBe(
    true,
  );
  expect(container.querySelector('[data-fact="assurance"]')).toBeNull();
  expect(container.querySelector('[data-fact="furtherDown"]')).toBeNull();
});

test("partly lifted sections keep leftovers once, with the overview pair and old Check first callout", async () => {
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        area: "Garden",
        tldr: "Plants.",
        overview: "- **Goal:** Healthy plants.\n- **Change:** More water.\n- Soil stays.\n- Seeds stay.",
        whereToLook: "- **Biggest risk:** Flooding.\n- **Check first:** The seed bed.",
        decisions: "",
        topics: {},
      },
      [],
    ),
  );
  const { container } = mount(<Writeup {...props} writeup={writeup} />);
  const overview = container.querySelector('[data-reading-section="overview"]');
  expect(overview?.classList.contains("em-writeup-pair")).toBe(true);
  expect([...(overview?.querySelectorAll("[data-block-id]") ?? [])].map((block) => block.textContent)).toEqual([
    "Soil stays.",
    "Seeds stay.",
  ]);
  const where = container.querySelector('[data-reading-section="whereToLook"]');
  expect(where?.classList.contains("em-writeup-guide")).toBe(true);
  expect(where?.textContent).toContain("Check first: The seed bed.");
  expect(container.querySelector('[data-fact="look"]')).toBeNull();
  for (const block of writeup.sections.flatMap((section) => section.blocks))
    expect(container.querySelectorAll(`[id="block-${block.id}"]`)).toHaveLength(1);
});

test("soft-broken labelled paragraphs stay in their sections across Decide and Frame", async () => {
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        area: "Garden",
        tldr: "Healthy plants.",
        overview: "**Goal:** Healthy plants.\n**Change:** More water.",
        whereToLook: "**Biggest risk:** Flooding.\n**Look yourself:** The seed bed.",
        decisions: "",
        topics: {},
      },
      [],
    ),
  );
  const { container } = mount(<Writeup {...props} writeup={writeup} />);
  expect(
    container.querySelector('[data-fact="risk"], [data-fact="look"], [data-fact="goal"], [data-fact="change"]'),
  ).toBeNull();
  expect(
    [...container.querySelectorAll("[data-reading-section]")].map((group) =>
      group.getAttribute("data-reading-section"),
    ),
  ).toEqual(["tldr", "whereToLook", "overview", "decisions"]);
  for (const [key, text] of [
    ["overview", "Goal: Healthy plants.\nChange: More water."],
    ["whereToLook", "Biggest risk: Flooding.\nLook yourself: The seed bed."],
  ]) {
    const blocks = writeup.sections.find((section) => section.key === key)?.blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]?.text).toBe(text);
    const rendered = container.querySelector(`[data-reading-section="${key}"] .em-prose`);
    expect(rendered?.textContent).toBe(text);
    expect(rendered?.getAttribute("data-block-id")).toBe(blocks?.[0]?.id);
  }
});

test("Title-cased bold labels sharing one paragraph stay in Where to look in Decide", async () => {
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        area: "Garden",
        tldr: "Healthy plants.",
        overview: "",
        whereToLook: "**Biggest Risk:** A.\n**Look Yourself:** B.",
        decisions: "",
        topics: {},
      },
      [],
    ),
  );
  const blocks = writeup.sections.find((section) => section.key === "whereToLook")?.blocks;
  expect(blocks).toHaveLength(1);
  const { container } = mount(<Writeup {...props} writeup={writeup} />);
  expect(container.querySelector('[data-fact="risk"], [data-fact="look"]')).toBeNull();
  const sections = [...container.querySelectorAll("[data-reading-section]")].map((group) =>
    group.getAttribute("data-reading-section"),
  );
  expect(sections.indexOf("whereToLook")).toBeGreaterThan(sections.indexOf("tldr"));
  expect(container.querySelector('[data-reading-section="whereToLook"]')?.getAttribute("data-depth-layer")).toBe(
    "decide",
  );
  const prose = container.querySelectorAll('[data-reading-section="whereToLook"] .em-prose');
  expect(prose).toHaveLength(1);
  expect(prose[0]?.getAttribute("data-block-id")).toBe(blocks?.[0]?.id);
  expect(prose[0]?.textContent).toBe("Biggest Risk: A.\nLook Yourself: B.");
});

test("lifted rows preserve server sanitization and topic markup stays isolated text", async () => {
  const hostile = [
    '<script>alert(1)</script><img src=x onerror=alert(1) srcset="x 1x">',
    '<span onclick="alert(1)" style="color:red" srcdoc="unsafe">raw</span>',
    "<svg onload=alert(1)></svg>",
    "[bad](javascript:alert%281%29) [x](JAVASCRIPT:alert(1))",
    "[http](http://example.com) [https](https://example.com) [mail](mailto:review@example.com)",
  ].join(" ");
  // Nested details belong in the source-based rows; labelled facts leave block structures below.
  const nestedHostile = `${hostile} <details open ontoggle=alert(1)><summary>More</summary>Extra</details>`;
  const diagram = 'graph TD\n  A-->B\n  click A "javascript:alert(1)"';
  const topics = [{ ...topic, title: "<img src=x onerror=alert(1)>", attention: "critical" as const }];
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        area: "Garden",
        tldr: "Plants.",
        overview: `- **Goal:** ${hostile}\n- **Change:** ${hostile}`,
        decisions: "",
        context: "A small garden.",
        whereToLook: `- **Biggest risk:** ${hostile}\n- **Look yourself:** ${hostile}`,
        checked: `- First ${nestedHostile}\n- Second ${nestedHostile}\n\n\`\`\`mermaid\n${diagram}\n\`\`\``,
        notChecked: `- ${nestedHostile}`,
        outOfScope: `- ${nestedHostile}`,
        topics: {},
      },
      topics,
    ),
  );
  const blocks = new Map(
    writeup.sections.flatMap((section) => section.blocks.map((block) => [block.id, block] as const)),
  );
  const { container } = mount(<Writeup {...props} topics={topics} writeup={writeup} />);
  for (const key of ["risk", "look", "proof", "assurance", "goal", "change", "gaps", "outOfScope"]) {
    const row = container.querySelector(`[data-fact="${key}"]`);
    if (!row) throw new Error(`Missing ${key} row`);
    const prose = row.querySelectorAll<HTMLElement>(".em-prose");
    expect(prose.length).toBeGreaterThan(0);
    for (const element of prose) {
      const block = blocks.get(element.dataset.blockId ?? "");
      if (!block) throw new Error(`Missing server block for ${key}`);
      expect(block.kind).not.toBe("diagram");
      const parsed = new DOMParser().parseFromString(block.html, "text/html").body;
      expect(element.childNodes).toHaveLength(parsed.childNodes.length);
      for (const [index, child] of element.childNodes.entries()) {
        expect(child.isEqualNode(parsed.childNodes.item(index))).toBe(true);
      }
    }
    expect(row.querySelector("script, img[src]")).toBeNull();
    expect(row.querySelector('[href^="javascript:"]')).toBeNull();
    expect(row.textContent).toContain("bad");
  }
  const facts = container.querySelector('[data-reading-section="risk"]');
  if (!facts) throw new Error("Missing opening facts");
  const diagramBlock = [...blocks.values()].find((block) => block.kind === "diagram");
  if (!diagramBlock) throw new Error("Missing server diagram");
  expect(diagramBlock.html).toBe("");
  expect(diagramBlock.source).toBe(diagram);
  const renderedDiagram = facts.querySelector(`[data-block-id="${diagramBlock.id}"]`);
  expect(renderedDiagram?.closest("[data-fact]")?.getAttribute("data-fact")).toBe("assurance");
  expect(renderedDiagram?.querySelector(".em-prose")).toBeNull();
  expect(renderedDiagram?.querySelector("pre")?.textContent).toBe(diagram);
  const frame = renderedDiagram?.querySelector("iframe");
  expect(frame?.getAttribute("src")).toBe("/mermaid-frame.html");
  expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame?.hasAttribute("srcdoc")).toBe(false);
  expect(facts.querySelectorAll("iframe")).toHaveLength(1);
  const opening = container.querySelectorAll(
    '[data-reading-section="tldr"], [data-reading-section="risk"], [data-reading-section="frame"]',
  );
  for (const group of opening) {
    for (const element of [group, ...group.querySelectorAll("*")]) {
      for (const attribute of element.attributes) {
        // Mermaid's trusted frame owns its numeric height; authored markup has no style exception.
        if (element === frame && attribute.name === "style") {
          expect(frame.style.length).toBe(1);
          expect(frame.style.item(0)).toBe("height");
          expect(frame.style.height).toBe("160px");
          continue;
        }
        expect(attribute.name).not.toMatch(/^on|^(?:style|srcset|srcdoc)$/i);
      }
    }
  }
  for (const anchor of container.querySelectorAll("[data-fact] [href]")) {
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("/r/") || href.startsWith("#")) continue;
    expect(["http:", "https:", "mailto:"]).toContain(new URL(href).protocol);
  }
  const title = container.querySelector('[data-reading-section="topics-map"] span[dir="auto"]');
  expect(title?.textContent).toBe(topics[0]?.title);
  expect(title?.children).toHaveLength(0);
});

test.each([
  [["item", "item"], true],
  [["item"], false],
  [["item", "item", "item"], false],
  [["paragraph", "item"], false],
] as const)("the new overview pairs only two item blocks: %j", (kinds, paired) => {
  const blocks = kinds.map((kind, index) => ({ ...block, kind, id: `overview-1234567${index}` }));
  const { container } = mount(
    <Writeup {...props} writeup={{ area: "Garden", sections: [{ ...plain("overview", "Overview"), blocks }] }} />,
  );
  expect(container.querySelector('[data-reading-section="overview"]')?.classList.contains("em-writeup-pair")).toBe(
    paired,
  );
  expect(container.querySelector("[data-reading-section]")?.getAttribute("data-reading-section")).toBe("tldr");
});

test("an area-only empty writeup still has a TL;DR card and omits empty Facts", () => {
  const { container } = mount(<Writeup {...props} writeup={{ area: "Garden", sections: [] }} />);
  expect(screen.getByRole("heading", { name: "TL;DR", level: 2 })).toBeTruthy();
  expect(container.querySelector("[data-fact-group]")).toBeNull();
});

test("Further down skips empty groups and stored topics without metadata", () => {
  const { container } = mount(
    <Writeup
      {...props}
      writeup={{
        area: "Garden",
        sections: [plain("overview", "Overview"), { ...section("seed", "why"), blocks: [block] }],
      }}
    />,
  );
  expect(container.querySelector('[data-reading-section="t-seed-why"]')).not.toBeNull();
  expect(container.querySelector("[data-fact-group]")).toBeNull();
});

test("stored topic sections without metadata follow ranked topics in section order, outside Further down", () => {
  const stored = (slug: string, suffix: "why" | "example" | "body") => {
    const value = section(slug, suffix);
    return { ...value, blocks: [{ ...block, id: `${value.key}-12345678`, section: value.key }] };
  };
  const { container } = mount(
    <Writeup
      {...props}
      topics={[topic, second]}
      writeup={{
        area: "Garden",
        sections: [
          stored("missing", "body"),
          plain("overview", "Overview"),
          section("water", "why"),
          stored("lost", "example"),
          {
            ...plain("decisions", "Decisions"),
            blocks: [{ ...block, id: "decisions-12345678", section: "decisions" }],
          },
          section("seed", "why"),
          stored("missing", "why"),
        ],
      }}
    />,
  );
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-reading-section]")].map((group) => [
      group.dataset.readingSection,
      group.dataset.depthLayer,
    ]),
  ).toEqual([
    ["tldr", "decide"],
    ["risk", "decide"],
    ["frame", "frame"],
    ["overview", "frame"],
    ["topics-map", "frame"],
    ["t-seed-why", "topics"],
    ["t-water-why", "topics"],
    ["t-missing-body", "topics"],
    ["t-lost-example", "topics"],
    ["t-missing-why", "topics"],
    ["decisions", "trail"],
  ]);
  expect(container.querySelector('[data-fact="furtherDown"] dd')?.textContent).toBe("Decisions & drift");
});

test.each([false, true])("a fact block keeps its target, marker and outline count (folded=%s)", async (folded) => {
  const checked: RenderedBlock = {
    ...block,
    id: "checked-12345678",
    section: "checked",
    text: "Unit tests pass.",
    html: "<p>Unit tests pass.</p>",
  };
  const target = { kind: "writeup-span" as const, ...blockAnchor(checked) };
  const thread: ThreadView = {
    id: reviewId,
    createdOn: 1,
    state: "open",
    target,
    placement: {
      status: "placed",
      location: { kind: "writeup-span", blockId: checked.id, start: 0, end: checked.text.length },
    },
    comments: [{ id: reviewId, author: "user", body: "Which tests?", sent: false, sentOn: null }],
  };
  const { container } = mount(
    <Writeup
      {...props}
      threads={[thread]}
      changedBlocks={[{ blockId: checked.id, revision: 2 }]}
      writeup={{
        area: "Garden",
        sections: [
          {
            key: "checked",
            label: "Checked",
            topic: null,
            blocks: [
              ...(folded
                ? [{ ...checked, id: "checked-87654321", text: "First check.", html: "<p>First check.</p>" }]
                : []),
              checked,
            ],
          },
        ],
      }}
    />,
  );
  const facts = container.querySelector<HTMLElement>('[data-reading-section="risk"]');
  if (!facts) throw new Error("Missing Facts");
  expect(facts.querySelector(".em-reading-block__change")).not.toBeNull();
  const outline = screen.getByRole("navigation", { name: "Writeup outline" });
  expect(within(outline).getByRole("button", { name: /Risk/ }).textContent).toContain("1 comment");
  const row = facts.querySelector<HTMLElement>(`[data-fact="${folded ? "assurance" : "proof"}"]`);
  if (!row) throw new Error("Missing check row");
  if (folded) {
    const summary = row.querySelector("summary");
    expect(summary?.textContent).toContain("and 1 more check");
    expect(summary?.textContent).toContain("Changed in revision 2");
    expect(summary?.closest("details")?.open).toBe(false);
    const target = row.querySelector<HTMLElement>(`#block-${checked.id}`);
    if (!target) throw new Error("Missing folded check");
    act(() => revealReadingTarget(target));
    expect(summary?.closest("details")?.open).toBe(true);
  }
  fireEvent.click(within(row).getByRole("button", { name: "Comment on block" }));
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Add browser coverage" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).target).toEqual(target);
});

test.each(["jump", "recense:reveal-reading", "beforematch"])(
  "Assurance opens for %s and remembers its own fold",
  (event) => {
    const checks: RenderedBlock[] = [
      { ...block, id: "checked-11111111", section: "checked", text: "First check.", html: "<p>First check.</p>" },
      { ...block, id: "checked-22222222", section: "checked", text: "Second check.", html: "<p>Second check.</p>" },
    ];
    const folds = { reviewId, revision: 2, choices: new Map<string, boolean>() };
    const reader = (revision: number) => (
      <ReadingFoldContext.Provider value={{ ...folds, revision }}>
        <Writeup
          {...props}
          revision={revision}
          writeup={{ area: "Garden", sections: [{ key: "checked", label: "Checked", topic: null, blocks: checks }] }}
        />
      </ReadingFoldContext.Provider>
    );
    const { container, unmount } = mount(reader(2));
    const target = container.querySelector<HTMLElement>("#block-checked-22222222");
    const details = target?.closest("details");
    if (!target || !details) throw new Error("Missing folded check");
    expect(details.open).toBe(false);
    act(() => {
      if (event === "jump") revealReadingTarget(target);
      else target.dispatchEvent(new Event(event, { bubbles: true }));
    });
    expect(details.open).toBe(true);
    expect(folds.choices.get(JSON.stringify([reviewId, 2, "checked-more", "details"]))).toBe(true);
    unmount();
    const remembered = mount(reader(2));
    expect(remembered.container.querySelector<HTMLDetailsElement>('[data-fact="assurance"] details')?.open).toBe(true);
    remembered.unmount();
    const next = mount(reader(3));
    expect(next.container.querySelector<HTMLDetailsElement>('[data-fact="assurance"] details')?.open).toBe(false);
  },
);

test("a thread jump reveals its check inside Assurance", () => {
  const checked: RenderedBlock = { ...block, id: "checked-22222222", section: "checked" };
  const thread: ThreadView = {
    id: reviewId,
    createdOn: 1,
    state: "open",
    target: { kind: "writeup-span", ...blockAnchor(checked) },
    placement: {
      status: "placed",
      location: { kind: "writeup-span", blockId: checked.id, start: 0, end: checked.text.length },
    },
    comments: [{ id: reviewId, author: "user", body: "Explain the second check.", sent: false, sentOn: null }],
  };
  const { container } = mount(
    <Writeup
      {...props}
      threads={[thread]}
      threadJump={{ threadId: thread.id, token: {} }}
      writeup={{
        area: "Garden",
        sections: [
          {
            key: "checked",
            label: "Checked",
            topic: null,
            blocks: [{ ...checked, id: "checked-11111111" }, checked],
          },
        ],
      }}
    />,
  );
  expect(container.querySelector<HTMLDetailsElement>('[data-fact="assurance"] details')?.open).toBe(true);
  expect(screen.getByText("Explain the second check.")).toBeTruthy();
});

test.each([
  ["checked", "risk", "Proof"],
  ["outOfScope", "frame", "Out of scope"],
] as const)("Facts omits the empty captioned group when only %s is present", (key, group, label) => {
  const { container } = mount(
    <Writeup
      {...props}
      writeup={{
        area: "Garden",
        sections: [
          {
            key,
            label,
            topic: null,
            blocks: [{ ...block, id: `${key}-12345678`, section: key }],
          },
        ],
      }}
    />,
  );
  expect(
    [...container.querySelectorAll("[data-fact-group]")].map((element) => element.getAttribute("data-fact-group")),
  ).toEqual([group]);
  expect([...container.querySelectorAll("[data-fact] dt")].map((element) => element.textContent)).toEqual([label]);
});

test("computed facts isolate literal titles, undo text and doc paths even when hostile", () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const path = `docs/${hostile}.md`;
  const why: RenderedBlock = {
    ...block,
    id: "t-seed-why-12345678",
    section: "t-seed-why",
    text: `Undo: ${hostile}`,
    html: "<p>Undo details.</p>",
  };
  const { container } = mount(
    <Writeup
      {...props}
      revision={3}
      changedSince={2}
      changedBlocks={[
        { blockId: why.id, revision: 3 },
        { blockId: "doc-12345678-12345678", revision: 3 },
      ]}
      topics={[{ ...topic, title: hostile, attention: "critical" }]}
      docs={[
        {
          path,
          title: hostile,
          kind: "markdown",
          blocks: [{ ...block, id: "doc-12345678-12345678", section: "doc-12345678" }],
        },
      ]}
      writeup={{ area: "Garden", sections: [{ ...section("seed", "why"), blocks: [why] }] }}
    />,
  );
  const facts = container;
  expect(facts?.querySelectorAll("img, script")).toHaveLength(0);
  expect(facts.querySelector('[data-fact="topics"]')).toBeNull();
  expect(facts?.querySelector('[data-fact="undo"] dd')?.textContent).toBe(`${hostile} (${hostile})`);
  expect(facts?.querySelector('[data-fact="since"] dd')?.textContent).toBe(
    `Since revision 2: topic “${hostile}” and ${path}.`,
  );
  expect([...(facts?.querySelectorAll("[data-fact] bdi") ?? [])].map((part) => part.textContent)).toEqual([
    hostile,
    hostile,
    hostile,
    path,
  ]);
});

test("PDI and RLO in agent text are removed while recense's fact text stays outside each bdi in order", () => {
  const title = "Docs\u2069\u202e";
  const undo = "Restore state\u2069\u202e";
  const why = { ...block, id: "t-seed-why-12345678", section: "t-seed-why" as const, text: `Undo: ${undo}` };
  const { container } = mount(
    <Writeup
      {...props}
      revision={3}
      changedSince={2}
      changedBlocks={[{ blockId: why.id, revision: 3 }]}
      topics={[
        { ...topic, title, attention: "critical" },
        { ...second, attention: "critical" },
        ...["Third", "Fourth", "Fifth"].map((title) => ({
          ...second,
          slug: title.toLowerCase(),
          title,
          attention: "critical" as const,
        })),
      ]}
      writeup={{ area: "Garden", sections: [{ ...section("seed", "why"), blocks: [why] }] }}
    />,
  );
  for (const [key, expected, following, text] of [
    ["undo", ["Restore state", "Docs"], [" (", ")"], "Restore state (Docs)"],
    ["since", ["Docs"], ["”"], "Since revision 2: topic “Docs”."],
  ] as const) {
    const fact = container.querySelector(`[data-fact="${key}"] dd`);
    expect(fact?.textContent).toBe(text);
    const parts = [...(fact?.querySelectorAll("bdi") ?? [])];
    expect(parts.map((part) => part.textContent)).toEqual(expected);
    for (const [index, part] of parts.entries()) {
      const outer = key === "since" ? part.parentElement : part;
      expect(outer?.parentElement).toBe(fact);
      if (key === "since") expect(outer?.getAttribute("href")).toBe(`/r/${reviewId}#block-${why.id}`);
      expect(outer?.nextSibling?.textContent).toBe(following[index]);
      if (outer?.nextSibling) expect(outer.nextSibling.nodeType).toBe(Node.TEXT_NODE);
    }
  }
});

test("a revision that only removed a paragraph keeps Since and explains that removals are not tracked", async () => {
  const input = { area: "Garden", overview: "", decisions: "", topics: {} };
  const before = RenderedWriteup.parse(await renderWriteup({ ...input, tldr: "Keep the soil.\n\nWater daily." }, []));
  const after = RenderedWriteup.parse(await renderWriteup({ ...input, tldr: "Keep the soil." }, []));
  const previous = new Set(before.sections.flatMap((section) => section.blocks.map((block) => block.id)));
  const changedBlocks = after.sections.flatMap((section) =>
    section.blocks.filter((block) => !previous.has(block.id)).map((block) => ({ blockId: block.id, revision: 3 })),
  );
  expect(before.sections[0]?.blocks).toHaveLength(2);
  expect(after.sections[0]?.blocks).toHaveLength(1);
  expect(changedBlocks).toEqual([]);
  const { container } = mount(
    <Writeup {...props} revision={3} changedSince={2} changedBlocks={changedBlocks} writeup={after} />,
  );
  expect(container.querySelector('[data-fact="read"]')).toBeNull();
  expect(container.querySelector('[data-fact="since"] dd')?.textContent).toBe(
    "Since revision 2: no new text in the writeup or Markdown docs. Removed text is not tracked.",
  );
});

test("comments on both paired overview blocks share a usable gutter chip when their first lines align", () => {
  const blocks: RenderedBlock[] = [
    { ...block, kind: "item", id: "overview-11111111", text: "Plants grow.", html: "<ul><li>Plants grow.</li></ul>" },
    {
      ...block,
      kind: "item",
      id: "overview-22222222",
      text: "Water daily.",
      html: "<ul><li>Water daily.</li></ul>",
    },
  ];
  const threads: ThreadView[] = blocks.map((block, index) => ({
    id: `11111111-1111-4111-8111-11111111111${index}`,
    createdOn: 1,
    state: "open",
    target: { kind: "writeup-span", ...blockAnchor(block) },
    placement: {
      status: "placed",
      location: { kind: "writeup-span", blockId: block.id, start: 0, end: block.text.length },
    },
    comments: [
      {
        id: reviewId,
        author: "user",
        body: index === 0 ? "Explain the goal" : "Explain the change",
        sent: false,
        sentOn: null,
      },
    ],
  }));
  const { container } = mount(
    <Writeup
      {...props}
      threads={threads}
      writeup={{ area: "Garden", sections: [{ ...plain("overview", "Overview"), blocks }] }}
    />,
  );
  expect(container.querySelectorAll("[data-thread-chip]")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "2 comments" }));
  expect(screen.getByText("Explain the goal")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("Explain the change")).toBeTruthy();
});

test("Code controls follow focus, preserve diff order and disambiguate file names", () => {
  const onOpen = vi.fn();
  const files = [
    { ...file, id: "first", path: "src/seed.txt", order: 2 },
    { ...file, id: "second", path: "test/seed.txt", order: 1 },
    { ...file, id: "third", path: "src/water.txt", order: 3 },
    { ...file, id: "doc", role: "doc" as const },
  ];
  const ui = (current?: CodeFocus) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Writeup
          {...props}
          topics={[topic]}
          files={files}
          writeup={{ sections: [section(topic.slug, "body")] }}
          code={{ current, onOpen }}
        />
      </ToastProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(ui());
  const code = screen.getByRole("button", { name: `Code: ${topic.title}` });
  expect(code.textContent).toBe("Code ");
  expect(code.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(code);
  expect(onOpen).toHaveBeenLastCalledWith({ kind: "topic", slug: topic.slug }, code);
  const chips = within(screen.getByRole("list", { name: "Files" })).getAllByRole("button");
  expect(chips.map((chip) => chip.textContent)).toEqual(["test/seed.txt", "src/seed.txt", "water.txt"]);
  expect(chips[2]?.title).toBe("src/water.txt");
  rerender(ui({ kind: "topic", slug: topic.slug }));
  expect(code.getAttribute("aria-expanded")).toBe("true");
  const chip = chips[0];
  if (!chip) throw new Error("Missing chip");
  fireEvent.click(chip);
  expect(onOpen).toHaveBeenLastCalledWith({ kind: "file", id: "second" }, chip);
  rerender(ui({ kind: "file", id: "second" }));
  expect(code.getAttribute("aria-expanded")).toBe("false");
  expect(chip.getAttribute("aria-expanded")).toBe("true");
});

test("without Code controls the topic action and file chips remain diff links", () => {
  mount(<Writeup {...props} topics={[topic]} files={[file]} writeup={{ sections: [section(topic.slug, "body")] }} />);
  expect(screen.getByRole("link", { name: `Files in diff: ${topic.title}` }).getAttribute("href")).toContain(
    "#diff-topic-seed",
  );
  const chip = within(screen.getByRole("list", { name: "Files" })).getByRole("link", { name: "seed.txt" });
  expect(chip.getAttribute("href")).toContain(`#diff-file-${file.id}`);
  expect(chip.title).toBe(file.path);
  expect(chip.getAttribute("dir")).toBe("auto");
});

test("Code titles and file chips keep hostile text inert", () => {
  const hostile = "<script>evil()</script><img src=x onerror=evil()><svg onload=evil()></svg>javascript:evil()";
  const { container } = mount(
    <Writeup
      {...props}
      topics={[{ ...topic, title: hostile }]}
      files={[{ ...file, path: hostile }]}
      writeup={{ sections: [section(topic.slug, "body")] }}
      code={{ onOpen: vi.fn() }}
    />,
  );
  const code = screen.getAllByRole("button", { name: `Code: ${hostile}` });
  expect(code).toHaveLength(2);
  expect(code[1]?.title).toBe(hostile);
  expect(container.querySelector("script, img, [onerror], [onload], a[href^='javascript:']")).toBeNull();
});

test("topic file chips stay visible after closed Details and follow the topic fold", () => {
  mount(
    <Writeup
      {...props}
      topics={[topic]}
      files={[file]}
      writeup={{ sections: [{ ...section(topic.slug, "body"), blocks: [block] }] }}
    />,
  );
  const details = screen.getByText("Details", { selector: "summary" }).closest("details");
  const files = screen.getByRole("list", { name: "Files" });
  expect(details?.open).toBe(false);
  expect(files.previousElementSibling).toBe(details);
  expect(files.parentElement?.lastElementChild).toBe(files);
  expect(files.closest("details, [hidden]")).toBeNull();
  const fold = screen.getByRole("button", { name: "Topic 1: Plant a seed" });
  fireEvent.click(fold);
  expect(screen.queryByRole("list", { name: "Files" })).toBeNull();
  fireEvent.click(fold);
  expect(screen.getByRole("list", { name: "Files" })).toBe(files);
  expect(details?.open).toBe(false);
});

test.each([true, false])(
  "a topic without body has no Details fold and keeps its files visible (files=%s)",
  (hasFiles) => {
    const { container } = mount(
      <Writeup
        {...props}
        topics={[topic]}
        files={hasFiles ? [file] : []}
        writeup={{ sections: [section(topic.slug, "why")] }}
      />,
    );
    const details = container.querySelector<HTMLDetailsElement>("details.em-writeup-details");
    expect(details).toBeNull();
    const files = screen.queryByRole("list", { name: "Files" });
    if (!hasFiles) expect(files).toBeNull();
    else {
      expect(files).toBeTruthy();
      expect(files?.closest("details, [hidden]")).toBeNull();
      expect(files?.parentElement?.lastElementChild).toBe(files);
      fireEvent.click(screen.getByRole("button", { name: "Topic 1: Plant a seed" }));
      expect(files?.closest("[hidden]")).toBeTruthy();
      expect(screen.queryByRole("list", { name: "Files" })).toBeNull();
    }
  },
);

test("a body-only topic and its Details remember independent fold choices with files", async () => {
  const choices = new Map<string, boolean>();
  // Match review.tsx: one stable context value backed by the reading entry's fold map.
  const readingFolds = { reviewId, revision: props.revision, choices };
  const body = { ...block, id: "t-seed-body-12345678", section: "t-seed-body" };
  const ui = (
    <ReadingFoldContext value={readingFolds}>
      <Writeup
        {...props}
        topics={[topic]}
        files={[file]}
        writeup={{ sections: [{ ...section(topic.slug, "body"), blocks: [body] }] }}
      />
    </ReadingFoldContext>
  );
  const topicToggle = () => screen.getByRole("button", { name: "Topic 1: Plant a seed" });
  const summary = () => screen.getByText("Details", { selector: "summary" });
  const topicKey = JSON.stringify([reviewId, props.revision, body.section]);
  const detailsKey = JSON.stringify([reviewId, props.revision, body.section, "details"]);
  const first = mount(ui);
  expect(topicToggle().getAttribute("aria-expanded")).toBe("true");
  expect(summary().closest("details")?.open).toBe(false);
  fireEvent.click(topicToggle());
  expect(topicToggle().getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(topicToggle());
  expect(topicToggle().getAttribute("aria-expanded")).toBe("true");
  expect(summary().closest("details")?.open).toBe(false);
  fireEvent.click(summary());
  await waitFor(() => expect(choices.get(detailsKey)).toBe(true));
  expect(choices.get(topicKey)).toBe(true);
  const files = screen.getByRole("list", { name: "Files" });
  expect(files.closest("details")).toBeNull();
  expect(files.previousElementSibling).toBe(summary().closest("details"));
  expect(files.previousElementSibling?.querySelector("[data-block-id]")?.getAttribute("data-block-id")).toBe(body.id);

  fireEvent.click(topicToggle());
  expect(choices.get(topicKey)).toBe(false);
  expect(choices.get(detailsKey)).toBe(true);
  first.unmount();
  const second = mount(ui);
  expect(topicToggle().getAttribute("aria-expanded")).toBe("false");
  expect(summary().closest("details")?.open).toBe(true);
  fireEvent.click(topicToggle());
  expect(summary().closest("details")?.open).toBe(true);
  fireEvent.click(summary());
  await waitFor(() => expect(choices.get(detailsKey)).toBe(false));
  expect(choices.get(topicKey)).toBe(true);
  second.unmount();
  mount(ui);
  expect(topicToggle().getAttribute("aria-expanded")).toBe("true");
  expect(summary().closest("details")?.open).toBe(false);
});

test("Details remembers summary clicks, browser expansion and nested toggle isolation per revision", async () => {
  const choices = new Map<string, boolean>();
  const detailsKey = JSON.stringify([reviewId, props.revision, "t-seed-body", "details"]);
  const ui = (revision = props.revision) => (
    <ReadingFoldContext.Provider value={{ reviewId, revision, choices }}>
      <Writeup
        {...props}
        revision={revision}
        topics={[topic]}
        writeup={{ sections: [{ ...section(topic.slug, "body"), blocks: [block] }] }}
      />
    </ReadingFoldContext.Provider>
  );
  const first = mount(ui());
  const details = screen.getByText("Details").closest("details");
  if (!details) throw new Error("Missing Details");
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText("Details"));
  await waitFor(() => expect(choices.get(detailsKey)).toBe(true));
  first.unmount();
  const second = mount(ui());
  const remembered = screen.getByText("Details").closest("details");
  if (!remembered) throw new Error("Missing remembered Details");
  expect(remembered.open).toBe(true);
  fireEvent.click(screen.getByText("Details"));
  await waitFor(() => expect(choices.get(detailsKey)).toBe(false));
  const target = document.getElementById(`block-${block.id}`);
  if (!target) throw new Error("Missing detail block");
  fireEvent(target, new Event("toggle", { bubbles: true }));
  expect(remembered.open).toBe(false);
  act(() => {
    remembered.open = true;
  });
  await waitFor(() => expect(choices.get(detailsKey)).toBe(true));
  second.unmount();
  mount(ui(props.revision + 1));
  expect(screen.getByText("Details").closest("details")?.open).toBe(false);
});

test("pair controls preserve the prose element and switch only the trusted pair", () => {
  const hash = "a".repeat(64);
  const images = `<span class="recense-media"><img src="/api/v1/media/${hash}" alt="Before"></span> <span class="recense-media"><img src="/api/v1/media/${hash}" alt="After"></span>`;
  const legacy = { ...block, html: `<p class="recense-media-row">${images}</p>` };
  const pair = {
    ...block,
    html: `<p class="recense-media-row recense-media-pair">${images}\n<span class="recense-media-effect">More room for seeds.</span></p>`,
  };
  const { container, rerender } = render(<BlockView block={legacy} />);
  const prose = container.querySelector(".em-prose");
  expect(container.querySelectorAll("img")).toHaveLength(2);
  expect(screen.queryByRole("group", { name: "Compare screenshots" })).toBeNull();
  expect(prose?.hasAttribute("data-pair-mode")).toBe(false);
  rerender(<BlockView block={pair} />);
  const control = screen.getByRole("group", { name: "Compare screenshots" });
  expect(control.classList.contains("em-pair-modes")).toBe(true);
  expect(control.classList.contains("select-none")).toBe(true);
  expect(control.nextElementSibling).toBe(prose);
  expect(prose?.getAttribute("data-pair-mode")).toBe("side");
  expect(within(control).getByRole("button", { name: "Side by side" }).getAttribute("aria-pressed")).toBe("true");
  const image = prose?.querySelector("img");
  for (const [mode, label] of [
    ["before", "Before"],
    ["after", "After"],
    ["side", "Side by side"],
  ]) {
    fireEvent.click(within(control).getByRole("button", { name: label }));
    expect(prose?.getAttribute("data-pair-mode")).toBe(mode);
    expect(within(control).getAllByRole("button", { pressed: true })).toEqual([
      within(control).getByRole("button", { name: label }),
    ]);
    expect(prose?.querySelector("img")).toBe(image);
    expect(prose?.textContent).toContain("More room for seeds.");
    expect(container.querySelectorAll("[data-block-id]")).toHaveLength(1);
  }
  rerender(<BlockView block={legacy} />);
  expect(container.querySelector(".em-prose")).toBe(prose);
  expect(screen.queryByRole("group", { name: "Compare screenshots" })).toBeNull();
  expect(container.querySelectorAll("img")).toHaveLength(2);
});

test.each([false, true])(
  "Needs you follows TL;DR with commentable lines and topic links (new layout=%s)",
  async (newLayout) => {
    const writeup = RenderedWriteup.parse(
      await renderWriteup(
        {
          overview: "- **Goal:** Healthy plants.\n- **Change:** More water.",
          tldr: "Keep the garden growing.",
          ...(newLayout ? { whyItMatters: "More plants survive." } : {}),
          needsYou: [
            { kind: "decide", text: "Choose the **seed**.", topic: topic.slug },
            { kind: "accept", text: "Accept the longer wait." },
          ],
          decisions: "Keep the soil.",
          topics: { seed: { why: "The soil dries.", body: "Water daily." } },
        },
        [topic],
      ),
    );
    const { container } = mount(
      <Writeup {...props} writeup={writeup} topics={[topic]} search={{ tab: "writeup", rev: 2 }} />,
    );
    const order = [...container.querySelectorAll("[data-reading-section]")].map((group) =>
      group.getAttribute("data-reading-section"),
    );
    const at = order.indexOf("tldr");
    expect(order.slice(at, at + (newLayout ? 3 : 2))).toEqual(
      newLayout ? ["tldr", "needsYou", "risk"] : ["tldr", "needsYou"],
    );
    const card = container.querySelector<HTMLElement>('[data-reading-section="needsYou"]');
    if (!card) throw new Error("Missing Needs you card");
    expect(card.classList.contains("em-writeup-card")).toBe(true);
    expect(within(card).getByRole("heading", { name: "Needs you" })).toBeTruthy();
    expect([...card.querySelectorAll("dt")].map((label) => label.textContent)).toEqual(["Decide", "Accept"]);
    expect([...card.querySelectorAll("[data-needs-kind]")].map((row) => row.getAttribute("data-needs-kind"))).toEqual([
      "decide",
      "accept",
    ]);
    expect(card.querySelector("strong")?.textContent).toBe("seed");
    expect(within(card).getByText("Accept the longer wait.")).toBeTruthy();
    expect(within(card).getAllByRole("button", { name: "Comment on block" })).toHaveLength(2);
    const jump = within(card).getByRole("link", { name: topic.title });
    expect(jump.getAttribute("href")).toBe(`/r/${reviewId}?tab=writeup&rev=2#topic-seed`);
    expect(jump.querySelector("bdi")?.textContent).toBe(topic.title);
    expect(container.querySelector("#topic-seed")).not.toBeNull();
    const status = container.querySelector(".em-needs-status");
    expect(status?.getAttribute("data-state")).toBe("open");
    expect(status?.nextElementSibling?.getAttribute("data-reading-section")).toBe(order[0]);
    expect(screen.getByRole("link", { name: "2 decisions" }).getAttribute("href")).toBe(
      `/r/${reviewId}?tab=writeup&rev=2#block-${writeup.needsYou?.[0]?.blockIds[0]}`,
    );
  },
);

test.each([false, true])("Needs you distinguishes absent from empty (present=%s)", async (present) => {
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        overview: "",
        tldr: "Keep the garden growing.",
        decisions: "",
        topics: {},
        ...(present ? { needsYou: [] } : {}),
      },
      [],
    ),
  );
  const { container } = mount(<Writeup {...props} writeup={writeup} />);
  expect(container.querySelector('[data-reading-section="needsYou"]')).toBeNull();
  const status = container.querySelector(".em-needs-status");
  if (present) {
    expect(status?.textContent).toBe("Nothing needs a decision. Approve on the proof.");
    expect(status?.getAttribute("data-state")).toBe("clear");
    expect(status?.querySelector("a")).toBeNull();
  } else expect(status).toBeNull();
});

test("a Needs you thread stays on its block, counts in the outline and accepts a comment", async () => {
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        overview: "",
        tldr: "Keep the garden growing.",
        decisions: "",
        topics: {},
        needsYou: [{ kind: "answer", text: "When should the seeds arrive?" }],
      },
      [],
    ),
  );
  const need = writeup.sections.find((section) => section.key === "needsYou")?.blocks[0];
  if (!need) throw new Error("Missing Needs you block");
  const target = { kind: "writeup-span" as const, ...blockAnchor(need) };
  const thread: ThreadView = {
    id: reviewId,
    createdOn: 1,
    state: "open",
    target,
    placement: {
      status: "placed",
      location: { kind: "writeup-span", blockId: need.id, start: 0, end: need.text.length },
    },
    comments: [{ id: reviewId, author: "user", body: "The seeds arrive tomorrow.", sent: false, sentOn: null }],
  };
  const { container } = mount(<Writeup {...props} writeup={writeup} threads={[thread]} />);
  expect(screen.getByRole("link", { name: "1 decision" }).getAttribute("href")).toBe(`/r/${reviewId}#block-${need.id}`);
  expect(screen.queryByRole("region", { name: "Comments on hidden text" })).toBeNull();
  const outline = screen.getByRole("navigation", { name: "Writeup outline" });
  expect(within(outline).getByRole("button", { name: /Needs you/ }).textContent).toContain("1 comment");
  const wrapper = container.querySelector(`#block-${need.id}`)?.closest<HTMLElement>(".em-reading-block");
  if (!wrapper) throw new Error("Missing commentable Needs you block");
  fireEvent.click(screen.getByRole("button", { name: "1 comment" }));
  expect(screen.getByText("The seeds arrive tomorrow.")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Comment thread" }), { key: "Escape" });
  fireEvent.click(within(wrapper).getByRole("button", { name: "Comment on block" }));
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Use the morning delivery." } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).target).toEqual(target);
});

test.each(["diff", "empty", "unknown"] as const)(
  "Needs you topic jumps handle %s destinations on a phone",
  async (destination) => {
    const hostileTitle = "<img src=x onerror=alert(1)>";
    const topics = [{ ...topic, title: hostileTitle }];
    const writeup = RenderedWriteup.parse(
      await renderWriteup(
        {
          overview: "",
          tldr: "Keep the garden growing.",
          decisions: "",
          topics: {},
          needsYou: [
            {
              kind: "confirm-drift",
              text: "Use the later planting date?",
              topic: destination === "unknown" ? "unknown" : topic.slug,
            },
          ],
        },
        topics,
      ),
    );
    const { container } = mount(
      <Writeup
        {...props}
        phone
        search={{ tab: "writeup", rev: 2 }}
        writeup={writeup}
        topics={topics}
        files={destination === "empty" ? [] : [file]}
      />,
    );
    const jump = container.querySelector(".em-needs-topic");
    expect(screen.getByText("Confirm drift")).toBeTruthy();
    if (destination === "diff") {
      expect(jump?.getAttribute("href")).toBe(`/r/${reviewId}?tab=diff&rev=2#diff-topic-seed`);
      expect(jump?.querySelector("bdi")?.textContent).toBe(hostileTitle);
      expect(jump?.querySelector("img")).toBeNull();
    } else expect(jump).toBeNull();
  },
);

test("a Needs you section without metadata keeps its generic blocks, and missing ids are skipped", () => {
  const need: RenderedBlock = { ...block, id: "needsYou-0123abcd", section: "needsYou" };
  const writeup: RenderedWriteup = { sections: [{ key: "needsYou", label: "Needs you", topic: null, blocks: [need] }] };
  const first = mount(<Writeup {...props} writeup={writeup} />);
  expect(first.container.querySelector(`#block-${need.id}`)).not.toBeNull();
  expect(first.container.querySelector(".em-needs-status, .em-writeup-needs")).toBeNull();
  first.unmount();
  const next = mount(
    <Writeup
      {...props}
      writeup={{ ...writeup, needsYou: [{ kind: "answer", blockIds: ["needsYou-ffffffff", need.id] }] }}
    />,
  );
  expect(next.container.querySelectorAll(".em-writeup-needs [data-block-id]")).toHaveLength(1);
  expect(next.container.querySelector(`#block-${need.id}`)).not.toBeNull();
});

async function newsWriteup(
  items: NonNullable<WriteupInput["newInRevision"]> = [
    { text: "Corrected seed spacing.", topic: "seed" },
    { text: "Added a dry-soil check.", section: "checked" },
    { text: "Corrected the planting date." },
  ],
) {
  return RenderedWriteup.parse(
    await renderWriteup(
      {
        overview: "- **Goal:** Healthy plants.\n- **Change:** More water.",
        tldr: "Keep the garden growing.",
        whyItMatters: "More plants survive.",
        newInRevision: items,
        needsYou: [{ kind: "answer", text: "When should the seeds arrive?" }],
        checked: "Wet soil check.\n\nDry soil check.",
        decisions: "Keep the soil.",
        topics: {
          seed: { why: "The soil dries.\n\nSpace the seeds.", example: "Plant two rows.", body: "Water daily." },
        },
      },
      [topic],
    ),
  );
}

function newsSection(writeup: RenderedWriteup, key: string) {
  const section = writeup.sections.find((section) => section.key === key);
  if (!section) throw new Error(`Missing synthetic section ${key}`);
  return section;
}

test.each([false, true])(
  "revision news follows TL;DR before Needs you and Facts, with changed targets=%s",
  async (changed) => {
    const writeup = await newsWriteup();
    const why = newsSection(writeup, "t-seed-why").blocks;
    const example = newsSection(writeup, "t-seed-example").blocks;
    const checked = newsSection(writeup, "checked").blocks;
    const changedBlocks = [example[0], why[1], checked[1]].flatMap((block) =>
      block ? [{ blockId: block.id, revision: 2 }] : [],
    );
    const { container } = mount(
      <Writeup
        {...props}
        writeup={writeup}
        topics={[topic]}
        changedSince={1}
        changedBlocks={changed ? changedBlocks : []}
        search={{ tab: "writeup", rev: 2 }}
      />,
    );
    const order = [...container.querySelectorAll("[data-reading-section]")].map((group) =>
      group.getAttribute("data-reading-section"),
    );
    expect(order.slice(0, 4)).toEqual(["tldr", "newInRevision", "needsYou", "risk"]);
    const card = container.querySelector<HTMLElement>(".em-writeup-news");
    if (!card) throw new Error("Missing revision news card");
    expect(within(card).getByRole("heading", { name: "New in this revision" })).toBeTruthy();
    expect(card.classList.contains("em-writeup-card")).toBe(true);
    const links = within(card).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe(
      `/r/${reviewId}?tab=writeup&rev=2#${changed ? `block-${why[1]?.id}` : "topic-seed"}`,
    );
    expect(links[0]?.querySelector("bdi")?.textContent).toBe(topic.title);
    expect(links[0]?.querySelector('[aria-hidden="true"]')?.textContent).toBe("→");
    expect(links[1]?.getAttribute("href")).toBe(
      `/r/${reviewId}?tab=writeup&rev=2#block-${checked[changed ? 1 : 0]?.id}`,
    );
    expect(links[1]?.textContent).toContain("Checked");
    expect(within(card).getByText("Corrected the planting date.").closest("li")?.querySelector("a")).toBeNull();
    expect(container.querySelector('[data-fact="since"]')).toBeNull();
  },
);

test.each(["first", "absent", "empty", "missing-section"] as const)(
  "revision news stays absent for %s and keeps the Since fact",
  async (scenario) => {
    const rendered = await newsWriteup();
    const writeup =
      scenario === "first"
        ? rendered
        : {
            ...rendered,
            newInRevision: scenario === "missing-section" ? rendered.newInRevision : undefined,
            sections: rendered.sections.filter((section) => section.key !== "newInRevision"),
          };
    if (scenario === "empty") {
      const empty = await newsWriteup([]);
      expect(empty).not.toHaveProperty("newInRevision");
      writeup.sections = empty.sections;
    }
    const { container } = mount(
      <Writeup
        {...props}
        revision={scenario === "first" ? 1 : 2}
        changedSince={1}
        changedBlocks={[{ blockId: newsSection(writeup, "tldr").blocks[0]?.id ?? "", revision: 2 }]}
        writeup={writeup}
        topics={[topic]}
      />,
    );
    expect(container.querySelector('[data-reading-section="newInRevision"]')).toBeNull();
    const since = container.querySelector('[data-fact="since"]');
    if (scenario === "first") expect(since).toBeNull();
    else expect(since?.textContent).toContain("Since revision 1:");
  },
);

test("revision news folds after four lines and suppresses only its own changed markers", async () => {
  const writeup = await newsWriteup(
    Array.from({ length: 5 }, (_, index) => ({ text: `Updated planting row ${index + 1}.` })),
  );
  const news = newsSection(writeup, "newInRevision");
  const tldr = newsSection(writeup, "tldr");
  const { container } = mount(
    <Writeup
      {...props}
      writeup={writeup}
      changedBlocks={[...news.blocks, ...tldr.blocks].map((block) => ({ blockId: block.id, revision: 2 }))}
    />,
  );
  const card = container.querySelector<HTMLElement>(".em-writeup-news");
  if (!card) throw new Error("Missing revision news card");
  const visible = card.querySelector(".em-revision-news");
  expect(visible?.children).toHaveLength(4);
  expect(visible?.textContent).not.toContain("Updated planting row 5.");
  const fold = card.querySelector("details");
  expect(fold?.open).toBe(false);
  expect(fold?.querySelector("summary")?.textContent).toBe("and 1 more");
  expect(fold?.querySelector(".em-revision-news")?.children).toHaveLength(1);
  expect(fold?.textContent).toContain("Updated planting row 5.");
  expect(card.textContent).not.toContain("Changed in rev");
  expect(card.querySelector(".em-reading-block__change")).toBeNull();
  expect(container.querySelector('[data-reading-section="tldr"]')?.textContent).toContain("Changed in rev 2");
  const summary = fold?.querySelector("summary");
  if (!summary) throw new Error("Missing revision news fold");
  fireEvent.click(summary);
  await waitFor(() => expect(fold?.open).toBe(true));
});

test("revision news without metadata stays a generic section, with the Since fact", async () => {
  const rendered = await newsWriteup();
  const { newInRevision: _metadata, ...writeup } = rendered;
  const { container } = mount(<Writeup {...props} writeup={writeup} changedSince={1} />);
  expect(container.querySelector(".em-writeup-news")).toBeNull();
  const generic = container.querySelector('[data-reading-section="newInRevision"]');
  expect(generic?.textContent).toContain("Corrected seed spacing.");
  expect(generic?.querySelectorAll("[data-block-id]")).toHaveLength(3);
  expect(container.querySelector('[data-fact="since"]')?.textContent).toContain("Since revision 1:");
});

test("a revision news thread stays on its block and counts in the outline", async () => {
  const writeup = await newsWriteup();
  const news = newsSection(writeup, "newInRevision").blocks[0];
  if (!news) throw new Error("Missing revision news block");
  const target = { kind: "writeup-span" as const, ...blockAnchor(news) };
  const thread: ThreadView = {
    id: reviewId,
    createdOn: 2,
    state: "open",
    target,
    placement: {
      status: "placed",
      location: { kind: "writeup-span", blockId: news.id, start: 0, end: news.text.length },
    },
    comments: [{ id: reviewId, author: "user", body: "The spacing is clearer.", sent: false, sentOn: null }],
  };
  const { container } = mount(<Writeup {...props} writeup={writeup} threads={[thread]} />);
  expect(screen.queryByRole("region", { name: "Comments on hidden text" })).toBeNull();
  const outline = screen.getByRole("navigation", { name: "Writeup outline" });
  expect(within(outline).getByRole("button", { name: /New in this revision/ }).textContent).toContain("1 comment");
  const wrapper = container.querySelector(`#block-${news.id}`)?.closest<HTMLElement>(".em-reading-block");
  if (!wrapper) throw new Error("Missing commentable news block");
  expect(wrapper.closest(".em-writeup-news")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "1 comment" }));
  expect(screen.getByText("The spacing is clearer.")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Comment thread" }), { key: "Escape" });
  fireEvent.click(within(wrapper).getByRole("button", { name: "Comment on block" }));
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Keep this spacing." } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).target).toEqual(target);
});

test.each(["writeup", "diff", "empty", "unknown"] as const)(
  "revision news handles %s topic targets and isolates hostile titles",
  async (destination) => {
    const hostile = { ...topic, title: "<img src=x onerror=alert(1)>" };
    const writeup = RenderedWriteup.parse(
      await renderWriteup(
        {
          overview: "",
          tldr: "Keep the garden growing.",
          decisions: "",
          topics: destination === "writeup" ? { seed: { why: "Space the seeds." } } : {},
          newInRevision: [
            { text: "Corrected seed spacing.", topic: destination === "unknown" ? "unknown" : topic.slug },
          ],
        },
        [hostile],
      ),
    );
    const { container } = mount(
      <Writeup
        {...props}
        phone
        writeup={writeup}
        topics={[hostile]}
        files={destination === "empty" ? [] : [file]}
        search={{ tab: "writeup", rev: 2 }}
      />,
    );
    const jump = container.querySelector(".em-writeup-news .em-needs-topic");
    if (destination === "writeup" || destination === "diff") {
      expect(jump?.getAttribute("href")).toBe(
        destination === "diff"
          ? `/r/${reviewId}?tab=diff&rev=2#diff-topic-seed`
          : `/r/${reviewId}?tab=writeup&rev=2#topic-seed`,
      );
      expect(jump?.querySelector("bdi")?.textContent).toBe(hostile.title);
      expect(jump?.querySelector("img")).toBeNull();
    } else expect(jump).toBeNull();
  },
);

test("revision news skips missing block ids and empty or missing section targets", async () => {
  const writeup = await newsWriteup([
    { text: "Corrected the terms.", section: "glossary" },
    { text: "Removed the old context.", section: "context" },
  ]);
  writeup.sections.push({ key: "glossary", label: "Glossary", topic: null, blocks: [] });
  writeup.newInRevision?.[0]?.blockIds.unshift("newInRevision-ffffffff");
  const { container } = mount(<Writeup {...props} writeup={writeup} />);
  const card = container.querySelector(".em-writeup-news");
  expect(card?.querySelectorAll("[data-block-id]")).toHaveLength(2);
  expect(card?.querySelector("a")).toBeNull();
});

test("revision quotes choose separate blocks in one topic and label quote-only destinations", async () => {
  const writeup = await newsWriteup([
    { text: "Explained dry soil.", topic: "seed", quote: "soil dries" },
    { text: "Corrected the spacing.", topic: "seed", quote: "Space the seeds" },
    { text: "Added watering details.", quote: "Water daily" },
    { text: "Added the dry soil check.", quote: "Dry soil check" },
  ]);
  const why = newsSection(writeup, "t-seed-why").blocks;
  const body = newsSection(writeup, "t-seed-body").blocks[0];
  const checked = newsSection(writeup, "checked").blocks[1];
  const { container } = mount(
    <Writeup
      {...props}
      writeup={writeup}
      topics={[topic]}
      search={{ tab: "writeup", rev: 2 }}
      changedBlocks={why.map((block) => ({ blockId: block.id, revision: 2 }))}
    />,
  );
  const links = [...container.querySelectorAll(".em-writeup-news .em-needs-topic")];
  expect(links.map((link) => link.getAttribute("href"))).toEqual(
    [why[0], why[1], body, checked].map((block) => `/r/${reviewId}?tab=writeup&rev=2#block-${block?.id}`),
  );
  expect(links.slice(0, 3).map((link) => link.querySelector("bdi")?.textContent)).toEqual([
    topic.title,
    topic.title,
    topic.title,
  ]);
  expect(links[3]?.textContent).toBe("→ Checked");
  for (const link of links) {
    const id = link.getAttribute("href")?.split("#")[1];
    expect(container.querySelector(`[id="${id}"]`)).not.toBeNull();
  }
});

test.each(["missing", "hidden"] as const)("revision block jumps fall back for a %s block", async (destination) => {
  const writeup = await newsWriteup([
    { text: "Updated the seed topic.", topic: "seed" },
    { text: "Updated the checks.", section: "checked" },
    { text: "Updated a fact." },
  ]);
  const blockId = destination === "missing" ? "overview-ffffffff" : "review-0123abcd";
  writeup.sections.push({
    key: "review",
    label: "Review",
    topic: null,
    blocks: [{ ...block, id: "review-0123abcd", section: "review" }],
  });
  for (const item of writeup.newInRevision ?? []) item.blockId = blockId;
  const checked = newsSection(writeup, "checked").blocks[0];
  const { container } = mount(<Writeup {...props} writeup={writeup} topics={[topic]} />);
  const links = [...container.querySelectorAll(".em-writeup-news .em-needs-topic")];
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    `/r/${reviewId}#topic-seed`,
    `/r/${reviewId}#block-${checked?.id}`,
  ]);
});

test("a quote-only jump keeps a hostile topic title inside bdi", async () => {
  const writeup = await newsWriteup([{ text: "Corrected seed spacing.", quote: "Space the seeds" }]);
  const title = "<img src=x onerror=alert(1)>";
  const { container } = mount(<Writeup {...props} writeup={writeup} topics={[{ ...topic, title }]} />);
  const jump = container.querySelector(".em-writeup-news .em-needs-topic");
  expect(jump?.querySelector("bdi")?.textContent).toBe(title);
  expect(jump?.querySelector("img")).toBeNull();
});

test.each([false, true])("stored empty revision items are ignored (has visible item=%s)", async (visible) => {
  const writeup = await newsWriteup([{ text: "Added a dry soil check." }]);
  const news = newsSection(writeup, "newInRevision");
  const existing = writeup.newInRevision?.[0];
  if (!existing) throw new Error("Missing synthetic news item");
  writeup.newInRevision = [{ blockIds: [] }, { blockIds: ["newInRevision-ffffffff"] }, ...(visible ? [existing] : [])];
  if (!visible) news.blocks = [];
  const tldr = newsSection(writeup, "tldr").blocks[0];
  const { container } = mount(
    <Writeup
      {...props}
      writeup={writeup}
      changedSince={1}
      changedBlocks={tldr ? [{ blockId: tldr.id, revision: 2 }] : []}
    />,
  );
  const card = container.querySelector(".em-writeup-news");
  if (visible) {
    expect(card?.querySelectorAll(".em-revision-news > li")).toHaveLength(1);
    expect(card?.textContent).toContain("Added a dry soil check.");
    expect(container.querySelector('[data-fact="since"]')).toBeNull();
  } else {
    expect(card).toBeNull();
    expect(container.querySelector('[data-reading-section="newInRevision"]')).toBeNull();
    expect(container.querySelector('[data-fact="since"] dd')?.textContent).toBe("Since revision 1: TL;DR.");
  }
});

test.each([
  ["file", "Since revision 1: 1 file you viewed changed."],
  ["doc", "Since revision 1: docs/garden.md."],
  ["both", "Since revision 1: docs/garden.md; 1 file you viewed changed."],
  ["neither", undefined],
] as const)("revision news keeps computed change facts for %s", async (change, expected) => {
  const writeup = await newsWriteup();
  const docBlock: RenderedBlock = { ...block, id: "doc-12345678-12345678", section: "doc-12345678" };
  const docChanged = change === "doc" || change === "both";
  const fileChanged = change === "file" || change === "both";
  const { container } = mount(
    <Writeup
      {...props}
      writeup={writeup}
      topics={[topic]}
      changedSince={1}
      docs={[{ kind: "markdown", path: "docs/garden.md", blocks: [docBlock] }]}
      files={[{ ...file, viewed: fileChanged ? "stale" : "viewed", viewedOn: 1 }]}
      changedBlocks={[
        ...writeup.sections.flatMap((section) => section.blocks.map((block) => ({ blockId: block.id, revision: 2 }))),
        ...(docChanged ? [{ blockId: docBlock.id, revision: 2 }] : []),
      ]}
    />,
  );
  expect(container.querySelector(".em-writeup-news")).not.toBeNull();
  const since = container.querySelector('[data-fact="since"] dd');
  if (expected === undefined) expect(since).toBeNull();
  else expect(since?.textContent).toBe(expected);
});
