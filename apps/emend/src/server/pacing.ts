import { setImmediate } from "node:timers/promises";

export type PacingPhase =
  | "publish-counts"
  | "publish-files"
  | "publish-placements"
  | "publish-doc-assets"
  | "publish-changed"
  | "publish-render"
  | "publish-finalize"
  | "import-insert"
  | "import-check-ids"
  | "import-placement-copy"
  | "import-prepare-comments"
  | "import-prepare-changed"
  | "lifecycle-blob-cleanup"
  | "lifecycle-bin-empty";

/** Test seam for counting work between main-thread yields; production leaves the probe unset. */
export const pacing: { probe?: (phase: PacingPhase) => void } = { probe: undefined };

export function yieldToLoop(phase: PacingPhase) {
  pacing.probe?.(phase);
  return setImmediate();
}
