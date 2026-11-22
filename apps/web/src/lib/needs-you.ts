import type { NeedsYouKind } from "@emend/contract";
import { plural } from "./count.ts";

export const needsYouLabels: Record<NeedsYouKind, string> = {
  decide: "Decide",
  accept: "Accept",
  "confirm-drift": "Confirm drift",
  answer: "Answer",
};

export function needsYouStatus(list: readonly unknown[] | undefined): string | undefined {
  if (list === undefined) return undefined;
  return list.length
    ? `${list.length} ${plural(list.length, "decision")}`
    : "Nothing needs a decision. Approve on the proof.";
}
