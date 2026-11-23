import { expect, test, vi } from "vitest";
import { normalizeText } from "../../../../packages/core/src/render/normalize.ts";
import { mapBlockText } from "./block-ranges.ts";

function element(tag: string, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  node.append(...children);
  return node;
}
function block(...children: (Node | string)[]) {
  const node = element("div", ...children);
  node.dataset.blockId = "overview-12345678";
  node.dataset.blockKind = "paragraph";
  node.dataset.blockText = normalizeText(node.textContent ?? "");
  return node;
}

test("constructs the segmenter lazily once for multiple blocks", async () => {
  vi.resetModules();
  const segmenter = vi.spyOn(Intl, "Segmenter");
  try {
    const { mapBlockText } = await import("./block-ranges.ts");
    expect(segmenter).not.toHaveBeenCalled();
    expect(mapBlockText(block("seed"))?.(0, 4)?.toString()).toBe("seed");
    expect(mapBlockText(block("soil"))?.(0, 4)?.toString()).toBe("soil");
    expect(segmenter).toHaveBeenCalledOnce();
  } finally {
    segmenter.mockRestore();
  }
});

test("maps across nested strong, code and link text without selecting surrounding text", () => {
  const strong = element("strong", "red ", element("code", "seed"));
  const link = element("a", "growing");
  const node = block(element("p", "Plant ", strong, " keeps ", link, "."));
  const range = mapBlockText(node)?.(6, 28);
  expect(range?.toString()).toBe("red seed keeps growing");
  expect(range?.startContainer).toBe(strong.firstChild);
  expect(range?.startOffset).toBe(0);
  expect(range?.endContainer).toBe(link.firstChild);
  expect(range?.endOffset).toBe(7);
});

test("maps Shiki text across token spans and line breaks", () => {
  const node = block(
    element(
      "pre",
      element(
        "code",
        element("span", element("span", "const"), element("span", " seed = 1;")),
        "\n",
        element("span", element("span", "grow"), element("span", "(seed);")),
      ),
    ),
  );
  expect(mapBlockText(node)?.(6, 21)?.toString()).toBe("seed = 1;\ngrow(");
});

test("trims edges and maps each collapsed whitespace run to all its source whitespace", () => {
  const node = block(" \n  Plant", element("strong", " \t"), "\n\u00a0seed  \r\n");
  const map = mapBlockText(node);
  expect(map?.(0, 5)?.toString()).toBe("Plant");
  expect(map?.(5, 6)?.toString()).toBe(" \t\n\u00a0");
  expect(map?.(6, 10)?.toString()).toBe("seed");
  expect(map?.(0, 10)?.toString()).toBe("Plant \t\n\u00a0seed");
});

test("matches normalizeText's trim semantics even for a BOM, outside Unicode White_Space", () => {
  const node = block("\ufeff  seed \ufeff");
  expect(mapBlockText(node)?.(0, 4)?.toString()).toBe("seed");
});

test.each([false, true])("maps a decomposed accent to its full source (split nodes=%s)", (split) => {
  const node = split
    ? block("Caf", element("strong", "e"), element("em", "\u0301"), " grows")
    : block("Cafe\u0301 grows");
  expect(node.dataset.blockText).toBe("Café grows");
  expect(mapBlockText(node)?.(3, 4)?.toString()).toBe("e\u0301");
  expect(mapBlockText(node)?.(4, 10)?.toString()).toBe(" grows");
});

test("an offset inside a reordered NFC run maps to that run's edges", () => {
  const node = block("x", element("strong", "a\u0315"), "\u0300", "z");
  expect(node.dataset.blockText).toBe("xà\u0315z");
  expect(mapBlockText(node)?.(1, 2)?.toString()).toBe("a\u0315\u0300");
  expect(mapBlockText(node)?.(2, 3)?.toString()).toBe("a\u0315\u0300");
  expect(mapBlockText(node)?.(3, 4)?.toString()).toBe("z");
});

test("maps Hangul composition across elements", () => {
  const node = block(element("strong", "\u1100"), "\u1161\u11a8", " seed");
  expect(node.dataset.blockText).toBe("각 seed");
  expect(mapBlockText(node)?.(0, 1)?.toString()).toBe("\u1100\u1161\u11a8");
});

test("uses UTF-16 offsets for emoji without shifting subsequent characters", () => {
  const node = block("A ", element("strong", "🪴"), " seed 👩‍🌾");
  const map = mapBlockText(node);
  expect(map?.(2, 4)?.toString()).toBe("🪴");
  expect(map?.(5, 9)?.toString()).toBe("seed");
  expect(map?.(10, 15)?.toString()).toBe("👩‍🌾");
});

test("mismatched rendered text and missing canonical text produce no mapper", () => {
  const node = block("blue seed");
  node.dataset.blockText = "red seed";
  expect(mapBlockText(node)).toBeUndefined();
  delete node.dataset.blockText;
  expect(mapBlockText(node)).toBeUndefined();
});

test.each([
  [-1, 2],
  [0, 5],
  [2, 2],
  [3, 1],
  [0.5, 2],
  [0, 1.5],
  [NaN, 2],
  [0, Infinity],
])("rejects invalid offsets %s..%s", (start, end) => expect(mapBlockText(block("seed"))?.(start, end)).toBeUndefined());

test("skips empty text, diagrams and charts even when their fallback text matches", () => {
  expect(mapBlockText(block(" \n "))?.(0, 1)).toBeUndefined();
  const node = block("graph TD; A-->B");
  for (const kind of ["diagram", "chart"]) {
    node.dataset.blockKind = kind;
    expect(mapBlockText(node)).toBeUndefined();
  }
});
