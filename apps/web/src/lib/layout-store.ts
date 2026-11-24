import { z } from "@recense/contract/browser";
import { useSyncExternalStore } from "react";

export const layoutKey = "recense.layout.v1";
export const tabsDefaultKey = "recense.layout.tabs-default";
const paneChoice = z.enum(["split", "tabs"]);
export const readingWidthSchema = z.enum(["comfortable", "wide", "narrow"]);
export const proseSizeSchema = z.union([z.literal(15), z.literal(16), z.literal(17), z.literal(18)]);
export const codePxSchema = z.union([z.literal(12), z.literal(13), z.literal(14), z.literal(15)]);
export const layoutSchema = z.object({
  inboxWidth: z.number().min(220).max(520).catch(280),
  readingShare: z.number().min(0).max(1).catch(0.42),
  pane: z
    .object({ desktop: paneChoice.catch("tabs"), tablet: paneChoice.catch("tabs") })
    .catch({ desktop: "tabs", tablet: "tabs" }),
  readingWidth: readingWidthSchema.catch("comfortable"),
  hideResolved: z.boolean().catch(false),
  diffStyle: z.enum(["split", "unified"]).catch("split"),
  fileOrder: z.enum(["topics", "path"]).catch("topics"),
  wrap: z.boolean().catch(false),
  notes: z.boolean().catch(true),
  // Diff topic headers: true shows the summary and blast radius. One choice per device class.
  details: z
    .object({ phone: z.boolean().catch(false), tablet: z.boolean().catch(true), desktop: z.boolean().catch(true) })
    .catch({ phone: false, tablet: true, desktop: true }),
  inboxCollapsed: z.boolean().catch(false),
  proseSize: proseSizeSchema.catch(16),
  // Code in diffs inherits --type-code, currently 13px.
  codePx: codePxSchema.catch(13),
});
export type LayoutPreferences = z.infer<typeof layoutSchema>;
export type FileOrder = LayoutPreferences["fileOrder"];
export type ReadingWidth = LayoutPreferences["readingWidth"];
export const readingMeasure = { comfortable: "1024px", wide: "1248px", narrow: "68ch" } as const;
type LayoutPatch = Partial<Omit<LayoutPreferences, "proseSize" | "codePx">> & {
  proseSize?: number;
  codePx?: number;
};
export const defaultLayout = layoutSchema.parse({});

function parse(raw: string | null): LayoutPreferences {
  try {
    const value = JSON.parse(raw ?? "{}");
    if (
      value !== null &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype &&
      ![12, 13, 14, 15].includes(value.codePx) &&
      [11, 12, 13, 14].includes(value.codeSize)
    ) {
      // Legacy sizes use Martian Mono units; JetBrains Mono needs 1px more for the same visual size.
      value.codePx = value.codeSize + 1;
    }
    return layoutSchema.parse(value);
  } catch {
    return layoutSchema.parse({});
  }
}
function read(key: string): string | null | undefined {
  try {
    return localStorage.getItem(key);
  } catch {
    return undefined;
  }
}

export function createLayoutStore() {
  let saved = read(layoutKey);
  const tabsDefault = read(tabsDefaultKey);
  let snapshot =
    saved == null
      ? layoutSchema.parse({
          diffStyle: read("recense.diff.layout") ?? undefined,
          wrap: read("recense.diff.wrap") === "true",
          inboxCollapsed: read("recense.inbox.collapsed") === "true",
        })
      : parse(saved);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const persist = () => {
    try {
      // Older tabs still use 11–14 units; keep their visual size in the same atomic write.
      const raw = JSON.stringify({ ...snapshot, codeSize: snapshot.codePx - 1 });
      localStorage.setItem(layoutKey, raw);
      saved = raw;
    } catch {
      // Preferences still work in memory when storage is denied or full.
    }
  };
  // A separate marker keeps older tabs that strip unknown layout fields from repeating the move.
  if (saved != null && tabsDefault === null) {
    snapshot = { ...snapshot, pane: { ...snapshot.pane, desktop: "tabs" } };
    persist();
  }
  if (saved === null) persist();
  if (tabsDefault === null) {
    try {
      localStorage.setItem(tabsDefaultKey, "1");
    } catch {
      // Preferences still work in memory when storage is denied or full.
    }
  }
  const getSnapshot = () => {
    const raw = read(layoutKey);
    if (raw !== undefined && raw !== saved) {
      saved = raw;
      snapshot = parse(raw);
    }
    return snapshot;
  };
  const reconcile = () => {
    const previous = snapshot;
    if (getSnapshot() !== previous) notify();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== layoutKey) return;
    try {
      if (event.storageArea && event.storageArea !== localStorage) return;
    } catch {
      return;
    }
    getSnapshot();
    // A render may already have refreshed the cache before this event was delivered.
    notify();
  };
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      if (listeners.size === 0) window.addEventListener("storage", onStorage);
      listeners.add(listener);
      // Catch writes that happened between the render's first read and subscription.
      reconcile();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) window.removeEventListener("storage", onStorage);
      };
    },
    update(patch: LayoutPatch) {
      const next = { ...getSnapshot(), ...patch };
      next.inboxWidth = Math.min(520, Math.max(220, next.inboxWidth));
      next.readingShare = Math.min(1, Math.max(0, next.readingShare));
      snapshot = layoutSchema.parse({
        ...next,
        proseSize: Math.round(Math.min(18, Math.max(15, next.proseSize))),
        codePx: Math.round(Math.min(15, Math.max(12, next.codePx))),
      });
      persist();
      notify();
    },
  };
}

export const layoutStore = createLayoutStore();
export function useLayoutPreferences() {
  return useSyncExternalStore(layoutStore.subscribe, layoutStore.getSnapshot, () => defaultLayout);
}
