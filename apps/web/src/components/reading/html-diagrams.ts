import { DiagramReply } from "../../lib/frame-messages.ts";

export function parseDiagramReply(data: unknown): DiagramReply | undefined {
  const parsed = DiagramReply.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

export function dedentDiagram(source: string): string {
  const all = source.split(/\r\n|\r|\n/);
  const start = all.findIndex((line) => line.trim());
  if (start < 0) return "";
  let end = all.length;
  while (end > start && !all[end - 1]?.trim()) end--;
  const lines = all.slice(start, end);
  let common: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = /^\s*/u.exec(line)?.[0] ?? "";
    if (common === undefined) common = indent;
    else {
      let length = 0;
      while (length < common.length && common[length] === indent[length]) length++;
      common = common.slice(0, length);
    }
  }
  return lines.map((line) => (line.trim() ? line.slice(common?.length ?? 0) : "")).join("\n");
}
