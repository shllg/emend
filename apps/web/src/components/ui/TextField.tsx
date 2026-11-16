import type { ComponentProps } from "react";
import { FieldMessage, fieldClass, inputClass, inputSizes, labelClass, useField } from "./field.tsx";
import { Icon, type IconComponent } from "./Icon.tsx";
import { cn } from "./utils.ts";

export interface TextFieldProps extends Omit<ComponentProps<"input">, "size"> {
  label?: string;
  hint?: string;
  error?: string;
  icon?: IconComponent;
  size?: "sm" | "md" | "lg";
  mono?: boolean;
}

export function TextField({
  label,
  hint,
  error,
  icon,
  size = "md",
  mono = false,
  id,
  className,
  ...props
}: TextFieldProps) {
  const field = useField(id, hint, error, props["aria-describedby"]);
  return (
    <div className={cn(fieldClass, className)}>
      {label && (
        <label htmlFor={field.id} className={labelClass}>
          {label}
        </label>
      )}
      <div className="relative flex items-center">
        {icon && <Icon icon={icon} size={14} className="pointer-events-none absolute left-[9px] text-fg-3" />}
        <input
          {...props}
          id={field.id}
          aria-invalid={error ? true : props["aria-invalid"]}
          aria-describedby={field.describedBy}
          className={cn(
            inputClass,
            mono && "font-mono text-13 font-normal",
            inputSizes[size],
            mono ? "leading-[1.6]" : "leading-(--lh-body)",
            icon && "pl-[30px]",
          )}
        />
      </div>
      <FieldMessage id={field.messageId} hint={hint} error={error} />
    </div>
  );
}
