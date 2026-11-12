import { Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Size } from "../../lib/lightbox-view.ts";
import { Button } from "../ui/Button.tsx";

function dimension(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 10000;
}

export function parseFrameSize(data: unknown): { height: number; natural?: Size | null } | undefined {
  if (
    !data ||
    typeof data !== "object" ||
    !("type" in data) ||
    data.type !== "size" ||
    !("height" in data) ||
    !dimension(data.height)
  )
    return;
  if (!("natural" in data) || data.natural === undefined) return { height: data.height };
  const natural = data.natural;
  if (natural === null) return { height: data.height, natural: null };
  if (
    typeof natural !== "object" ||
    !("width" in natural) ||
    !("height" in natural) ||
    !dimension(natural.width) ||
    !dimension(natural.height)
  )
    return;
  return { height: data.height, natural: { width: natural.width, height: natural.height } };
}

export const DIAGRAM_DRAW_TIMEOUT_MS = 20_000;

export function LightboxDiagram({ source, onSize }: { source: string; onSize: (natural: Size | null) => void }) {
  const loaded = useRef(false);
  const reported = useRef(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    timer.current = setTimeout(() => {
      if (reported.current) return;
      reported.current = true;
      onSize(null);
    }, DIAGRAM_DRAW_TIMEOUT_MS);
    return () => clearTimeout(timer.current);
  }, [onSize]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frame.current?.contentWindow || event.source !== frame.current.contentWindow || reported.current) return;
      const data = parseFrameSize(event.data);
      if (data?.natural === undefined) return;
      reported.current = true;
      clearTimeout(timer.current);
      onSize(data.natural);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onSize]);
  return (
    <iframe
      ref={frame}
      title="Diagram"
      src="/mermaid-frame.html"
      sandbox="allow-scripts"
      tabIndex={-1}
      className="pointer-events-none block h-full w-full border-0 bg-transparent"
      onLoad={() => {
        if (loaded.current) return;
        loaded.current = true;
        frame.current?.contentWindow?.postMessage({ type: "render", source }, "*");
      }}
    />
  );
}

export function MermaidBlock({ source }: { source: string }) {
  return <DiagramFrame key={source} source={source} />;
}
function DiagramFrame({ source }: { source: string }) {
  const loaded = useRef(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frame.current?.contentWindow || event.source !== frame.current.contentWindow) return;
      const data = parseFrameSize(event.data);
      if (!data) return;
      setHeight(data.height);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return (
    <div className="relative space-y-2 overflow-auto rounded-md bg-sunken p-3.5">
      <iframe
        ref={frame}
        title="Diagram"
        loading="lazy"
        src="/mermaid-frame.html"
        sandbox="allow-scripts"
        className="w-full border-0 bg-transparent"
        style={{ height }}
        onLoad={() => {
          if (loaded.current) return;
          loaded.current = true;
          frame.current?.contentWindow?.postMessage({ type: "render", source }, "*");
        }}
      />
      <div className="flex items-baseline gap-2">
        <details className="min-w-0 flex-1">
          <summary className="cursor-pointer text-fg-3 [font:var(--type-meta)]">Diagram source</summary>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-12 font-stretch-mono text-fg-2">
            {source}
          </pre>
        </details>
        <Button
          variant="ghost"
          size="sm"
          icon={Maximize2}
          aria-label="Enlarge diagram"
          aria-haspopup="dialog"
          data-lightbox-diagram=""
          onMouseUpCapture={(event) => event.stopPropagation()}
          onKeyUpCapture={(event) => event.stopPropagation()}
        >
          Enlarge
        </Button>
      </div>
    </div>
  );
}
