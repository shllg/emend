import { type DepthLayer, depthLayers } from "./useDepthLayer.ts";

const labels = { decide: "Decide", frame: "Frame", topics: "Topics", trail: "Trail" };

export function DepthMarker({
  current,
  present,
  compact = false,
}: {
  current: DepthLayer;
  present: readonly DepthLayer[];
  compact?: boolean;
}) {
  const active = present.includes(current) ? current : present[0];
  const index = active ? depthLayers.indexOf(active) : -1;
  return (
    <ol aria-label="Writeup depth" className="em-depth-marker" data-compact={compact ? "" : undefined}>
      {depthLayers.map((layer, step) => (
        <li
          key={layer}
          className="em-depth-step"
          aria-current={layer === active ? "step" : undefined}
          data-present={present.includes(layer)}
          data-filled={present.includes(layer) && step <= index}
        >
          <span className="em-depth-segment" aria-hidden="true" />
          <span className={compact && layer !== active ? "em-depth-label sr-only" : "em-depth-label"}>
            {labels[layer]}
          </span>
        </li>
      ))}
    </ol>
  );
}
