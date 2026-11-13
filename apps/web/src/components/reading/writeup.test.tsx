// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import {
  type FileView,
  OTHER_TOPIC,
  type RenderedBlock,
  RenderedWriteup,
  type ThreadView,
  type TopicMeta,
} from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderWriteup } from "../../../../../packages/core/src/render/writeup.ts";
import { layoutStore } from "../../lib/layout-store.ts";
import { blockAnchor } from "../../lib/selection.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import { BlockView } from "./BlockView.tsx";
import { DocView } from "./DocView.tsx";
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

function topicReader(threads: ThreadView[] = [], value = topic) {
  return mount(
    <Writeup
      {...props}
      threads={threads}
      topics={[value]}
      writeup={{ sections: [{ ...section(value.slug, "why"), blocks: [block] }] }}
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

test("whole-topic and quoted threads stay below the topic metadata when folded and both count", () => {
  layoutStore.update({ contents: true, compact: false });
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
  topicReader([whole, quoted], { ...topic, attention: "skim" });
  const group = screen.getByRole("region", { name: "Topic 1: Plant a seed" });
  const cards = group.querySelectorAll("[data-thread-card]");
  expect(cards).toHaveLength(2);
  for (const card of cards) {
    expect(card.closest("[hidden]")).toBeNull();
    expect(
      (group.querySelector(".em-topic-summary")?.compareDocumentPosition(card) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
  expect(within(group).getByText("2 comments")).toBeTruthy();
  expect(group.querySelector(".em-thread-quote")?.textContent).toBe("seed");
  expect(within(group).getByText("Whole topic feedback")).toBeTruthy();
  expect(within(group).getByText("Quoted topic feedback")).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Writeup outline" }).textContent).toContain("2 comments");
});

test("a hostile topic title and summary remain literal React text", () => {
  const title = "<img src=x onerror=alert(1)>";
  const { container } = topicReader([], { ...topic, title, summary: "<script>alert(1)</script>" });
  expect(container.querySelector('[data-topic-part="title"]')?.textContent).toBe(title);
  expect(container.querySelector('[data-topic-part="summary"]')?.textContent).toBe("<script>alert(1)</script>");
  expect(container.querySelector("img, script, [onerror]")).toBeNull();
});

test.each([
  { contents: false, compact: false },
  { contents: true, compact: false },
  { contents: false, compact: true },
  { contents: true, compact: true },
])(
  "contents=$contents compact=$compact: new writeups show the opening hierarchy before topics",
  async (preferences) => {
    layoutStore.update(preferences);
    const writeup = RenderedWriteup.parse(
      await renderWriteup(
        {
          tldr: "Failed requests now stop after three attempts.",
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
      "outOfScope",
      "whereToLook",
      "context",
      "decisions",
      "glossary",
      "topics-map",
      "t-seed-why",
    ]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "TL;DR",
      "Overview",
      "Out of scope",
      "Where to look",
      "Context",
      "Decisions & drift",
      "Topics",
      "Topic 1: Plant a seed",
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
  },
);

test("the topics map follows the new intro sections even without decisions or glossary", () => {
  const sections: RenderedWriteup["sections"] = [
    { key: "context", label: "Context", topic: null, blocks: [] },
    section("seed", "why"),
  ];
  const { container } = mount(<Writeup {...props} topics={[topic]} writeup={{ sections }} />);
  expect(
    [...container.querySelectorAll("[data-reading-section]")].map((group) =>
      group.getAttribute("data-reading-section"),
    ),
  ).toEqual(["context", "topics-map", "t-seed-why"]);
});

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
  const introKeys = [...(overview ? ["overview"] : []), ...(tldr ? ["tldr"] : []), "decisions", "glossary"];
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
    "Decisions & drift",
    "Topics",
    "Topic 1: Plant a seed",
    "Topic 2: Water the garden",
    "Unknown topic — Why",
  ]);
  expect(container.querySelectorAll("section#topic-seed")).toHaveLength(1);
  const seed = screen.getByRole("region", { name: "Topic 1: Plant a seed" });
  expect(
    within(seed)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent),
  ).toEqual(["Why", "Example", "Details"]);
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
      topics={[topic, other, second, plainTopic]}
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
  expect(map.getByText("One-way door").className).toContain("text-warning-fg");
  expect(map.getByText("Two-way door")).toBeTruthy();
  expect(map.getByText("garden")).toBeTruthy();
  expect(map.getByText("1 file")).toBeTruthy();
  expect(map.getByText("2 files")).toBeTruthy();
  expect(map.queryByText("0 files")).toBeNull();
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
  expect(within(group).queryByText(/door|Blast radius/)).toBeNull();
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

test.each([
  { contents: false, compact: false },
  { contents: true, compact: false },
  { contents: false, compact: true },
  { contents: true, compact: true },
])(
  "contents=$contents compact=$compact: hostile metadata stays text and server-sanitized Markdown remains inert",
  async (preferences) => {
    layoutStore.update(preferences);
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
  },
);

test.each(["critical", "review", "skim", undefined] as const)(
  "topic chips and folding for attention %s",
  (attention) => {
    const value = { ...topic, attention };
    const why = { ...section("seed", "why"), blocks: [block] };
    const { container } = mount(<Writeup {...props} topics={[value]} files={[file]} writeup={{ sections: [why] }} />);
    const group = screen.getByRole("region", { name: "Topic 1: Plant a seed" });
    const chip = group.querySelector("[data-attention]");
    expect(chip?.textContent).toBe(attention?.toUpperCase());
    const map = screen.getByRole("region", { name: "Topics" });
    expect(map.querySelector("[data-attention]")?.textContent).toBe(attention?.toUpperCase());
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
  },
);

test.each(["one-way", "two-way", undefined] as const)("topic door chip %s", (door) => {
  mount(<Writeup {...props} topics={[{ ...topic, door }]} writeup={{ sections: [section("seed", "why")] }} />);
  const group = screen.getByRole("region", { name: "Topic 1: Plant a seed" });
  expect(group.querySelector("[data-door]")?.textContent).toBe(door?.toUpperCase());
});

test("front matter cards, callouts and hidden Details keep the original comment anchors", async () => {
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
  const { container } = mount(<Writeup {...props} topics={[topic]} writeup={writeup} />);
  expect(screen.getByRole("heading", { name: "TL;DR" }).closest(".em-writeup-card")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Decisions & drift" }).closest(".em-writeup-decisions")).toBeTruthy();
  expect(container.querySelectorAll("[data-drift]")).toHaveLength(2);
  for (const drift of container.querySelectorAll<HTMLElement>("[data-drift]")) {
    expect(within(drift).getByRole("button", { name: "Comment on block" })).toBeTruthy();
  }
  const why = screen.getByRole("heading", { name: "Why", level: 3 });
  const example = screen.getByRole("heading", { name: "Example", level: 3 });
  expect(why.closest(".em-writeup-why")?.querySelector("[data-block-id]")?.textContent).toBe("A reason.");
  expect(example.closest(".em-writeup-example")?.querySelector("table")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Details", level: 3 }).className).toBe("sr-only");
  const ids = writeup.sections.flatMap((section) => section.blocks.map((block) => block.id));
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

test("a changed glossary starts open", () => {
  mount(
    <Writeup
      {...props}
      changedBlocks={[{ blockId: block.id, revision: 2 }]}
      writeup={{ sections: [{ ...plain("glossary", "Glossary"), blocks: [block] }] }}
    />,
  );
  const glossary = screen.getByText("Glossary · 1 term").closest("details");
  expect(glossary?.open).toBe(true);
  expect(glossary && within(glossary).getByRole("button", { name: "Comment on block" })).toBeTruthy();
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
  const images = container.querySelectorAll<HTMLImageElement>(".em-prose .emend-media img");
  expect(images).toHaveLength(2);
  expect(images[0]?.getAttribute("src")).toBe(`/api/v1/media/${hash}`);
  expect(images[0]?.getAttribute("alt")).toBe("Before");
  expect(container.querySelector("p.emend-media-row")).toBeTruthy();
  expect([...container.querySelectorAll(".emend-media-caption")].map((caption) => caption.textContent)).toEqual([
    "Before",
    "After",
  ]);
  const wrapper = container.querySelector<HTMLElement>(".emend-media")?.closest<HTMLElement>(".em-reading-block");
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
  const wrappers = container.querySelectorAll<HTMLElement>("span.emend-media");
  expect(wrappers).toHaveLength(2);
  expect(wrappers[0]?.classList.contains("emend-media-sized")).toBe(true);
  expect(wrappers[1]?.classList.contains("emend-media-sized")).toBe(false);
  expect(wrappers[0]?.querySelector("img")?.getAttribute("width")).toBe("640");
  expect(wrappers[0]?.style.getPropertyValue("--emend-media-w")).toBe("640");
  expect(wrappers[0]?.style.getPropertyValue("--emend-media-h")).toBe("480");
  expect(wrappers[1]?.style.getPropertyValue("--emend-media-w")).toBe("");
  expect(wrappers[1]?.style.getPropertyValue("--emend-media-h")).toBe("");
  cleanup();

  const crafted = (attributes: string): RenderedBlock => ({
    ...block,
    html: `<p><span class="emend-media emend-media-sized"><img src="/api/v1/media/${hash}" alt="x" ${attributes}><span class="emend-media-caption">x</span></span></p>`,
  });
  for (const attributes of [
    'width="0" height="10"',
    'width="99999999" height="10"',
    'width="1e3" height="10"',
    'width="70000" height="10"',
    'width="10"',
  ]) {
    const view = mount(<BlockView block={crafted(attributes)} />);
    const wrapper = view.container.querySelector<HTMLElement>("span.emend-media");
    expect(wrapper?.style.getPropertyValue("--emend-media-w"), attributes).toBe("");
    expect(wrapper?.style.getPropertyValue("--emend-media-h"), attributes).toBe("");
    cleanup();
  }
  const legacy: RenderedBlock = {
    ...block,
    html: `<p><span class="emend-media"><img src="/api/v1/media/${hash}" alt="x" width="2000" height="100"><span class="emend-media-caption">x</span></span></p>`,
  };
  const view = mount(<BlockView block={legacy} />);
  const wrapper = view.container.querySelector<HTMLElement>("span.emend-media");
  expect(wrapper?.style.getPropertyValue("--emend-media-w")).toBe("");
  expect(wrapper?.style.getPropertyValue("--emend-media-h")).toBe("");
});
