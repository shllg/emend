import * as Primitive from "@radix-ui/react-dialog";
import { type ComponentProps, type ReactNode, type RefObject, useRef } from "react";
import { isToastInteraction, overlayClass } from "./overlay.ts";
import { cn } from "./utils.ts";

export interface DialogProps {
  title: ReactNode;
  titleClassName?: string;
  description: ReactNode;
  /** Mark the least destructive action (usually Cancel) with data-autofocus. */
  actions: ReactNode;
  children?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInteractOutside?: ComponentProps<typeof Primitive.Content>["onInteractOutside"];
  /** Gets focus back when the element focused at opening is gone, as a menu item is. */
  returnFocus?: RefObject<HTMLElement | null>;
  /** Return focus to `returnFocus` even when the element focused at opening is still there (it may be disabled). */
  preferReturnFocus?: boolean;
}

export function Dialog({
  title,
  titleClassName,
  description,
  actions,
  children,
  open,
  onOpenChange,
  onInteractOutside,
  returnFocus,
  preferReturnFocus = false,
}: DialogProps) {
  const content = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className={overlayClass} />
        <Primitive.Content
          ref={content}
          role="alertdialog"
          onInteractOutside={(event) => {
            if (isToastInteraction(event)) event.preventDefault();
            else onInteractOutside?.(event);
          }}
          onOpenAutoFocus={(event) => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const initial = content.current?.querySelector<HTMLElement>("[data-autofocus]");
            if (initial) {
              event.preventDefault();
              initial.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            const preferred = preferReturnFocus && returnFocus?.current?.isConnected ? returnFocus.current : null;
            const target = preferred ?? (opener.current?.isConnected ? opener.current : returnFocus?.current);
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
          className="fixed top-1/2 left-1/2 z-[calc(var(--z-sheet)+1)] flex max-h-[85dvh] w-[min(440px,92%)] -translate-x-1/2 -translate-y-1/2 animate-[em-fade_var(--dur-2)_var(--ease-out)] flex-col overflow-y-auto rounded-xl border border-line-1 bg-surface shadow-3"
        >
          <div className="px-5 pt-5 pb-1">
            <Primitive.Title
              className={cn("m-0 mb-1.5 font-sans text-18 font-semibold leading-(--lh-snug) text-fg-1", titleClassName)}
            >
              {title}
            </Primitive.Title>
            <Primitive.Description className="m-0 font-sans text-14 font-normal leading-(--lh-body) text-pretty text-fg-2">
              {description}
            </Primitive.Description>
            {children}
          </div>
          <div className="flex justify-end gap-2 px-5 pt-4 pb-5">{actions}</div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
