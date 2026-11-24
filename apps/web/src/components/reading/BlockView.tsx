import type { RenderedBlock } from "@recense/contract";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../ui/Button.tsx";
import { ChartBlock } from "./ChartBlock.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";

/** A comment's server-rendered, sanitized Markdown. Like BlockView, the only other place that sets HTML. */
export function CommentHtml({ html }: { html: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: ThreadView.comments[].html comes from the server's sanitize pipeline, like RenderedBlock.html.
  return <div className="em-prose em-comment-html" dangerouslySetInnerHTML={{ __html: html }} />;
}

const SIDE = /^[1-9][0-9]{0,4}$/;
const MAX_SIDE = 65535;

type PairMode = "before" | "after" | "side" | "diff";

function pairModeForReveal(mode: PairMode, view: "before" | "after" | "diff", pairHasDiff: boolean): PairMode {
  if (mode === "side" || mode === view) return mode;
  if (mode === "diff" && !pairHasDiff) return mode;
  return view;
}

/** Blocks stored before the rename carry `emend-media-*` classes; they read like the current ones. */
const mediaHas = (element: Element | null | undefined, suffix: string) =>
  !!element?.classList.contains(`recense-media-${suffix}`) || !!element?.classList.contains(`emend-media-${suffix}`);

/**
 * A prose block. Only an image whose wrapper is `span.recense-media.recense-media-sized` carries the
 * server's pixel size in `width` and `height`; any other media image may hold an author's numbers
 * (revisions stored before the marker), so its size is never used.
 */
function ProseBlock({ block, attributes }: { block: RenderedBlock; attributes: Record<string, string> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pair, setPair] = useState(false);
  const [pairDiff, setPairDiff] = useState(false);
  const [mode, setMode] = useState<PairMode>("side");
  // CSS cannot read attribute numbers in every browser yet, so the app copies them into custom properties.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the images change only when the block's HTML does.
  useLayoutEffect(() => {
    const prose = ref.current;
    setPair(!!prose?.querySelector("p:is(.recense-media-pair, .emend-media-pair)"));
    const hasDiff = !!prose?.querySelector("p:is(.recense-media-pair-diff, .emend-media-pair-diff)");
    setPairDiff(hasDiff);
    if (!hasDiff) setMode((current) => (current === "diff" ? "side" : current));
    for (const image of ref.current?.querySelectorAll("span:is(.recense-media, .emend-media) > img") ?? []) {
      const wrapper = image.parentElement;
      if (!wrapper) continue;
      const width = image.getAttribute("width") ?? "";
      const height = image.getAttribute("height") ?? "";
      if (
        mediaHas(wrapper, "sized") &&
        SIDE.test(width) &&
        SIDE.test(height) &&
        Number(width) <= MAX_SIDE &&
        Number(height) <= MAX_SIDE
      ) {
        wrapper.style.setProperty("--recense-media-w", String(Number(width)));
        wrapper.style.setProperty("--recense-media-h", String(Number(height)));
      } else {
        wrapper.style.removeProperty("--recense-media-w");
        wrapper.style.removeProperty("--recense-media-h");
      }
    }
    const reveal = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target === prose && prose?.querySelector("p:is(.recense-media-pair, .emend-media-pair)")) {
        // Navigation scrolls and measures before React commits the state update.
        prose.setAttribute("data-pair-mode", "side");
        setMode("side");
        return;
      }
      const media = target?.closest("p:is(.recense-media-pair, .emend-media-pair) > :is(.recense-media, .emend-media)");
      if (!media || !prose?.contains(media)) return;
      const images = media.parentElement?.querySelectorAll(":scope > :is(.recense-media, .emend-media)");
      const next = mediaHas(media, "diff")
        ? "diff"
        : images?.[0] === media
          ? "before"
          : images?.[1] === media
            ? "after"
            : undefined;
      if (next) {
        const attribute = prose.getAttribute("data-pair-mode");
        const current: PairMode =
          attribute === "before" || attribute === "after" || attribute === "diff" ? attribute : "side";
        const mode = pairModeForReveal(current, next, mediaHas(media.parentElement, "pair-diff"));
        prose.setAttribute("data-pair-mode", mode);
        setMode(mode);
      }
    };
    prose?.addEventListener("recense:reveal-reading", reveal);
    return () => prose?.removeEventListener("recense:reveal-reading", reveal);
  }, [block.html]);
  return (
    <>
      {pair && (
        // biome-ignore lint/a11y/useSemanticElements: screenshot view buttons form an ARIA group, not a form fieldset.
        <div
          key="modes"
          className="em-pair-modes mb-2 inline-flex select-none gap-0.5 rounded-md border border-line-1 bg-sunken p-0.5"
          role="group"
          aria-label="Compare screenshots"
        >
          {(
            [
              ["before", "Before"],
              ["after", "After"],
              ["side", "Side by side"],
              ["diff", "Diff"],
            ] as const
          )
            .filter(([value]) => value !== "diff" || pairDiff)
            .map(([value, label]) => (
              <Button
                key={value}
                variant="ghost"
                size="sm"
                className="aria-pressed:bg-raised aria-pressed:text-fg-1 aria-pressed:shadow-1"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {label}
              </Button>
            ))}
        </div>
      )}
      <div
        key="prose"
        {...attributes}
        ref={ref}
        className="em-prose"
        data-pair-mode={pair ? mode : undefined}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: RenderedBlock.html is sanitized by the server; this is the sole rendering boundary.
        dangerouslySetInnerHTML={{ __html: block.html }}
      />
    </>
  );
}

export function BlockView({ block }: { block: RenderedBlock }) {
  const attributes = {
    id: `block-${block.id}`,
    "data-block-id": block.id,
    "data-block-kind": block.kind,
    "data-block-text": block.text,
  };
  if (block.kind === "chart")
    return (
      <div {...attributes}>
        <ChartBlock source={block.source ?? block.text} />
      </div>
    );
  return block.kind === "diagram" ? (
    <div {...attributes}>
      <MermaidBlock source={block.source ?? block.text} />
    </div>
  ) : (
    <ProseBlock block={block} attributes={attributes} />
  );
}
