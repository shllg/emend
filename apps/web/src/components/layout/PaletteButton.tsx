import { Search } from "lucide-react";
import { type ComponentProps, useId } from "react";
import { ariaKeyShortcuts, keyCaps, keyLabel } from "../../lib/shortcuts.ts";
import { useRunShortcut, useShortcutKeys } from "../../lib/use-shortcut.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import { cn, focusRing } from "../ui/utils.ts";

/** Opens the command palette from the top bar and shows its current shortcut. */
export function PaletteButton({ variant, className }: { variant: "field" | "icon"; className?: string }) {
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
      {variant === "field" ? (
        <button
          {...buttonProps}
          className={cn(
            "flex h-8 w-72 items-center gap-2 rounded-md border border-line-1 bg-sunken pr-1 pl-2.5 font-sans text-13 text-fg-3 transition-[color,border-color] duration-(--dur-1) ease-(--ease-out) hover:border-line-2 hover:text-fg-2 [-webkit-tap-highlight-color:transparent]",
            focusRing,
            className,
          )}
        >
          <Icon icon={Search} size={14} />
          <span className="min-w-0 flex-1 truncate text-left">Search commands</span>
          {key !== null && (
            <span aria-hidden="true" className="flex shrink-0 items-center gap-0.5">
              {keyCaps(key).map((cap) => (
                <Kbd key={cap}>{cap}</Kbd>
              ))}
            </span>
          )}
        </button>
      ) : (
        <Tooltip content="Search commands" kbd={key === null ? undefined : keyLabel(key)}>
          <IconButton
            {...buttonProps}
            label="Search commands"
            icon={Search}
            tooltip={false}
            className={cn(className)}
          />
        </Tooltip>
      )}
      <span id={descriptionId} hidden>
        {key === null ? "Opens the command palette." : `Opens the command palette. Shortcut: ${keyLabel(key)}.`}
      </span>
    </>
  );
}
