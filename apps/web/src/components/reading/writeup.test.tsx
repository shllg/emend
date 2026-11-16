// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import {
  type FileView,
  OTHER_TOPIC,
  type RenderedBlock,
  RenderedWriteup,
  type RevisionView,
  type ThreadView,
  type TopicMeta,
} from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderWriteup } from "../../../../../packages/core/src/render/writeup.ts";
import type { CodeFocus } from "../../lib/code-focus.ts";
import { blockAnchor } from "../../lib/selection.ts";
import * as writeupFacts from "../../lib/writeup-facts.ts";
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
    "review",
    "checked",
    "notChecked",
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
    "Review",
    "Checked",
    "Not checked",
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
  for (const label of ["Review", "Checked", "Not checked"]) {
    expect(screen.getByRole("region", { name: label }).className).toBe("em-reading-group");
    expect(screen.getByRole("heading", { name: label }).classList.contains("em-writeup-kicker")).toBe(false);
  }
});

test.each(["review", "checked", "notChecked", "context"] as const)(
  "the topics map follows %s even without decisions or glossary",
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
    ).toEqual([key, "topics-map", "t-seed-why"]);
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
  expect(map.getByText("Undo: a revert is not enough").className).not.toContain("text-warning-fg");
  expect(map.getByText("Undo: a revert").className).not.toContain("text-warning-fg");
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
    expect(map.getByText(expected).classList.contains("text-warning-fg")).toBe(false);
  } else {
    expect(container.textContent).not.toContain("Undo:");
  }
  expect(container.querySelector("[data-door], .text-warning-fg")).toBeNull();
  expect(container.textContent).not.toMatch(/One-way|Two-way/);
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
    target?.dispatchEvent(new Event("emend:reveal-reading", { bubbles: true }));
  });
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

test("the new opening keeps Why it matters inside the first card and lists commentable and computed facts", async () => {
  const topics = [{ ...topic, attention: "review" as const }];
  const writeup = RenderedWriteup.parse(
    await renderWriteup(
      {
        tldr: "The seed bed stays healthy.",
        whyItMatters: "More plants survive.",
        area: "Garden",
        review: { level: "topics", topics: [topic.slug], reason: "Check the seed bed." },
        checked: "- Unit tests.",
        notChecked: "- Dry weather.",
        overview: "- **Goal:** Healthy plants.\n- **Change:** More water.",
        outOfScope: "Harvesting.",
        whereToLook: "Water the seeds.",
        context: "A small garden.",
        decisions: "Keep the soil.",
        glossary: "- **Seed:** A new plant.",
        topics: { seed: { why: "The soil dries.", example: "A seed grows.", body: "Water daily." } },
      },
      topics,
    ),
  );
  const tldr = writeup.sections.find((section) => section.key === "tldr")?.blocks[0];
  if (!tldr) throw new Error("Missing TL;DR");
  const { container } = mount(
    <Writeup
      {...props}
      revision={3}
      changedSince={2}
      changedBlocks={[{ blockId: tldr.id, revision: 3 }]}
      topics={topics}
      writeup={writeup}
      files={[{ ...file, counts: { additions: 32, deletions: 32 } }]}
    />,
  );
  expect(
    [...container.querySelectorAll("[data-reading-section]")].map((group) =>
      group.getAttribute("data-reading-section"),
    ),
  ).toEqual([
    "tldr",
    "facts",
    "overview",
    "outOfScope",
    "whereToLook",
    "context",
    "decisions",
    "glossary",
    "topics-map",
    "t-seed-why",
  ]);
  const card = container.querySelector('[data-reading-section="tldr"]');
  expect(card?.classList.contains("em-writeup-card")).toBe(true);
  expect(card && within(card as HTMLElement).getByRole("heading", { level: 3, name: "Why it matters" })).toBeTruthy();
  expect(card?.querySelector(".em-writeup-matters")?.textContent).toContain("More plants survive.");
  expect([...container.querySelectorAll(".em-writeup-facts dt")].map((label) => label.textContent)).toEqual([
    "Review",
    "Checked",
    "Not checked",
    "Risk",
    "Undo",
    "Read",
    "Since",
  ]);
  expect(screen.getByRole("heading", { level: 2, name: "Facts" }).className).toBe("sr-only");
  expect(container.querySelector('[data-reading-section="overview"]')?.classList.contains("em-writeup-pair")).toBe(
    true,
  );
  expect(screen.getByRole("heading", { level: 2, name: "Overview" }).className).not.toContain("em-writeup-kicker");
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
  expect(container.querySelector('[data-reading-section="facts"]')).toBeNull();
});

test("an HTML-only revision explains why Read has no estimate", () => {
  const { container } = mount(
    <Writeup
      {...props}
      writeup={{ area: "Garden", sections: [] }}
      docs={[{ kind: "html", path: "preview.html", contentUrl: "/content/preview" }]}
    />,
  );
  expect(container.querySelector('[data-fact="read"] dd')?.textContent).toBe("Not estimated; HTML docs not counted");
});

test("legacy writeups never compute Read, including after content and layout changes", () => {
  const read = vi.spyOn(writeupFacts, "readFact");
  const legacy: RenderedWriteup = { sections: [{ ...plain("overview", "Overview"), blocks: [block] }] };
  const reader = (writeup: RenderedWriteup, files: FileView[] = []) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Writeup {...props} writeup={writeup} files={files} />
      </ToastProvider>
    </QueryClientProvider>
  );
  const { container, rerender } = render(reader(legacy));
  rerender(reader({ sections: [...legacy.sections, plain("tldr", "TL;DR")] }, [file]));
  expect(read).not.toHaveBeenCalled();
  expect(container.querySelector('[data-fact="read"]')).toBeNull();

  const files: FileView[] = [];
  rerender(reader(legacy, files));
  expect(read).not.toHaveBeenCalled();
  rerender(reader({ ...legacy, area: "Garden" }, files));
  expect(read).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-fact="read"]')).not.toBeNull();
  rerender(reader(legacy, files));
  expect(read).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-fact="read"]')).toBeNull();

  rerender(
    reader(
      {
        sections: [...legacy.sections, { key: "whyItMatters", label: "Why it matters", topic: null, blocks: [] }],
      },
      files,
    ),
  );
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[data-fact="read"]')).not.toBeNull();
});

test("Read reuses source word counts on parent and comment updates, and refreshes when content changes", () => {
  const read = vi.spyOn(writeupFacts, "readFact");
  const writeup: RenderedWriteup = { area: "Garden", sections: [] };
  const source: Extract<RevisionView["docs"][number], { kind: "source" }> = {
    kind: "source",
    path: "source.ts",
    language: "ts",
    lines: [[{ text: "word ".repeat(200) }]],
  };
  const docs = [source];
  const files: FileView[] = [];
  const reader = (updates: Partial<React.ComponentProps<typeof Writeup>> = {}) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Writeup {...props} writeup={{ ...writeup }} docs={docs} files={files} {...updates} />
      </ToastProvider>
    </QueryClientProvider>
  );
  const { container, rerender } = render(reader());
  expect(read).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-fact="read"] dd')?.textContent).toBe("About 1 min: writeup and docs 1 min");
  rerender(reader());
  rerender(reader({ threads: [] }));
  rerender(reader({ changedBlocks: [{ blockId: block.id, revision: 2 }] }));
  expect(read).toHaveBeenCalledOnce();

  const moreDocs = [{ ...source, lines: [...source.lines, ...source.lines] }];
  rerender(reader({ docs: moreDocs }));
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[data-fact="read"] dd')?.textContent).toBe("About 2 min: writeup and docs 2 min");

  const moreWriteup = {
    ...writeup,
    sections: [{ ...plain("overview", "Overview"), blocks: [{ ...block, text: "word ".repeat(200) }] }],
  };
  rerender(reader({ docs: moreDocs, writeup: moreWriteup }));
  expect(read).toHaveBeenCalledTimes(3);
  expect(container.querySelector('[data-fact="read"] dd')?.textContent).toBe("About 3 min: writeup and docs 3 min");

  rerender(
    reader({ docs: moreDocs, writeup: moreWriteup, files: [{ ...file, counts: { additions: 8, deletions: 0 } }] }),
  );
  expect(read).toHaveBeenCalledTimes(4);
  expect(container.querySelector('[data-fact="read"] dd')?.textContent).toBe(
    "About 4 min: writeup and docs 3 min, diff 1 min (8 lines)",
  );
});

test("a fact block keeps its writeup-span target, change marker and Facts outline thread count", async () => {
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
      writeup={{ area: "Garden", sections: [{ key: "checked", label: "Checked", topic: null, blocks: [checked] }] }}
    />,
  );
  const facts = container.querySelector<HTMLElement>('[data-reading-section="facts"]');
  if (!facts) throw new Error("Missing Facts");
  expect(facts.querySelector(".em-reading-block__change")).not.toBeNull();
  const outline = screen.getByRole("navigation", { name: "Writeup outline" });
  expect(within(outline).getByRole("button", { name: /Facts/ }).textContent).toContain("1 comment");
  fireEvent.click(within(facts).getByRole("button", { name: "Comment on block" }));
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Add browser coverage" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).target).toEqual(target);
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
  const facts = container.querySelector(".em-writeup-facts");
  expect(facts?.querySelectorAll("img, script")).toHaveLength(0);
  expect(facts?.querySelector('[data-fact="risk"] dd')?.textContent).toBe(`High: ${hostile}`);
  expect(facts?.querySelector('[data-fact="undo"] dd')?.textContent).toBe(`${hostile} (${hostile})`);
  expect(facts?.querySelector('[data-fact="since"] dd')?.textContent).toBe(
    `Since revision 2: new or changed text in topic “${hostile}” and ${path}.`,
  );
  expect([...(facts?.querySelectorAll("bdi") ?? [])].map((part) => part.textContent)).toEqual([
    hostile,
    hostile,
    hostile,
    hostile,
    path,
  ]);
});

test("PDI and RLO in agent text are removed while emend's fact text stays outside each bdi in order", () => {
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
    [
      "risk",
      ["Docs", second.title, "Third"],
      [", ", ", ", " and 2 more"],
      `High: Docs, ${second.title}, Third and 2 more`,
    ],
    ["undo", ["Restore state", "Docs"], [" (", ")"], "Restore state (Docs)"],
    ["since", ["Docs"], ["”"], "Since revision 2: new or changed text in topic “Docs”."],
  ] as const) {
    const fact = container.querySelector(`[data-fact="${key}"] dd`);
    expect(fact?.textContent).toBe(text);
    const parts = [...(fact?.querySelectorAll("bdi") ?? [])];
    expect(parts.map((part) => part.textContent)).toEqual(expected);
    for (const [index, part] of parts.entries()) {
      expect(part.parentElement).toBe(fact);
      expect(part.nextSibling?.textContent).toBe(following[index]);
      if (part.nextSibling) expect(part.nextSibling.nodeType).toBe(Node.TEXT_NODE);
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
  expect(container.querySelector('[data-fact="read"]')).not.toBeNull();
  expect(container.querySelector('[data-fact="since"] dd')?.textContent).toBe(
    "Since revision 2: no new text in the writeup or Markdown docs. Removed text is not tracked.",
  );
});

test("comments on both paired overview blocks share a usable gutter chip when their first lines align", () => {
  const blocks: RenderedBlock[] = [
    { ...block, kind: "item", id: "overview-11111111", text: "Goal: Plants.", html: "<ul><li>Goal: Plants.</li></ul>" },
    {
      ...block,
      kind: "item",
      id: "overview-22222222",
      text: "Change: Water.",
      html: "<ul><li>Change: Water.</li></ul>",
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
