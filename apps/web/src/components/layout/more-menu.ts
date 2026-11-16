import { createContext, useContext, useLayoutEffect, useRef } from "react";
import type { MenuItem } from "../ui/Menu.tsx";

export const MoreMenuItems = createContext<(items: MenuItem[] | undefined) => void>(() => {});

// Hands the items to the phone's More menu on every render of the caller, and withdraws them on unmount.
// A caller withdraws only items it handed over itself, so a pane that never registered cannot clear another's.
export function useMoreMenuItems(items: MenuItem[] | undefined) {
  const setItems = useContext(MoreMenuItems);
  const shown = useRef(false);
  // The items are rebuilt each render, so they must reach the menu each render.
  useLayoutEffect(() => {
    if (items) setItems(items);
    else if (shown.current) setItems(undefined);
    shown.current = !!items;
  });
  useLayoutEffect(
    () => () => {
      if (shown.current) setItems(undefined);
    },
    [setItems],
  );
}
