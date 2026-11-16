import { toString as hastText } from "hast-util-to-string";
import type { HtmlElement, HtmlNode, HtmlRoot } from "./blocks.ts";

type Children = HtmlElement["children"];
const span = (className: string, children: Children): HtmlElement => ({
  type: "element",
  tagName: "span",
  properties: { className: [className] },
  children,
});

function labelledRow(children: Children): HtmlElement | undefined {
  const match = /^\s*(before|after)\b[^:\n]{0,48}:/i.exec(children.map((child) => hastText(child)).join(""));
  if (!match) return;
  const label: Children = [];
  const rest: Children = [];
  let remaining = match[0].length;
  for (const child of children) {
    if (remaining === 0) {
      rest.push(child);
      continue;
    }
    const length = hastText(child).length;
    if (length <= remaining) label.push(child);
    else {
      // Splitting inside inline markup would change its meaning and structure.
      if (child.type !== "text") return;
      label.push({ type: "text", value: child.value.slice(0, remaining) });
      rest.push({ type: "text", value: child.value.slice(remaining) });
    }
    remaining = Math.max(0, remaining - length);
  }
  const whitespace: Children = [];
  while (rest[0]?.type === "text") {
    const first = rest[0];
    const leading = /^\s*/.exec(first.value)?.[0] ?? "";
    if (!leading) break;
    whitespace.push({ type: "text", value: leading });
    rest.shift();
    if (leading.length < first.value.length) {
      rest.unshift({ type: "text", value: first.value.slice(leading.length) });
      break;
    }
  }
  return span("emend-example-row", [
    span("emend-example-label", label),
    ...whitespace,
    span("emend-example-value", rest),
  ]);
}

/** Trusted wrappers after sanitize; all original text and line separators survive. */
export function exampleRows() {
  return (tree: HtmlRoot, file: { data: Record<string, unknown> }) => {
    if (file.data.exampleRows !== true) return;
    const visit = (node: HtmlNode) => {
      if (!("children" in node)) return;
      if (node.type === "element" && ["ul", "ol", "table", "pre"].includes(node.tagName)) return;
      if (node.type !== "element" || node.tagName !== "p") {
        for (const child of node.children) visit(child);
        return;
      }
      const lines: Children[] = [[]];
      const separators: Children = [];
      for (const child of node.children) {
        if (child.type === "element" && child.tagName === "br") {
          separators.push(child);
          lines.push([]);
        } else if (child.type === "text") {
          for (const [index, value] of child.value.split("\n").entries()) {
            if (index > 0) {
              separators.push({ type: "text", value: "\n" });
              lines.push([]);
            }
            if (value) lines.at(-1)?.push({ type: "text", value });
          }
        } else lines.at(-1)?.push(child);
      }
      const rows = lines.map(labelledRow);
      if (!rows.some(Boolean)) return;
      const classes = Array.isArray(node.properties.className) ? node.properties.className : [];
      node.properties.className = [...classes, "emend-example-rows"];
      node.children = lines.flatMap((line, index) => {
        const separator = separators[index];
        const row = rows[index] ?? span("emend-example-line", line);
        return separator ? [row, separator] : [row];
      });
    };
    visit(tree);
  };
}
