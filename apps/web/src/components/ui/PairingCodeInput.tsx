import { type ComponentProps, useLayoutEffect, useRef, useState } from "react";
import { FieldMessage, fieldClass, labelClass, useField } from "./field.tsx";
import { cn } from "./utils.ts";

export interface PairingCodeInputProps
  extends Omit<
    ComponentProps<"input">,
    "value" | "defaultValue" | "onChange" | "size" | "type" | "maxLength" | "pattern"
  > {
  value?: string;
  defaultValue?: string;
  onChange?: (formatted: string) => void;
  error?: string;
  label?: string;
}

function format(value: string) {
  const code = value
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, "")
    .slice(0, 8);
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function PairingCodeInput({
  value,
  defaultValue = "",
  onChange,
  error,
  label = "Pairing code",
  id,
  className,
  onPaste,
  ...props
}: PairingCodeInputProps) {
  const [local, setLocal] = useState(() => format(defaultValue));
  const displayed = value === undefined ? local : format(value);
  const pendingCaret = useRef<{ input: HTMLInputElement; value: string; caret: number } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    pendingCaret.current = null;
    if (pending?.value === displayed) pending.input.setSelectionRange(pending.caret, pending.caret);
  });
  const field = useField(id, undefined, error, props["aria-describedby"]);
  function update(input: HTMLInputElement, raw: string, cursor: number) {
    // Keep the committed value visible until the owner accepts the change.
    input.value = displayed;
    if (props.readOnly || props.disabled) return;
    const formatted = format(raw);
    const caret = format(raw.slice(0, cursor)).length;
    const pending = { input, value: formatted, caret };
    pendingCaret.current = pending;
    if (formatted === displayed) input.setSelectionRange(caret, caret);
    if (value === undefined) setLocal(formatted);
    onChange?.(formatted);
    // Accepted edits consume this during layout; rejected edits must not outlive this event.
    queueMicrotask(() => {
      if (pendingCaret.current === pending) pendingCaret.current = null;
    });
  }
  return (
    <div className={cn(fieldClass, className)}>
      <label htmlFor={field.id} className={labelClass}>
        {label}
      </label>
      <input
        {...props}
        id={field.id}
        data-own-size
        type="text"
        value={displayed}
        maxLength={9}
        pattern="[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}"
        autoComplete="one-time-code"
        inputMode="text"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder={props.placeholder ?? "XXXX-XXXX"}
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={field.describedBy}
        onChange={(event) =>
          update(
            event.currentTarget,
            event.currentTarget.value,
            event.currentTarget.selectionStart ?? event.currentTarget.value.length,
          )
        }
        onPaste={(event) => {
          if (props.readOnly || props.disabled) {
            event.preventDefault();
            return;
          }
          onPaste?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          const input = event.currentTarget;
          const start = input.selectionStart ?? input.value.length;
          const end = input.selectionEnd ?? start;
          const pasted = event.clipboardData.getData("text");
          update(input, input.value.slice(0, start) + pasted + input.value.slice(end), start + pasted.length);
        }}
        className="box-border h-[60px] w-full rounded-lg border border-line-2 bg-surface px-3 text-center font-mono text-[28px] leading-none font-semibold tracking-[0.16em] text-fg-1 uppercase shadow-inset placeholder:text-fg-disabled focus:border-line-focus focus:outline-none focus:shadow-[0_0_0_3px_var(--accent-tint-2)] disabled:cursor-not-allowed disabled:bg-sunken disabled:text-fg-disabled aria-invalid:border-danger-solid aria-invalid:focus:shadow-[0_0_0_3px_var(--danger-bg)]"
      />
      <FieldMessage id={field.messageId} error={error} />
    </div>
  );
}
