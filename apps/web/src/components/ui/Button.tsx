import { Slot, Slottable } from "@radix-ui/react-slot";
import { Loader } from "lucide-react";
import type { ComponentProps } from "react";
import { Icon, type IconComponent } from "./Icon.tsx";
import { cn, focusRing } from "./utils.ts";

export interface ButtonProps extends ComponentProps<"button"> {
  asChild?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "approve" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: IconComponent;
  iconRight?: IconComponent;
  loading?: boolean;
  fullWidth?: boolean;
  kbd?: string;
}

const variants = {
  primary:
    "bg-accent text-accent-fg border-[color-mix(in_oklch,var(--ochre-600)_55%,transparent)] shadow-[inset_0_1px_0_oklch(from_var(--n-0)_1_0_0_/_0.35),var(--shadow-1)] [&:not(:disabled):not([aria-disabled=true])]:hover:text-accent-fg [&:not(:disabled):not([aria-disabled=true])]:hover:bg-accent-hover [&:not(:disabled):not([aria-disabled=true])]:active:bg-accent-press",
  secondary:
    "bg-surface text-fg-1 border-line-2 shadow-1 [&:not(:disabled):not([aria-disabled=true])]:hover:bg-sunken [&:not(:disabled):not([aria-disabled=true])]:hover:border-line-strong [&:not(:disabled):not([aria-disabled=true])]:active:bg-active",
  ghost:
    "bg-transparent text-fg-2 [&:not(:disabled):not([aria-disabled=true])]:hover:bg-hover [&:not(:disabled):not([aria-disabled=true])]:hover:text-fg-1 [&:not(:disabled):not([aria-disabled=true])]:active:bg-active",
  approve:
    "bg-surface text-success-fg border-[color-mix(in_oklch,var(--success-solid)_45%,var(--border-2))] shadow-1 [&:not(:disabled):not([aria-disabled=true])]:hover:bg-success-bg [&:not(:disabled):not([aria-disabled=true])]:active:bg-active",
  danger:
    "bg-transparent text-danger-fg border-line-2 [&:not(:disabled):not([aria-disabled=true])]:hover:bg-danger-bg [&:not(:disabled):not([aria-disabled=true])]:hover:border-[color-mix(in_oklch,var(--danger-solid)_40%,var(--border-2))] [&:not(:disabled):not([aria-disabled=true])]:active:bg-active",
};
const sizes = {
  sm: "h-7 gap-[5px] rounded-sm px-[9px] text-12",
  md: "h-8 gap-1.5 px-3",
  lg: "h-10 gap-2 px-4 text-14",
};

export function Button({
  asChild = false,
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  loading = false,
  disabled = false,
  fullWidth = false,
  kbd,
  children,
  className,
  type,
  onClickCapture,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";
  const inactive = disabled || loading;
  const iconSize = size === "sm" ? 14 : 16;
  return (
    <Component
      {...props}
      type={type ?? (asChild ? undefined : "button")}
      disabled={asChild ? undefined : inactive}
      aria-disabled={inactive || props["aria-disabled"]}
      aria-busy={loading || props["aria-busy"]}
      tabIndex={asChild && inactive ? -1 : props.tabIndex}
      onClickCapture={(event) => {
        if (inactive) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClickCapture?.(event);
      }}
      className={cn(
        "inline-flex select-none items-center justify-center whitespace-nowrap rounded-md border border-transparent font-sans text-13 font-medium no-underline transition-[background,border-color,color] duration-(--dur-1) ease-(--ease-out) [-webkit-tap-highlight-color:transparent] [&:not(:disabled):not([aria-disabled=true])]:active:translate-y-[0.5px] disabled:cursor-not-allowed disabled:opacity-48 aria-disabled:cursor-not-allowed aria-disabled:opacity-48",
        focusRing,
        variants[variant],
        sizes[size],
        "leading-(--lh-snug)",
        fullWidth && "w-full",
        className,
      )}
    >
      {loading ? (
        <Icon icon={Loader} size={iconSize} className="animate-[em-spin_900ms_linear_infinite]" />
      ) : icon ? (
        <Icon icon={icon} size={iconSize} />
      ) : null}
      <Slottable>{children}</Slottable>
      {iconRight && <Icon icon={iconRight} size={iconSize} />}
      {kbd && (
        <kbd className="rounded-xs bg-[oklch(from_var(--bg-overlay)_l_c_h_/_0.08)] px-1 py-px font-mono text-12 font-medium leading-(--lh-snug) text-inherit opacity-75">
          {kbd}
        </kbd>
      )}
    </Component>
  );
}
