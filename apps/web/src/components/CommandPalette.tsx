import * as Primitive from "@radix-ui/react-dialog";
import type { InboxItem, ShortcutCommand } from "@recense/contract";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { inboxQuery, serverNow } from "../api/queries.ts";
import { fuzzyMatch } from "../lib/fuzzy-match.ts";
import { matchInboxItems } from "../lib/inbox-list.ts";
import { hasOpenOverlay, keyLabel, shortcutGroups, shortcutLabels } from "../lib/shortcuts.ts";
import { useShortcut, useShortcutKeys, useShortcutRunner } from "../lib/use-shortcut.tsx";
import { useVisualViewportInset } from "../lib/visual-viewport.ts";
import { IconButton } from "./ui/IconButton.tsx";
import { Kbd } from "./ui/Kbd.tsx";
import { isToastInteraction, overlayClass } from "./ui/overlay.ts";
import { cn } from "./ui/utils.ts";

const BIDI_CONTROL = /\p{Bidi_Control}/gu;

type PaletteRow = { score: number } & (
  | { key: `command:${ShortcutCommand}`; command: ShortcutCommand }
  | { key: `item:${string}`; item: InboxItem; done: boolean }
);
type RowKey = PaletteRow["key"];
type PendingTarget = { command: ShortcutCommand } | { reviewId: string; rev: number };

function matchingGroups(query: string, items: ReturnType<typeof matchInboxItems>) {
  const groups: { label: string; rows: PaletteRow[]; score: number }[] = shortcutGroups.map((group) => {
    const rows = group.commands
      .filter((command) => command !== "palette.open")
      .flatMap<PaletteRow>((command) => {
        const score = fuzzyMatch(query, shortcutLabels[command]);
        return score === null ? [] : [{ key: `command:${command}`, command, score }];
      })
      .toSorted((a, b) => b.score - a.score);
    return { label: group.label, rows, score: rows[0]?.score ?? 0 };
  });
  if (items.length > 0) {
    groups.push({
      label: "Reviews and pubs",
      rows: items.map((match) => ({ ...match, key: `item:${match.item.id}` })),
      score: items.reduce((best, match) => Math.max(best, match.score), -Infinity),
    });
  }
  return groups.filter((group) => group.rows.length > 0).toSorted((a, b) => b.score - a.score);
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Null follows the first available result, including results that arrive after opening or typing.
  const [selected, setSelected] = useState<RowKey | null>(null);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useVisualViewportInset(node);
  const input = useRef<HTMLInputElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const pending = useRef<PendingTarget | null>(null);
  const armed = useRef<RowKey | null>(null);
  const id = useId();
  const listId = `${id}-results`;
  const rowId = (key: RowKey) => `${id}-${key}`;
  const navigate = useNavigate();
  const { data } = useQuery({ ...inboxQuery(), enabled: open, subscribed: open });
  const keys = useShortcutKeys();
  const runner = useShortcutRunner();
  const available = runner.available();
  // Large inboxes match on each keystroke; selection changes must not repeat that work.
  const matches = useMemo(
    () => (open ? matchInboxItems(data?.items ?? [], serverNow(data), query, data?.groups) : []),
    [open, data, query],
  );
  const groups = matchingGroups(query, matches);
  const rows = new Map(groups.flatMap((group) => group.rows.map((row) => [row.key, row] as const)));
  const isAvailable = (row: PaletteRow) => ("command" in row ? available.has(row.command) : !row.item.movedTo);
  const selectable = [...rows.values()].filter(isAvailable).map((row) => row.key);
  const active = selected === null ? (selectable[0] ?? null) : selectable.includes(selected) ? selected : null;
  const activeId = active ? rowId(active) : undefined;

  useShortcut("palette.open", () => {
    armed.current = null;
    setQuery("");
    setSelected(null);
    setOpen(true);
    return true;
  });

  useEffect(() => {
    if (open && activeId)
      listbox.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeId]);

  function changeOpen(value: boolean) {
    armed.current = null;
    setOpen(value);
  }

  function choose(key: RowKey) {
    const row = rows.get(key);
    if (!row || ("command" in row ? !runner.available().has(row.command) : row.item.movedTo)) return;
    pending.current =
      "command" in row ? { command: row.command } : { reviewId: row.item.id, rev: row.item.newestRevision };
    changeOpen(false);
  }

  return (
    <Primitive.Root open={open} onOpenChange={changeOpen}>
      <Primitive.Portal>
        <Primitive.Overlay className={overlayClass} />
        <Primitive.Content
          ref={setNode}
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (event.isComposing || event.keyCode === 229) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (isToastInteraction(event)) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            input.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
            // Focus-dependent handlers need the opener back; dialogs must start after this modal layer unmounts.
            const target = pending.current;
            pending.current = null;
            if (!target || hasOpenOverlay()) return;
            if ("command" in target) runner.run(target.command);
            else
              void navigate({
                to: "/r/$reviewId",
                params: { reviewId: target.reviewId },
                search: { rev: target.rev },
              });
          }}
          className="fixed top-[12vh] left-1/2 z-[calc(var(--z-sheet)+1)] flex max-h-[min(70dvh,calc(var(--visual-height,100dvh)_-_12vh_-_16px))] w-[min(560px,92%)] -translate-x-1/2 animate-[em-fade_var(--dur-2)_var(--ease-out)] flex-col overflow-hidden rounded-xl border border-line-1 bg-surface shadow-3"
        >
          <Primitive.Title className="sr-only">Command palette</Primitive.Title>
          <div className="flex shrink-0 items-center gap-3 border-b border-line-1 px-4 py-3">
            <input
              ref={input}
              type="text"
              placeholder="Find a review, pub or command…"
              aria-label="Search"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                armed.current = null;
                setQuery(event.target.value);
                setSelected(null);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key !== "Enter") armed.current = null;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  const index = active ? selectable.indexOf(active) : direction === 1 ? -1 : 0;
                  const next = selectable[(index + direction + selectable.length) % selectable.length];
                  if (next) setSelected(next);
                } else if (event.key === "Enter") {
                  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
                    armed.current = null;
                    return;
                  }
                  event.preventDefault();
                  if (!event.repeat) armed.current = active;
                }
              }}
              onKeyUp={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key !== "Enter") return;
                const key = armed.current;
                armed.current = null;
                if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
                event.preventDefault();
                if (key && key === active) choose(key);
              }}
              className="min-w-0 flex-1 border-0 bg-transparent font-sans text-14 text-fg-1 outline-none placeholder:text-fg-3"
            />
            <Kbd aria-hidden="true" className="[@media(pointer:coarse)]:hidden">
              Esc
            </Kbd>
            <Primitive.Close asChild>
              <IconButton
                label="Close"
                icon={X}
                size="lg"
                tooltip={false}
                className="hidden [@media(pointer:coarse)]:inline-grid"
              />
            </Primitive.Close>
          </div>
          <div ref={listbox} id={listId} role="listbox" aria-label="Results" className="min-h-0 overflow-y-auto p-1">
            {groups.map((group) => (
              // biome-ignore lint/a11y/useSemanticElements: Grouped listboxes use ARIA groups for options, not form fieldsets.
              <div
                key={group.label}
                role="group"
                aria-labelledby={`${id}-${group.label.replaceAll(" ", "-")}`}
                className="min-w-0 border-0"
              >
                <div
                  id={`${id}-${group.label.replaceAll(" ", "-")}`}
                  role="presentation"
                  className="px-2.5 pt-2 pb-1 text-12 font-medium leading-(--lh-snug) tracking-(--tracking-label) text-fg-3 uppercase"
                >
                  {group.label}
                </div>
                {group.rows.map((row) => (
                  <button
                    key={row.key}
                    id={rowId(row.key)}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={row.key === active}
                    aria-disabled={!isAvailable(row)}
                    onPointerMove={() => {
                      if (isAvailable(row) && row.key !== active) {
                        armed.current = null;
                        setSelected(row.key);
                      }
                    }}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => choose(row.key)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-[6px] border-0 px-2.5 text-left font-sans text-13 font-medium leading-(--lh-snug) font-[450] text-fg-1 aria-disabled:opacity-45",
                      "command" in row ? "h-8 [@media(pointer:coarse)]:h-11" : "min-h-11 py-1.5",
                      row.key === active ? "bg-hover" : "bg-transparent",
                      isAvailable(row) && "hover:bg-hover",
                    )}
                  >
                    {"command" in row ? (
                      <>
                        <span>{shortcutLabels[row.command]}</span>
                        {keys[row.command] !== null && (
                          <Kbd className="ml-auto shrink-0">{keyLabel(keys[row.command])}</Kbd>
                        )}
                      </>
                    ) : (
                      <span className="min-w-0 flex-1">
                        <span dir="auto" className="block truncate">
                          {row.item.title}
                        </span>
                        <span className="flex text-12 text-fg-3">
                          <span className="min-w-0 truncate">
                            {row.item.kind === "review" ? "Review" : "Pub"} ·{" "}
                            <bdi>{row.item.origin.name.replace(BIDI_CONTROL, "")}</bdi>
                            {row.item.project !== null && (
                              <>
                                {" · "}
                                <bdi>{row.item.project.replace(BIDI_CONTROL, "")}</bdi>
                              </>
                            )}
                            {row.item.movedTo ? (
                              <>
                                {" · Moved to "}
                                <bdi>{new URL(row.item.movedTo).host.replace(BIDI_CONTROL, "")}</bdi>
                              </>
                            ) : (
                              row.item.branch !== null && (
                                <>
                                  {" · "}
                                  <bdi className="font-mono">{row.item.branch.replace(BIDI_CONTROL, "")}</bdi>
                                </>
                              )
                            )}
                          </span>
                          {row.done && <span className="shrink-0 whitespace-pre"> · Done</span>}
                        </span>
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <p role="status" className="px-4 py-3 text-14 text-fg-2 empty:p-0">
            {groups.length === 0 ? "Nothing matches." : ""}
          </p>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
