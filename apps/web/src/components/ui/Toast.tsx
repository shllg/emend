import { Check, CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import { cn } from "./utils.ts";

export interface ToastMessage {
  title: string;
  description?: string;
  tone?: "neutral" | "success" | "info" | "danger";
}
export interface ToastProps extends ToastMessage {
  onClose: () => void;
}
const icons = { neutral: Check, success: CircleCheck, info: Info, danger: CircleAlert };
const colors = {
  neutral: "text-(--ochre-400)",
  success: "text-(--green-400)",
  info: "text-(--blue-400)",
  danger: "text-(--red-400)",
};

export function Toast({ title, description, tone = "neutral", onClose }: ToastProps) {
  return (
    <div className="flex min-w-[min(260px,100%)] max-w-[380px] animate-[em-sheet-up_var(--dur-3)_var(--ease-out)] items-start gap-2.5 rounded-lg bg-inverse py-2.5 pr-2 pl-3 font-sans text-13 font-medium leading-(--lh-snug) text-fg-inverse shadow-3">
      <Icon icon={icons[tone]} className={cn("mt-px", colors[tone])} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-px wrap-break-word">
        <span>{title}</span>
        {description && (
          <span className="font-sans text-12 font-normal leading-(--lh-snug) opacity-75">{description}</span>
        )}
      </div>
      <IconButton
        label="Dismiss"
        icon={X}
        size="sm"
        onClick={onClose}
        className="size-6 text-inherit opacity-70 [@media(pointer:coarse)]:size-10"
      />
    </div>
  );
}

const ToastContext = createContext<{ show: (message: ToastMessage) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const show = useCallback((message: ToastMessage) => setToast({ ...message }), []);
  const close = useCallback(() => setToast(null), []);
  const context = useMemo(() => ({ show }), [show]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(close, 3200);
    return () => window.clearTimeout(timer);
  }, [toast, close]);
  return (
    <ToastContext.Provider value={context}>
      {children}
      {createPortal(
        <div
          data-recense-toast
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="pointer-events-auto fixed inset-x-4 bottom-[calc(var(--sendbar-h)+var(--tabbar-h)+var(--space-4)+env(safe-area-inset-bottom))] z-(--z-toast) flex justify-center md:bottom-[calc(var(--sendbar-h)+var(--space-4)+env(safe-area-inset-bottom))]"
        >
          {toast && <Toast {...toast} onClose={close} />}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast requires a ToastProvider");
  return context;
}
