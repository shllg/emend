import { toString as hastText } from "hast-util-to-string";
import type { HtmlElement, HtmlNode, HtmlRoot } from "./blocks.ts";
import { isMediaSpan } from "./sanitize.ts";

type Children = HtmlElement["children"];
type Row = { label?: Children; value: Children };

function mergeText(children: Children): Children {
  const merged: Children = [];
  for (const child of children) {
    const last = merged.at(-1);
    if (last?.type === "text" && child.type === "text") last.value += child.value;
    else merged.push(child.type === "text" ? { ...child } : child);
  }
  return merged;
}

const span = (className: string, children: Children): HtmlElement => ({
  type: "element",
  tagName: "span",
  properties: { className: [className] },
  children: mergeText(children),
});

function labelledRow(children: Children): Row | undefined {
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
  return { label, value: rest };
}

function containsMedia(node: HtmlNode): boolean {
  return isMediaSpan(node) || ("children" in node && node.children.some(containsMedia));
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
      if (containsMedia(node)) return;
      const prefix: Children = [];
      let content = node.children;
      const marker = content[0];
      if (
        marker?.type === "element" &&
        marker.tagName === "span" &&
        Array.isArray(marker.properties.className) &&
        marker.properties.className.includes("emend-callout-marker")
      ) {
        // Keep the hidden marker and its separators outside the visible example rows.
        prefix.push(marker);
        content = content.slice(1);
        for (let child = content[0]; child; child = content[0]) {
          if (child.type === "text") {
            const whitespace = /^[ \t\r\n\f]+/.exec(child.value)?.[0];
            if (!whitespace) break;
            prefix.push({ ...child, value: whitespace });
            if (whitespace.length < child.value.length) {
              content[0] = { ...child, value: child.value.slice(whitespace.length) };
              break;
            }
          } else if (
            child.type === "element" &&
            child.tagName === "br" &&
            Array.isArray(child.properties.className) &&
            child.properties.className.includes("emend-callout-marker-break")
          ) {
            prefix.push(child);
          } else break;
          content.shift();
        }
      }
      const lines: { children: Children; before: Children }[] = [];
      let line = { children: [] as Children, before: [] as Children };
      lines.push(line);
      const separate = (separator: Children[number]) => {
        // Keep adjacent separators together, including the newline emitted after a hard break.
        if (line.children.length) {
          line = { children: [], before: [] };
          lines.push(line);
        }
        line.before.push(separator);
      };
      for (const child of content) {
        if (child.type === "element" && child.tagName === "br") separate(child);
        else if (child.type === "text") {
          for (const [index, value] of child.value.split("\n").entries()) {
            if (index > 0) separate({ type: "text", value: "\n" });
            if (value) line.children.push({ type: "text", value });
          }
        } else line.children.push(child);
      }
      const rows = lines.map((line) => labelledRow(line.children));
      if (!rows.some(Boolean)) return;
      const classes = Array.isArray(node.properties.className) ? node.properties.className : [];
      node.properties.className = [...classes, "emend-example-rows"];
      const children: Children = [...prefix];
      let current: Row | undefined;
      const flush = () => {
        if (!current) return;
        children.push(
          current.label
            ? span("emend-example-row", [
                span("emend-example-label", current.label),
                span("emend-example-value", current.value),
              ])
            : span("emend-example-line", current.value),
        );
      };
      for (const [index, line] of lines.entries()) {
        const row = rows[index];
        if (row) {
          flush();
          children.push(...line.before);
          current = row;
        } else {
          current ??= { value: [] };
          current.value.push(...line.before, ...line.children);
        }
      }
      flush();
      node.children = children;
    };
    visit(tree);
  };
}
