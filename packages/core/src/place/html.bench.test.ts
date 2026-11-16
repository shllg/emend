import { expect, test } from "vitest";
import { docText } from "./html.ts";

const nested = `${"<div>".repeat(50000)}seed${"</div>".repeat(50000)}`;
test.each([
  ...(
    [
      ["malformed-attribute", '<div a">', '">seed'],
      ["svg-title", "<svg><title>", "</title></svg>seed"],
      ["mathml-style", "<math><style>", "</style></math>seed"],
      ["mathml-title", "<math><title>", "</title></math>seed"],
      ["mixed-attribute", `<div a='x"'>`, "</div>seed"],
      ["foster-parenting", "<table>", "</table>seed"],
    ] as const
  ).map(([name, before, after]) => ({
    name: `html-stack-${name}`,
    source: before + "<div>".repeat(50000) + after,
    expected: null,
  })),
  ...[10000, 50000].map((depth) => ({
    name: `html-depth-${depth}`,
    source: `${"<div>".repeat(depth)}seed${"</div>".repeat(depth)}`,
    expected: null,
  })),
  ...(
    [
      ["self-closing", "<div/>"],
      ["closing-p", "<div></p>"],
      ["closing-span", "<div></span>"],
    ] as const
  ).map(([name, tag]) => ({ name: `html-recovery-${name}`, source: `${tag.repeat(50000)}seed`, expected: null })),
  { name: "html-noscript-head", source: `<noscript>${nested}</noscript><p>visible</p>`, expected: "visible" },
  { name: "html-noscript-body", source: `<body>visible<noscript>${nested}`, expected: "visible" },
])("$name", ({ name, source, expected }) => {
  const start = performance.now();
  const text = docText(source);
  const ms = performance.now() - start;
  expect(text).toBe(expected);
  process.stdout.write(`${JSON.stringify({ bench: name, ms, inputChars: source.length })}\n`);
});
