import { ok } from "node:assert/strict";
import type { RenderedBlock } from "@emend/contract";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { placeSpan } from "../../../../packages/core/src/place/span.ts";
import { BlockView } from "../components/reading/BlockView.tsx";
import { blockAnchor, selectionToAnchor } from "./selection.ts";

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});
const block: RenderedBlock = {
  id: "overview-12345678",
  section: "overview",
  kind: "paragraph",
  html: "<p>  red seed\n then <strong>blue seed</strong> Café 🪴  </p>",
  text: "  red seed\n then blue seed Café 🪴  ",
};
function required<T>(value: T | undefined | null): T {
  ok(value != null);
  return value;
}
function select(start: Node, from: number, end: Node, to: number) {
  const range = document.createRange();
  range.setStart(start, from);
  range.setEnd(end, to);
  const selection = required(window.getSelection());
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}
test("selects the second repeated word with normalized context and round trips through placeSpan", () => {
  const { container } = render(<BlockView block={block} />);
  const text = required(container.querySelector("strong")?.firstChild);
  const anchor = selectionToAnchor(select(text, 5, text, 9), container);
  expect(anchor).toEqual({ blockId: block.id, quote: "seed", prefix: "red seed then blue ", suffix: " Café 🪴" });
  if (!("blockId" in anchor)) throw new Error("Expected block anchor");
  expect(placeSpan([block], { kind: "writeup-span", ...anchor })).toEqual({
    status: "placed",
    location: { kind: "writeup-span", blockId: block.id, start: 19, end: 23 },
  });
});
test("clips context to 32 UTF-16 units without splitting code points", () => {
  const text = `${"🪴".repeat(25)} seed ${"🪴".repeat(25)}`;
  const { container } = render(<BlockView block={{ ...block, text, html: `<p>${text}</p>` }} />);
  const node = required(container.querySelector("p")?.firstChild);
  const anchor = selectionToAnchor(select(node, 51, node, 55), container);
  if (!("blockId" in anchor)) throw new Error("Expected block anchor");
  expect(anchor.quote).toBe("seed");
  for (const context of [anchor.prefix, anchor.suffix]) {
    expect(context.length).toBeLessThanOrEqual(32);
    expect(context.isWellFormed()).toBe(true);
  }
  expect(placeSpan([{ ...block, text }], { kind: "writeup-span", ...anchor }).status).toBe("placed");
});
test("rejects empty, outside and cross-block selections", () => {
  const { container } = render(
    <>
      <BlockView block={block} />
      <BlockView block={{ ...block, id: "overview-87654321" }} />
    </>,
  );
  const paragraphs = container.querySelectorAll("p");
  const first = required(paragraphs[0]?.firstChild);
  const second = required(paragraphs[1]?.firstChild);
  expect(selectionToAnchor(select(first, 2, second, 5), container)).toEqual({ error: "cross-block" });
  expect(selectionToAnchor(select(first, 2, first, 2), container)).toEqual({ error: "empty" });
  expect(selectionToAnchor(select(first, 2, first, 5), document.createElement("div"))).toEqual({ error: "empty" });
});
test("diagram selections target its whole normalized block, capped at a code-point boundary", () => {
  const text = `graph TD\n A --> B\n${"x".repeat(1983)}🪴`;
  const diagram: RenderedBlock = { ...block, kind: "diagram", text, source: text, html: "" };
  const { container } = render(<BlockView block={diagram} />);
  const node = required(container.querySelector("pre")?.firstChild);
  const anchor = selectionToAnchor(select(node, 1, node, 3), container);
  expect(anchor).toEqual({ blockId: block.id, quote: `graph TD A --> B ${"x".repeat(1983)}`, prefix: "", suffix: "" });
  if (!("blockId" in anchor)) throw new Error("Expected block anchor");
  expect(anchor.quote.isWellFormed()).toBe(true);
  expect(placeSpan([diagram], { kind: "writeup-span", ...anchor }).status).toBe("placed");
});

test("over-limit selections report too-long", () => {
  const text = "x".repeat(2001);
  const { container } = render(<BlockView block={{ ...block, text, html: `<p>${text}</p>` }} />);
  const node = required(container.querySelector("p")?.firstChild);
  expect(selectionToAnchor(select(node, 0, node, 2001), container)).toEqual({ error: "too-long" });
});

test("blockAnchor normalizes and clips a whole block without context or split surrogate pairs", () => {
  expect(blockAnchor({ id: block.id, text: "  Plant\n a  seed. " })).toEqual({
    blockId: block.id,
    quote: "Plant a seed.",
    prefix: "",
    suffix: "",
  });
  const anchor = blockAnchor({ id: block.id, text: `${"x".repeat(1999)}🪴` });
  expect(anchor.quote).toHaveLength(1999);
  expect(anchor.quote.isWellFormed()).toBe(true);
});

test.each(["title", "summary"])("topic %s selections normalize and clip context like block spans", (part) => {
  const text = `${"🪴".repeat(25)} Cafe\u0301\n seed ${"🪴".repeat(25)}`;
  const { container } = render(
    <span data-topic-slug="garden" data-topic-part={part} data-block-text={text}>
      {text}
    </span>,
  );
  const node = required(container.firstChild?.firstChild);
  const anchor = selectionToAnchor(select(node, 51, node, 62), container);
  expect(anchor).toMatchObject({ slug: "garden", part, quote: "Café seed" });
  if (!("slug" in anchor)) throw new Error("Expected topic anchor");
  expect("blockId" in anchor).toBe(false);
  for (const context of [anchor.prefix, anchor.suffix]) {
    expect(context.length).toBeLessThanOrEqual(32);
    expect(context.isWellFormed()).toBe(true);
  }
});

test.each([
  { text: "x".repeat(2001), from: 0, to: 2001, error: "too-long" },
  { text: "🪴", from: 0, to: 1, error: "empty" },
  { text: "   ", from: 0, to: 3, error: "empty" },
  { text: "seed", from: 0, to: 4, data: "soil", error: "empty" },
])("topic selections reject $error for invalid text or offsets", ({ text, from, to, data, error }) => {
  const { container } = render(
    <span data-topic-slug="garden" data-topic-part="title" data-block-text={data ?? text}>
      {text}
    </span>,
  );
  const node = required(container.firstChild?.firstChild);
  expect(selectionToAnchor(select(node, from, node, to), container)).toEqual({ error });
});
