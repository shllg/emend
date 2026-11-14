import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { type ComponentProps, type ReactNode, type RefObject, useCallback, useRef, useState } from "react";
import { useVisualViewportInset } from "../../lib/visual-viewport.ts";
import { IconButton } from "./IconButton.tsx";
import { isToastInteraction, overlayClass } from "./overlay.ts";
import { cn } from "./utils.ts";
import "./Sheet.css";

export interface SheetProps {
  side?: "right" | "left" | "bottom";
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onInteractOutside?: ComponentProps<typeof Dialog.Content>["onInteractOutside"];
  initialFocus?: RefObject<HTMLElement | null>;
  returnFocus?: () => HTMLElement | null;
  /** A supplied container mounts content in the same commit as its navigation intent. */
  portalContainer?: HTMLElement;
  /** Called once the sheet has closed and unmounted, after focus went back. */
  onClosed?: () => void;
}

const sides = {
  right:
    "inset-y-0 right-0 w-[min(400px,92%)] rounded-l-xl border-l border-line-1 animate-[em-sheet-right_var(--dur-3)_var(--ease-out)]",
  left: "inset-y-0 left-0 w-[min(340px,92%)] rounded-r-xl border-r border-line-1 animate-[em-sheet-left_var(--dur-3)_var(--ease-out)]",
  bottom:
    "inset-x-0 bottom-[var(--keyboard-inset,0px)] max-h-[calc(var(--visual-height,100dvh)*0.85)] rounded-t-xl pb-[var(--sheet-safe-bottom,env(safe-area-inset-bottom))] animate-[em-sheet-up_var(--dur-3)_var(--ease-out)]",
};

export function Sheet({
  side = "right",
  title,
  description,
  footer,
  trigger,
  children,
  open,
  onOpenChange,
  onInteractOutside,
  initialFocus,
  returnFocus,
  portalContainer,
  onClosed,
}: SheetProps) {
  const content = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const attach = useCallback((el: HTMLDivElement | null) => {
    content.current = el;
    setNode(el);
  }, []);
  useVisualViewportInset(side === "bottom" ? node : null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal container={portalContainer}>
        <Dialog.Overlay className={overlayClass} />
        <Dialog.Content
          ref={attach}
          onEscapeKeyDown={(event) => {
            // A dismissible inline editor handles Escape before its containing sheet closes.
            if (event.target instanceof Element && event.target.closest("[data-inline-composer-dismiss]"))
              event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (isToastInteraction(event)) event.preventDefault();
            else onInteractOutside?.(event);
          }}
          onOpenAutoFocus={(event) => {
            opener.current =
              !trigger && open !== undefined && document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
            event.preventDefault();
            (initialFocus?.current ?? content.current)?.focus();
          }}
          onCloseAutoFocus={(event) => {
            const target = returnFocus?.() ?? opener.current;
            if (!trigger && target?.isConnected) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
            onClosed?.();
          }}
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn("fixed z-[calc(var(--z-sheet)+1)] flex flex-col bg-surface text-fg-1 shadow-3", sides[side])}
        >
          {side === "bottom" && (
            <div data-sheet-grab aria-hidden="true" className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-[2px] bg-line-2" />
          )}
          <header className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-line-1 py-1.5 pr-2 pl-4">
            <Dialog.Title className="m-0 flex-1 font-sans text-15 font-semibold leading-(--lh-snug) text-fg-1">
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close" icon={X} size={side === "bottom" ? "lg" : "md"} tooltip={false} />
            </Dialog.Close>
          </header>
          <div className="relative min-h-0 flex-1 space-y-4 overflow-auto p-4">
            {description && (
              <Dialog.Description className="m-0 font-sans text-14 font-normal leading-(--lh-body) text-fg-2">
                {description}
              </Dialog.Description>
            )}
            {children}
          </div>
          {footer && (
            <footer className="flex shrink-0 justify-end gap-2 border-t border-line-1 px-4 py-3">{footer}</footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
