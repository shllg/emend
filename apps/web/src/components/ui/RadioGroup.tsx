import { useId } from "react";
import { labelClass } from "./field.tsx";
import { cn } from "./utils.ts";

export interface RadioOption {
  value: string;
  label: string;
  description?: string;
}
export interface RadioGroupProps {
  label: string;
  options: RadioOption[];
  value: string;
  onChange?: (value: string) => void;
  name?: string;
  variant?: "plain" | "cards";
  className?: string;
}

export function RadioGroup({ label, options, value, onChange, name, variant = "cards", className }: RadioGroupProps) {
  const id = useId();
  return (
    <fieldset className={cn("m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0", className)}>
      <legend className={cn(labelClass, "mb-2 p-0")}>{label}</legend>
      {options.map((option, index) => (
        <label
          key={option.value}
          className={cn(
            "relative flex cursor-pointer items-start gap-2.5 rounded-md border border-line-1 bg-surface px-3 py-2.5 transition-[border-color,background] duration-(--dur-1) hover:border-line-2 has-checked:border-(--ochre-500) has-checked:bg-accent-tint has-focus-visible:shadow-(--focus-ring)",
            variant === "plain" &&
              "border-transparent bg-transparent px-1 py-1.5 hover:border-transparent has-checked:border-transparent has-checked:bg-transparent",
          )}
        >
          <input
            type="radio"
            className="peer sr-only"
            name={name ?? id}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange?.(option.value)}
            aria-describedby={option.description ? `${id}-${index}-description` : undefined}
          />
          <span
            aria-hidden="true"
            className="mt-[0.125rem] grid size-[1rem] shrink-0 place-items-center rounded-full border-[1.5px] border-line-strong bg-surface peer-checked:border-fg-1 peer-checked:after:size-[0.5rem] peer-checked:after:rounded-full peer-checked:after:bg-fg-1 peer-checked:after:content-['']"
          />
          <span className="flex flex-col gap-0.5 font-sans text-13 font-medium leading-(--lh-snug) text-fg-1">
            {option.label}
            {option.description && (
              <span
                id={`${id}-${index}-description`}
                className="font-sans text-12 font-normal leading-(--lh-snug) text-fg-3"
              >
                {option.description}
              </span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
