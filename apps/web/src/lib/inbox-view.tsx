import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

export type InboxSurface = "page" | "pane" | "sheet";
type InboxView = {
  filter: string;
  machine: string;
  project: string;
  open: Readonly<Record<string, boolean>>;
};

export function createInboxView() {
  let view: InboxView = { filter: "", machine: "", project: "", open: {} };
  const listeners = new Set<() => void>();
  const scroll = new Map<InboxSurface, number>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => view,
    update(patch: Partial<InboxView> | ((view: InboxView) => Partial<InboxView>)) {
      view = { ...view, ...(typeof patch === "function" ? patch(view) : patch) };
      for (const listener of listeners) listener();
    },
    scrollOf: (surface: InboxSurface) => scroll.get(surface) ?? 0,
    setScroll(surface: InboxSurface, top: number) {
      scroll.set(surface, top);
    },
  };
}

const InboxViewContext = createContext<ReturnType<typeof createInboxView> | null>(null);

export function InboxViewProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createInboxView);
  return <InboxViewContext.Provider value={store}>{children}</InboxViewContext.Provider>;
}

function useInboxViewStore() {
  const store = useContext(InboxViewContext);
  if (!store) throw new Error("Missing inbox view provider");
  return store;
}

export function useInboxView() {
  const store = useInboxViewStore();
  const view = useSyncExternalStore(store.subscribe, store.snapshot);
  return [view, store.update] as const;
}

export function useInboxScroll(surface: InboxSurface, scroller: () => HTMLElement | null | undefined, ready: boolean) {
  const store = useInboxViewStore();
  const restored = useRef(false);
  const getScroller = useRef(scroller);
  useLayoutEffect(() => {
    if (!ready || restored.current) return;
    const element = getScroller.current();
    if (!element) return;
    element.scrollTop = store.scrollOf(surface);
    restored.current = true;
  }, [ready, store, surface]);
  useEffect(() => {
    const element = getScroller.current();
    if (!element) return;
    const remember = () => store.setScroll(surface, element.scrollTop);
    element.addEventListener("scroll", remember, { passive: true });
    return () => element.removeEventListener("scroll", remember);
  }, [store, surface]);
}
