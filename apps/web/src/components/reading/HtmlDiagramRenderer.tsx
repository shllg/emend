import { useEffect, useRef, useState } from "react";
import type { DiagramJob, ParentToFrame } from "../../lib/frame-messages.ts";
import { useResolvedTheme } from "../../lib/theme.ts";
import { useDiagramThemeKey } from "../../lib/use-diagram-theme-key.ts";
import { dedentDiagram, parseDiagramReply } from "./html-diagrams.ts";
import { DIAGRAM_DRAW_TIMEOUT_MS } from "./MermaidBlock.tsx";
import { readMermaidColors } from "./mermaid-colors.ts";

type Props = { job: DiagramJob; look?: "recense" | "custom"; post: (message: ParentToFrame) => void };

export function HtmlDiagramRenderer(props: Props) {
  const theme = useResolvedTheme();
  const themeKey = useDiagramThemeKey();
  return <RenderJob key={`${props.job.request}:${themeKey}:${theme}`} {...props} theme={theme} />;
}

function RenderJob({ job, look, post, theme }: Props & { theme: "light" | "dark" }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const loaded = useRef(false);
  const waiting = useRef(false);
  const send = useRef<(() => void) | undefined>(undefined);
  const [index, setIndex] = useState(0);
  const [generation, setGeneration] = useState(0);
  const diagram = job.diagrams[index];
  useEffect(() => {
    if (!diagram) return;
    let finished = false;
    const finish = (answer: ReturnType<typeof parseDiagramReply>, timedOut = false) => {
      if (finished || !answer) return;
      finished = true;
      waiting.current = false;
      clearTimeout(timer);
      post({ ...answer, type: "recense:diagram", request: job.request, index });
      if (timedOut) {
        loaded.current = false;
        setGeneration((value) => value + 1);
      }
      setIndex((value) => value + 1);
    };
    const receive = (event: MessageEvent) => {
      if (!waiting.current || !frame.current?.contentWindow || event.source !== frame.current.contentWindow) return;
      finish(parseDiagramReply(event.data));
    };
    const timer = setTimeout(() => finish({ type: "svg", svg: null }, true), DIAGRAM_DRAW_TIMEOUT_MS);
    window.addEventListener("message", receive);
    send.current = () => {
      if (waiting.current || finished) return;
      const colors = look === "recense" && diagram.mode === theme ? readMermaidColors() : undefined;
      waiting.current = true;
      frame.current?.contentWindow?.postMessage(
        {
          type: "render",
          source: dedentDiagram(diagram.source),
          theme: diagram.mode,
          reply: "svg",
          ...(colors ? { colors } : {}),
        },
        "*",
      );
    };
    if (loaded.current) send.current();
    return () => {
      finished = true;
      waiting.current = false;
      send.current = undefined;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
  }, [diagram, index, job.request, look, post, theme]);
  if (!diagram) return null;
  return (
    <iframe
      ref={frame}
      key={generation}
      src="/mermaid-frame.html"
      sandbox="allow-scripts"
      title="HTML diagram renderer"
      aria-hidden="true"
      tabIndex={-1}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        visibility: "hidden",
        pointerEvents: "none",
        width: Math.max(240, Math.min(2400, diagram.width)),
        height: 160,
        border: 0,
      }}
      onLoad={() => {
        if (loaded.current) return;
        loaded.current = true;
        send.current?.();
      }}
    />
  );
}
