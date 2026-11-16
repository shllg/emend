import { type ComponentProps, useCallback, useEffect, useRef, useState } from "react";
import { FieldMessage, fieldClass, inputClass, labelClass, useField } from "./field.tsx";
import { cn } from "./utils.ts";

export interface TextareaProps extends ComponentProps<"textarea"> {
  label?: string;
  hint?: string;
  error?: string;
  /** Soft limit, as in the design: retain the draft and mark excess characters. */
  maxLength?: number;
}

export function Textarea({
  label,
  hint,
  error,
  maxLength,
  value,
  defaultValue,
  onChange,
  rows = 3,
  id,
  className,
  ref,
  ...props
}: TextareaProps) {
  const [length, setLength] = useState(String(defaultValue ?? "").length);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const attach = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textarea.current = node;
      if (typeof ref === "function") return ref(node);
      if (ref) ref.current = node;
    },
    [ref],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing the form prop changes node.form and must rebind the reset listener.
  useEffect(() => {
    const node = textarea.current;
    const form = node?.form;
    if (value != null || !node || !form) return;
    let timer: number | undefined;
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setLength(node.value.length), 0);
    };
    form.addEventListener("reset", reset);
    return () => {
      form.removeEventListener("reset", reset);
      window.clearTimeout(timer);
    };
  }, [value, props.form]);
  const count = value == null ? length : String(value).length;
  const over = maxLength != null && count > maxLength;
  const near = maxLength != null && count >= maxLength * 0.9;
  const field = useField(id, hint, error, props["aria-describedby"]);
  const countId = `${field.id}-count`;
  return (
    <div className={cn(fieldClass, className)}>
      {(label || maxLength != null) && (
        <div className="flex items-baseline justify-between gap-2">
          {label && (
            <label htmlFor={field.id} className={labelClass}>
              {label}
            </label>
          )}
          {maxLength != null && (
            <span
              id={countId}
              aria-live={near ? "polite" : "off"}
              aria-atomic="true"
              className={cn("font-mono text-12 font-medium leading-(--lh-snug) text-fg-3", over && "text-danger-fg")}
            >
              {count} / {maxLength}
            </span>
          )}
        </div>
      )}
      <textarea
        {...props}
        ref={attach}
        id={field.id}
        rows={rows}
        value={value}
        defaultValue={defaultValue}
        onChange={(event) => {
          setLength(event.target.value.length);
          onChange?.(event);
        }}
        aria-invalid={error || over ? true : props["aria-invalid"]}
        aria-describedby={[field.describedBy, maxLength != null && countId].filter(Boolean).join(" ") || undefined}
        className={cn(inputClass, "h-auto min-h-[76px] resize-y py-2 font-sans leading-[1.5]")}
      />
      <FieldMessage id={field.messageId} hint={hint} error={error} />
    </div>
  );
}
