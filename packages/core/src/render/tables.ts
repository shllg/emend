type Node = {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

// Parse large simple tables as a tiny placeholder code node, restoring their source before
// conversion to HTML. This avoids even the parser's per-row allocation. Nested tables use
// the AST guard below. Placeholders cannot collide with any author-supplied text.
export function prepareTables(markdown: string) {
  const lines = markdown.split("\n");
  const output: string[] = [];
  const tables = new Map<string, string>();
  let prefix = "recense-large-table-";
  while (markdown.includes(prefix)) prefix += "-";
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const run = marker?.[1];
    if (fence || run) {
      if (!fence) fence = run;
      else if (run && run[0] === fence[0] && run.length >= fence.length && !marker?.[2]?.trim()) fence = undefined;
      output.push(line);
      continue;
    }
    const separator = lines[i + 1] ?? "";
    const cells = separator
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|");
    if (
      line.includes("|") &&
      !line.includes("\\") &&
      separator.includes("|") &&
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|").length === cells.length &&
      cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell))
    ) {
      let end = i + 2;
      while (
        end < lines.length &&
        /\S/.test(lines[end] ?? "") &&
        !/^ {0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|`{3}|~{3}|<|(?:[-*_]\s*){3,}$)/.test(lines[end] ?? "")
      )
        end++;
      const source = lines.slice(i, end).join("\n");
      if ((end - i - 1) * cells.length > 100000) {
        const key = `${prefix}${tables.size}`;
        tables.set(key, source);
        output.push("```", key, "```");
      } else output.push(source);
      i = end - 1;
      continue;
    }
    output.push(line);
  }
  return { source: output.join("\n"), tables };
}

/** Bound the rectangular expansion performed by mdast-util-to-hast. */
export function limitTables() {
  return (tree: Node, file: { value: unknown; data: Record<string, unknown> }) => {
    const source = String(file.value);
    const tables = file.data.largeTables as Map<string, string> | undefined;
    const walk = (parent: Node) => {
      for (const [index, node] of (parent.children ?? []).entries()) {
        if (node.type === "code" && node.value !== undefined && tables?.has(node.value)) {
          node.value = tables.get(node.value);
        } else if (
          node.type === "table" &&
          (node.children?.length ?? 0) * (node.children?.[0]?.children?.length ?? 0) > 100000
        ) {
          const code = {
            type: "code",
            lang: null,
            meta: null,
            value: source.slice(node.position?.start.offset, node.position?.end.offset),
          };
          if (parent.children) parent.children[index] = code;
        } else walk(node);
      }
    };
    walk(tree);
  };
}
