import { createContext, type ReactElement } from "react";

// The review page keeps this element mounted until it closes, so file and tab switches
// never end the diff worker pool.
export const DiffWorkersHold = createContext<((keeper: ReactElement) => void) | null>(null);
