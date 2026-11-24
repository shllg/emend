import type { Target } from "@recense/contract";
import { createContext } from "react";

export type DiffDestination = { elementId?: string; element?: HTMLElement; target?: Target; commentId?: string };
/** True only after reveal, final placement, and scrolling have completed. */
export type NavigateDiff = (destination: DiffDestination) => boolean;
export const DiffNavigation = createContext<NavigateDiff | null>(null);
