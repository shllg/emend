import { Check } from "lucide-react";
import { type ComponentProps, type ReactNode, useId } from "react";
import { Icon } from "./Icon.tsx";
import { cn } from "./utils.ts";

export interface CheckboxProps extends Omit<ComponentProps<"input">, "type"> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, className, id, ...props }: CheckboxProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hasDescription = description != null && typeof description !== "boolean" && description !== "";
  return (
    <label
      htmlFor={fieldId}
      className={cn(
        "group relative flex cursor-pointer items-start gap-2 font-sans text-14 font-normal leading-(--lh-body) text-fg-1 has-disabled:cursor-not-allowed",
        className,
      )}
    >
      <input
        {...props}
        id={fieldId}
        type="checkbox"
        className="peer sr-only"
        aria-describedby={
          [props["aria-describedby"], hasDescription && `${fieldId}-description`].filter(Boolean).join(" ") || undefined
        }
      />
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border-[1.5px] border-line-strong bg-surface text-transparent transition-[background,border-color] duration-(--dur-1) group-hover:border-fg-2 peer-checked:border-fg-1 peer-checked:bg-fg-1 peer-checked:text-surface peer-focus-visible:shadow-(--focus-ring) peer-disabled:opacity-50"
      >
        <Icon icon={Check} size={12} strokeWidth={3} />
      </span>
      <span>
        {label}
        {hasDescription && (
          <span
            id={`${fieldId}-description`}
            className="mt-px block font-sans text-12 font-normal leading-(--lh-snug) text-fg-3"
          >
            {description}
          </span>
        )}
      </span>
    </label>
  );
}
