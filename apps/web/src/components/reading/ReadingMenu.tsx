import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useLayout } from "../../lib/layout.ts";
import { Button } from "../ui/Button.tsx";
import { Icon, type IconComponent } from "../ui/Icon.tsx";
import { Sheet } from "../ui/Sheet.tsx";

/** Run a pick after the overlay releases focus, so the destination keeps it. */
export function ReadingMenu({
  label,
  icon,
  children,
}: {
  label: string;
  icon: IconComponent;
  children: (pick: (action: () => void) => void) => ReactNode;
}) {
  const phone = useLayout() === "phone";
  const [open, setOpen] = useState(false);
  const picked = useRef<(() => void) | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pick = (action: () => void) => {
    picked.current = action;
    setOpen(false);
  };
  const closed = () => {
    const action = picked.current;
    picked.current = null;
    action?.();
  };
  const trigger = (
    <Button
      ref={button}
      variant="ghost"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={phone ? () => setOpen(true) : undefined}
      className="em-doc-control"
    >
      <Icon icon={icon} />
      <span className="em-doc-control-label">{label}</span>
    </Button>
  );
  if (phone)
    return (
      <>
        {trigger}
        <Sheet
          side="bottom"
          title={label}
          open={open}
          onOpenChange={setOpen}
          returnFocus={() => button.current}
          onClosed={closed}
        >
          {children(pick)}
        </Sheet>
      </>
    );
  return (
    <Dialog.Root modal={false} open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Content
        aria-describedby={undefined}
        className="em-reading-popover"
        onCloseAutoFocus={(event) => {
          if (picked.current) event.preventDefault();
          closed();
        }}
      >
        <header className="flex items-center justify-between gap-3">
          <Dialog.Title>{label}</Dialog.Title>
          <Dialog.Close asChild>
            <Button variant="ghost" aria-label="Close">
              <Icon icon={X} />
            </Button>
          </Dialog.Close>
        </header>
        {children(pick)}
      </Dialog.Content>
    </Dialog.Root>
  );
}
