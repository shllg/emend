import type { ShortcutCommand } from "@emend/contract";
import * as Primitive from "@radix-ui/react-dialog";
import { useEffect, useId, useRef, useState } from "react";
import { fuzzyMatch } from "../lib/fuzzy-match.ts";
import { hasOpenOverlay, keyLabel, shortcutGroups, shortcutLabels } from "../lib/shortcuts.ts";
import { useShortcut, useShortcutKeys, useShortcutRunner } from "../lib/use-shortcut.tsx";
import { Kbd } from "./ui/Kbd.tsx";
import { isToastInteraction, overlayClass } from "./ui/overlay.ts";
import { cn } from "./ui/utils.ts";

function matchingGroups(query: string) {
  return shortcutGroups
    .map((group) => {
      const rows = group.commands
        .filter((command) => command !== "palette.open")
        .flatMap((command) => {
          const score = fuzzyMatch(query, shortcutLabels[command]);
          return score === null ? [] : [{ command, score }];
        })
        .sort((a, b) => b.score - a.score);
      return { label: group.label, rows, score: rows[0]?.score ?? 0 };
    })
    .filter((group) => group.rows.length > 0)
    .sort((a, b) => b.score - a.score);
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ShortcutCommand | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const pending = useRef<ShortcutCommand | null>(null);
  const armed = useRef<ShortcutCommand | null>(null);
  const id = useId();
  const listId = `${id}-commands`;
  const rowId = (command: ShortcutCommand) => `${id}-${command}`;
  const keys = useShortcutKeys();
  const runner = useShortcutRunner();
  const available = runner.available();
  const groups = matchingGroups(query);
  const selectable: ShortcutCommand[] = groups
    .flatMap((group) => group.rows.map((row) => row.command))
    .filter((command) => available.has(command));
  const active = selected !== null && selectable.includes(selected) ? selected : null;
  const activeId = active ? rowId(active) : undefined;

  function firstAvailable(value: string) {
    const commands = runner.available();
    return (
      matchingGroups(value)
        .flatMap((group) => group.rows.map((row) => row.command))
        .find((command) => commands.has(command)) ?? null
    );
  }

  useShortcut("palette.open", () => {
    armed.current = null;
    setQuery("");
    setSelected(firstAvailable(""));
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

  function choose(command: ShortcutCommand) {
    if (!runner.available().has(command)) return;
    pending.current = command;
    changeOpen(false);
  }

  return (
    <Primitive.Root open={open} onOpenChange={changeOpen}>
      <Primitive.Portal>
        <Primitive.Overlay className={overlayClass} />
        <Primitive.Content
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
            const command = pending.current;
            pending.current = null;
            if (command && !hasOpenOverlay()) runner.run(command);
          }}
          className="fixed top-[12vh] left-1/2 z-[calc(var(--z-sheet)+1)] flex max-h-[70dvh] w-[min(560px,92%)] -translate-x-1/2 animate-[em-fade_var(--dur-2)_var(--ease-out)] flex-col overflow-hidden rounded-xl border border-line-1 bg-surface shadow-3"
        >
          <Primitive.Title className="sr-only">Command palette</Primitive.Title>
          <div className="flex shrink-0 items-center gap-3 border-b border-line-1 px-4 py-3">
            <input
              ref={input}
              type="text"
              placeholder="Type a command…"
              aria-label="Command"
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
                setSelected(firstAvailable(event.target.value));
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
                const command = armed.current;
                armed.current = null;
                if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
                event.preventDefault();
                if (command && command === active) choose(command);
              }}
              className="min-w-0 flex-1 border-0 bg-transparent font-sans text-14 text-fg-1 outline-none placeholder:text-fg-3"
            />
            <Kbd aria-hidden="true">Esc</Kbd>
          </div>
          <div ref={listbox} id={listId} role="listbox" aria-label="Commands" className="min-h-0 overflow-y-auto p-1">
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
                  className="px-2.5 pt-2 pb-1 font-mono text-11 font-medium leading-(--lh-snug) font-stretch-mono tracking-(--tracking-label) text-fg-3 uppercase"
                >
                  {group.label}
                </div>
                {group.rows.map(({ command }) => (
                  <button
                    key={command}
                    id={rowId(command)}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={command === active}
                    aria-disabled={!available.has(command)}
                    onPointerMove={() => {
                      if (available.has(command) && command !== selected) {
                        armed.current = null;
                        setSelected(command);
                      }
                    }}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => choose(command)}
                    className={cn(
                      "flex h-8 w-full items-center gap-2.5 rounded-[6px] border-0 px-2.5 text-left font-sans text-13 font-medium leading-(--lh-snug) font-[450] text-fg-1 aria-disabled:opacity-45 [@media(pointer:coarse)]:h-11",
                      command === active ? "bg-hover" : "bg-transparent",
                      available.has(command) && "hover:bg-hover",
                    )}
                  >
                    <span>{shortcutLabels[command]}</span>
                    {keys[command] !== null && <Kbd className="ml-auto shrink-0">{keyLabel(keys[command])}</Kbd>}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <p role="status" className="px-4 py-3 text-14 text-fg-2 empty:p-0">
            {groups.length === 0 ? "No command matches." : ""}
          </p>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
