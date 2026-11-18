import { Slot, Slottable } from "@radix-ui/react-slot";
import { type ComponentProps, useId } from "react";
import { Icon, type IconComponent } from "./Icon.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { cn, focusRing } from "./utils.ts";

export interface IconButtonProps extends ComponentProps<"button"> {
  label: string;
  icon: IconComponent;
  size?: "sm" | "md" | "lg";
  variant?: "ghost" | "secondary";
  pressed?: boolean;
  badge?: number;
  asChild?: boolean;
  tooltip?: boolean;
}

export function IconButton({
  label,
  icon,
  size = "md",
  variant = "ghost",
  pressed,
  badge,
  asChild = false,
  tooltip = true,
  children,
  className,
  type,
  disabled,
  onClickCapture,
  ...props
}: IconButtonProps) {
  const Component = asChild ? Slot : "button";
  const badgeLabelId = useId();
  const hasBadge = badge != null && badge !== 0;
  const button = (
    <Component
      {...props}
      type={type ?? (asChild ? undefined : "button")}
      disabled={asChild ? undefined : disabled}
      aria-disabled={disabled || props["aria-disabled"]}
      aria-label={label}
      aria-labelledby={[props["aria-labelledby"], hasBadge && badgeLabelId].filter(Boolean).join(" ") || undefined}
      aria-pressed={pressed}
      tabIndex={asChild && disabled ? -1 : props.tabIndex}
      onClickCapture={(event) => {
        if (disabled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClickCapture?.(event);
      }}
      className={cn(
        "relative inline-grid shrink-0 place-items-center rounded-md border border-transparent bg-transparent text-fg-2 no-underline transition-[background,color] duration-(--dur-1) ease-(--ease-out) [-webkit-tap-highlight-color:transparent] [&:not(:disabled):not([aria-disabled=true])]:hover:bg-hover [&:not(:disabled):not([aria-disabled=true])]:hover:text-fg-1 [&:not(:disabled):not([aria-disabled=true])]:active:bg-active [&:not(:disabled):not([aria-disabled=true])]:active:text-fg-1 aria-pressed:bg-active aria-pressed:text-fg-1 aria-expanded:bg-active aria-expanded:text-fg-1 disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45",
        focusRing,
        size === "sm" ? "size-7 rounded-sm" : size === "lg" ? "size-10" : "size-8",
        variant === "secondary" && "border-line-2 bg-surface shadow-1",
        className,
      )}
    >
      <Icon icon={icon} size={size === "sm" ? 14 : size === "lg" ? 18 : 16} />
      {asChild && <Slottable>{children}</Slottable>}
      {hasBadge && (
        <span id={badgeLabelId} className="sr-only">
          {label}, {badge}
        </span>
      )}
      {hasBadge && (
        <span
          aria-hidden="true"
          className="absolute top-0.5 right-0.5 h-[0.875rem] min-w-[0.875rem] rounded-md bg-accent px-[3px] text-center font-sans text-[9px] leading-[14px] font-semibold text-accent-fg"
        >
          {badge}
        </span>
      )}
    </Component>
  );
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
}
