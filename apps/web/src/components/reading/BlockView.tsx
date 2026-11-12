import type { RenderedBlock } from "@emend/contract";
import { useLayoutEffect, useRef } from "react";
import { MermaidBlock } from "./MermaidBlock.tsx";

/** A comment's server-rendered, sanitized Markdown. Like BlockView, the only other place that sets HTML. */
export function CommentHtml({ html }: { html: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: ThreadView.comments[].html comes from the server's sanitize pipeline, like RenderedBlock.html.
  return <div className="em-prose em-comment-html" dangerouslySetInnerHTML={{ __html: html }} />;
}

const SIDE = /^[1-9][0-9]{0,4}$/;
const MAX_SIDE = 65535;

/**
 * A prose block. Only an image whose wrapper is `span.emend-media.emend-media-sized` carries the
 * server's pixel size in `width` and `height`; any other media image may hold an author's numbers
 * (revisions stored before the marker), so its size is never used.
 */
function ProseBlock({ block, attributes }: { block: RenderedBlock; attributes: Record<string, string> }) {
  const ref = useRef<HTMLDivElement>(null);
  // CSS cannot read attribute numbers in every browser yet, so the app copies them into custom properties.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the images change only when the block's HTML does.
  useLayoutEffect(() => {
    for (const image of ref.current?.querySelectorAll("span.emend-media > img") ?? []) {
      const wrapper = image.parentElement;
      if (!wrapper) continue;
      const width = image.getAttribute("width") ?? "";
      const height = image.getAttribute("height") ?? "";
      if (
        wrapper.classList.contains("emend-media-sized") &&
        SIDE.test(width) &&
        SIDE.test(height) &&
        Number(width) <= MAX_SIDE &&
        Number(height) <= MAX_SIDE
      ) {
        wrapper.style.setProperty("--emend-media-w", String(Number(width)));
        wrapper.style.setProperty("--emend-media-h", String(Number(height)));
      } else {
        wrapper.style.removeProperty("--emend-media-w");
        wrapper.style.removeProperty("--emend-media-h");
      }
    }
  }, [block.html]);
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: RenderedBlock.html is sanitized by the server; this is the sole rendering boundary.
    <div {...attributes} ref={ref} className="em-prose" dangerouslySetInnerHTML={{ __html: block.html }} />
  );
}

export function BlockView({ block }: { block: RenderedBlock }) {
  const attributes = {
    id: `block-${block.id}`,
    "data-block-id": block.id,
    "data-block-kind": block.kind,
    "data-block-text": block.text,
  };
  return block.kind === "diagram" ? (
    <div {...attributes}>
      <MermaidBlock source={block.source ?? block.text} />
    </div>
  ) : (
    <ProseBlock block={block} attributes={attributes} />
  );
}
