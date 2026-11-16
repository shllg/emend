import { useCallback, useSyncExternalStore } from "react";
import { layoutStore, useLayoutPreferences } from "./layout-store.ts";

export function useMedia(query: string) {
  const subscribe = useCallback(
    (notify: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", notify);
      return () => media.removeEventListener("change", notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
export function useLayout() {
  const desktop = useMedia("(min-width: 1280px)");
  const tablet = useMedia("(min-width: 768px)");
  return desktop ? "desktop" : tablet ? "tablet" : "phone";
}
export function useInboxCollapsed() {
  const { inboxCollapsed } = useLayoutPreferences();
  return [inboxCollapsed, (value: boolean) => layoutStore.update({ inboxCollapsed: value })] as const;
}
/** Whether diff topic headers show their details, remembered once per device class. */
export function useTopicDetails() {
  const layout = useLayout();
  const { details } = useLayoutPreferences();
  return [
    details[layout],
    (open: boolean) => layoutStore.update({ details: { ...layoutStore.getSnapshot().details, [layout]: open } }),
  ] as const;
}
export function usePaneMode() {
  const layout = useLayout();
  const { pane } = useLayoutPreferences();
  return layout === "phone" ? "tabs" : pane[layout];
}
