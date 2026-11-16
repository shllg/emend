import { createContext } from "react";

// The review's main diff pane puts its controls outside its own scroller: the toolbar into the tab
// row while the Diff tab is open in Tabs mode, and the file jump into the phone's More menu.
// A pane without the provider (the code sheet, standalone tests) keeps them to itself.
export const DiffChrome = createContext<{ toolbarSlot: HTMLElement | null } | null>(null);
