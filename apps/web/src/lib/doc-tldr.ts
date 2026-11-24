import type { RenderedBlock } from "@recense/contract";

/** Find the first h2 TL;DR section when it has content, ending before the next h1 or h2. */
export function docTldrRange(blocks: readonly RenderedBlock[]): { start: number; end: number } | undefined {
  const start = blocks.findIndex(
    (block) =>
      block.kind === "heading" &&
      /^<h2(?:\s|>)/.test(block.html) &&
      block.text.trim().replace(/:$/, "").toLowerCase() === "tl;dr",
  );
  if (start < 0) return;
  let end = start + 1;
  for (; end < blocks.length; end++) {
    const block = blocks[end];
    if (block?.kind === "heading" && /^<h[12](?:\s|>)/.test(block.html)) break;
  }
  return end > start + 1 ? { start, end } : undefined;
}
