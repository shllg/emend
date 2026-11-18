import { Search } from "lucide-react";
import { type ComponentProps, useId } from "react";
import { useMedia } from "../../lib/layout.ts";
import { ariaKeyShortcuts, keyCaps, keyLabel } from "../../lib/shortcuts.ts";
import { useRunShortcut, useShortcutKeys } from "../../lib/use-shortcut.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import { cn, focusRing } from "../ui/utils.ts";

/**
 * A search-style field on wide bars and an icon below 1024px, kept as one button
 * so the palette can return focus to it after a resize.
 */
export function PaletteButton() {
  const wide = useMedia("(min-width: 1024px)");
  const key = useShortcutKeys()["palette.open"];
  const runShortcut = useRunShortcut();
  const descriptionId = useId();
  const buttonProps: ComponentProps<"button"> = {
    type: "button",
    "aria-haspopup": "dialog",
    "aria-keyshortcuts": key === null ? undefined : ariaKeyShortcuts(key),
    "aria-describedby": descriptionId,
    onClick: (event) => {
      // Safari does not focus buttons on click; the palette restores this focus.
      event.currentTarget.focus();
      runShortcut("palette.open");
    },
  };
  return (
    <>
      <Tooltip content="Search reviews and commands" kbd={key === null ? undefined : keyLabel(key)}>
        <button
          {...buttonProps}
          aria-label="Search reviews and commands"
          className={cn(
            wide
              ? "absolute top-1/2 left-1/2 flex h-8 w-[18rem] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-md border border-line-1 bg-sunken pr-1 pl-2.5 font-sans text-13 text-fg-3 transition-[color,border-color] duration-(--dur-1) ease-(--ease-out) hover:border-line-2 hover:text-fg-2 [-webkit-tap-highlight-color:transparent]"
              : "ml-auto inline-grid size-8 shrink-0 place-items-center rounded-md border border-transparent bg-transparent text-fg-2 transition-[background,color] duration-(--dur-1) ease-(--ease-out) hover:bg-hover hover:text-fg-1 active:bg-active active:text-fg-1 [-webkit-tap-highlight-color:transparent]",
            focusRing,
          )}
        >
          <Icon icon={Search} size={wide ? 14 : 16} />
          {wide && (
            <>
              <span className="min-w-0 flex-1 truncate text-left">Search reviews and commands</span>
              {key !== null && (
                <span aria-hidden="true" className="flex shrink-0 items-center gap-0.5">
                  {keyCaps(key).map((cap) => (
                    <Kbd key={cap}>{cap}</Kbd>
                  ))}
                </span>
              )}
            </>
          )}
        </button>
      </Tooltip>
      <span id={descriptionId} hidden>
        {key === null ? "Opens the command palette." : `Opens the command palette. Shortcut: ${keyLabel(key)}.`}
      </span>
    </>
  );
}
