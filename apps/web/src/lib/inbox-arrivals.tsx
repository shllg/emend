import type { InboxItem } from "@emend/contract";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { InboxData } from "../api/queries.ts";

function createArrivals() {
  let seen: Set<string> | null = null;
  let highlighted: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const update = (next: ReadonlySet<string>) => {
    highlighted = next;
    for (const listener of listeners) listener();
  };
  const hide = (items: readonly InboxItem[]) => {
    const removed = new Set(items.map(({ id }) => id));
    if ([...highlighted].some((id) => removed.has(id)))
      update(new Set([...highlighted].filter((id) => !removed.has(id))));
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => highlighted,
    baseline(items: readonly InboxItem[]) {
      seen ??= new Set(items.map(({ id }) => id));
    },
    show(items: readonly InboxItem[]) {
      if (!seen) return;
      const added = items.filter(({ id }) => !seen?.has(id));
      if (!added.length) return;
      for (const { id } of added) seen.add(id);
      update(new Set([...highlighted, ...added.map(({ id }) => id)]));
      const timer = setTimeout(() => {
        timers.delete(timer);
        hide(added);
      }, 1000);
      timers.add(timer);
    },
    hide,
    reset() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      seen = null;
      update(new Set());
    },
  };
}

const Arrivals = createContext<ReturnType<typeof createArrivals> | null>(null);

export function InboxArrivalsProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const client = useQueryClient();
  const [store] = useState(createArrivals);
  useEffect(() => {
    if (!enabled) return;
    // Cached data may predate this tab. Only its first completed inbox response sets the baseline.
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
      if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== "inbox") return;
      const data = client.getQueryData<InboxData>(["inbox"]);
      if (data) store.baseline(data.items);
    });
    return () => {
      unsubscribe();
      store.reset();
    };
  }, [client, enabled, store]);
  return <Arrivals.Provider value={store}>{children}</Arrivals.Provider>;
}

export function useInboxArrivals(items: readonly InboxItem[]) {
  const store = useContext(Arrivals);
  if (!store) throw new Error("Missing inbox arrivals provider");
  const visible = useRef(items);
  const highlighted = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    visible.current = items;
    store.show(items);
  }, [store, items]);
  useEffect(() => () => store.hide(visible.current), [store]);
  return highlighted;
}
