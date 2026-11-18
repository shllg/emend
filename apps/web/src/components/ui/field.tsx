import { CircleAlert } from "lucide-react";
import { useId } from "react";
import { Icon } from "./Icon.tsx";

export const fieldClass = "flex min-w-0 flex-col gap-1.5";
export const labelClass = "font-sans text-13 font-medium leading-(--lh-snug) text-fg-1";
export const inputClass =
  "box-border w-full rounded-md border border-line-2 bg-surface px-2.5 font-sans text-14 font-normal leading-(--lh-body) text-fg-1 shadow-inset transition-[border-color,box-shadow] duration-(--dur-1) ease-(--ease-out) placeholder:text-fg-3 enabled:hover:border-line-strong focus:border-line-focus focus:outline-none focus:shadow-[0_0_0_3px_var(--accent-tint-2)] disabled:cursor-not-allowed disabled:bg-sunken disabled:text-fg-disabled aria-invalid:border-danger-solid aria-invalid:focus:shadow-[0_0_0_3px_var(--danger-bg)]";
export const inputSizes = { sm: "h-7 rounded-sm text-13", md: "h-8", lg: "h-10 text-15" };

export function useField(id?: string, hint?: string, error?: string, describedBy?: string) {
  const generated = useId();
  const fieldId = id ?? generated;
  const messageId = `${fieldId}-description`;
  return {
    id: fieldId,
    messageId,
    describedBy: [describedBy, (hint || error) && messageId].filter(Boolean).join(" ") || undefined,
  };
}

export function FieldMessage({ id, hint, error }: { id: string; hint?: string; error?: string }) {
  if (error)
    return (
      <span
        id={id}
        role="alert"
        className="flex items-center gap-1.25 font-sans text-12 font-normal leading-(--lh-snug) text-danger-fg"
      >
        <Icon icon={CircleAlert} size={13} />
        {error}
      </span>
    );
  if (hint)
    return (
      <span id={id} className="font-sans text-12 font-normal leading-(--lh-snug) text-fg-3">
        {hint}
      </span>
    );
  return null;
}
