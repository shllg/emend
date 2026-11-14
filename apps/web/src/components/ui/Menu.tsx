import * as Primitive from "@radix-ui/react-dropdown-menu";
import { Slottable } from "@radix-ui/react-slot";
import { Check, Ellipsis } from "lucide-react";
import { type ReactElement, type ReactNode, type Ref, useRef } from "react";
import { Icon, type IconComponent } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import { Kbd } from "./Kbd.tsx";
import { cn, focusRing, selectionIndex } from "./utils.ts";

export type MenuItem =
  | { separator: true }
  | { heading: string }
  | {
      radioGroup: {
        segmented?: boolean;
        label?: string;
        value: string;
        onValueChange: (value: string) => void;
        items: { value: string; label: ReactNode; hint?: string; disabled?: boolean }[];
      };
    }
  | {
      label: string;
      /** A long label loses its start instead of its end, so a path keeps its file name. */
      truncateStart?: boolean;
      title?: string;
      icon?: IconComponent;
      hint?: string;
      kbd?: string;
      onSelect?: () => void;
      /** The item can open a dialog: `onSelect` then runs after the menu has closed and unmounted. */
      opensDialog?: boolean;
      disabled?: boolean;
      danger?: boolean;
      /** Supply a Link as children when asChild is true. */
      asChild?: boolean;
      children?: ReactElement;
    };
export interface MenuProps {
  label: string;
  trigger?: ReactElement;
  align?: "left" | "right";
  size?: "sm" | "md" | "lg";
  items: MenuItem[];
  defaultOpen?: boolean;
  /** Receives the trigger element, so a dialog an item opens can return focus to it. */
  triggerRef?: Ref<HTMLButtonElement>;
}

/**
 * An item with `opensDialog` runs its `onSelect` after the menu has closed and unmounted. A dialog
 * opened while the menu closes would start under the menu's modal layer: Radix saves the menu's
 * `pointer-events: none` as the page's own and restores it when the dialog closes, which leaves the
 * page unclickable. Focus is back on the trigger by then, so the dialog records it as the element
 * to return to. Other items run `onSelect` at once, inside the user's gesture (clipboard, reload).
 */
export function Menu({ label, trigger, align = "right", size = "md", items, defaultOpen, triggerRef }: MenuProps) {
  const selected = useRef<(() => void) | null>(null);
  return (
    <Primitive.Root defaultOpen={defaultOpen}>
      <Primitive.Trigger asChild aria-label={label} ref={triggerRef}>
        {trigger ?? <IconButton label={label} icon={Ellipsis} size={size} />}
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          onCloseAutoFocus={() => {
            const run = selected.current;
            selected.current = null;
            run?.();
          }}
          align={align === "left" ? "start" : "end"}
          sideOffset={4}
          collisionPadding={8}
          className={cn(
            "relative z-[calc(var(--z-sheet)+2)] max-h-(--radix-dropdown-menu-content-available-height) min-w-52 max-w-[min(36rem,var(--radix-dropdown-menu-content-available-width))] animate-[em-fade_var(--dur-1)_var(--ease-out)] overflow-y-auto rounded-lg border border-line-1 bg-raised p-1 shadow-3",
            items.some((item) => "radioGroup" in item) && "min-w-60",
          )}
        >
          {items.map((item, index) => {
            if ("radioGroup" in item)
              return (
                <Primitive.RadioGroup
                  // biome-ignore lint/suspicious/noArrayIndexKey: Menu descriptions have no ids and may repeat labels.
                  key={index}
                  value={item.radioGroup.value}
                  onValueChange={item.radioGroup.onValueChange}
                  aria-label={item.radioGroup.label}
                  className={
                    item.radioGroup.segmented
                      ? "mx-2 mb-2 flex gap-0.5 rounded-md border border-line-1 bg-sunken p-0.5"
                      : undefined
                  }
                  onKeyDownCapture={(event) => {
                    if (!item.radioGroup.segmented) return;
                    const options = item.radioGroup.items.filter((option) => !option.disabled);
                    const buttons = [
                      ...event.currentTarget.querySelectorAll<HTMLElement>(
                        '[role="menuitemradio"]:not([data-disabled])',
                      ),
                    ];
                    const focused = document.activeElement;
                    const index = focused instanceof HTMLElement ? buttons.indexOf(focused) : -1;
                    const next = selectionIndex(event.key, index, options.length);
                    if (next === undefined) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const option = options[next];
                    if (!option) return;
                    item.radioGroup.onValueChange(option.value);
                    buttons[next]?.focus();
                  }}
                >
                  {item.radioGroup.items.map((option) => (
                    <Primitive.RadioItem
                      key={option.value}
                      value={option.value}
                      disabled={option.disabled}
                      onSelect={item.radioGroup.segmented ? (event) => event.preventDefault() : undefined}
                      className={cn(
                        "flex min-h-8 items-start gap-2.5 rounded-[6px] px-2.5 py-2 font-sans text-13 font-medium leading-(--lh-snug) text-fg-1 data-highlighted:bg-hover data-disabled:pointer-events-none data-disabled:opacity-45 [@media(pointer:coarse)]:min-h-11",
                        focusRing,
                        item.radioGroup.segmented &&
                          "min-h-7 flex-1 justify-center px-2 py-1 text-fg-3 data-[state=checked]:bg-raised data-[state=checked]:text-fg-1 data-[state=checked]:shadow-1",
                      )}
                    >
                      {!item.radioGroup.segmented && (
                        <span aria-hidden="true" className="mt-0.5 size-3.5 shrink-0">
                          <Primitive.ItemIndicator>
                            <Icon icon={Check} size={14} />
                          </Primitive.ItemIndicator>
                        </span>
                      )}
                      <span
                        className={cn(
                          "flex min-w-0 flex-1 flex-col gap-0.5",
                          item.radioGroup.segmented && "items-center",
                        )}
                      >
                        <span className="flex items-center gap-1.5">{option.label}</span>
                        {option.hint && <span className="text-fg-3 [font:var(--type-meta)]">{option.hint}</span>}
                      </span>
                    </Primitive.RadioItem>
                  ))}
                </Primitive.RadioGroup>
              );
            if ("separator" in item)
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: Menu descriptions have no ids and may repeat labels.
                <Primitive.Separator key={index} className="-mx-1 my-1 h-px bg-line-1" />
              );
            if ("heading" in item)
              return (
                <Primitive.Label
                  // biome-ignore lint/suspicious/noArrayIndexKey: Menu descriptions have no ids and may repeat labels.
                  key={index}
                  className="px-2.5 pt-2 pb-1 font-mono text-11 font-medium leading-(--lh-snug) font-stretch-mono tracking-(--tracking-label) text-fg-3 uppercase"
                >
                  {item.heading}
                </Primitive.Label>
              );
            return (
              <Primitive.Item
                // biome-ignore lint/suspicious/noArrayIndexKey: Menu descriptions have no ids and may repeat labels.
                key={index}
                asChild={item.asChild}
                disabled={item.disabled}
                onSelect={
                  item.opensDialog
                    ? () => {
                        selected.current = item.onSelect ?? null;
                      }
                    : item.onSelect
                }
                title={item.title}
                className={cn(
                  "flex h-8 w-full items-center gap-2.5 rounded-[6px] border-0 bg-transparent px-2.5 text-left font-sans text-13 font-medium leading-(--lh-snug) font-[450] text-fg-1 no-underline hover:text-fg-1 data-highlighted:bg-hover data-disabled:pointer-events-none data-disabled:opacity-45 [@media(pointer:coarse)]:h-11 [&>svg]:text-fg-3",
                  focusRing,
                  size === "lg" && "h-11",
                  item.danger && "text-danger-fg hover:text-danger-fg [&>svg]:text-danger-fg",
                )}
              >
                {item.icon && <Icon icon={item.icon} />}
                <Slottable>
                  {item.asChild ? (
                    item.children
                  ) : (
                    <span className={cn("min-w-0 truncate", item.truncateStart && "text-left [direction:rtl]")}>
                      {item.truncateStart ? <bdi className="[unicode-bidi:plaintext]">{item.label}</bdi> : item.label}
                    </span>
                  )}
                </Slottable>
                {item.hint && (
                  <span className="ml-auto shrink-0 font-sans text-12 font-normal leading-(--lh-snug) text-fg-3">
                    {item.hint}
                  </span>
                )}
                {item.kbd && <Kbd className="ml-auto shrink-0">{item.kbd}</Kbd>}
              </Primitive.Item>
            );
          })}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
