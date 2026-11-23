import { type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import { focusReadingTarget } from "../../lib/reading-focus.ts";

export type HoverTarget = { element: HTMLElement; key: number };

/**
 * `button`: the element is a plain span; it becomes a button and Enter or Space opens the card.
 * `link`: the element is already a link; only a touch tap opens the card, every other click follows it.
 */
export type HoverMode = "button" | "link";

type HoverCardOptions = {
  root: RefObject<HTMLElement | null>;
  /** The active element for an event target or element, or undefined when it is not one. */
  find: (target: EventTarget | null) => HoverTarget | undefined;
  /** Selects the candidates that get the accessibility attributes. */
  selector: string;
  mode: HoverMode;
  enabled: boolean;
};

const ATTRIBUTES = {
  button: ["tabindex", "role", "aria-haspopup", "aria-expanded", "aria-controls"],
  link: ["aria-haspopup", "aria-expanded", "aria-controls"],
} as const;

const pointerTypeOf = (event: MouseEvent, lastDown: string) => {
  const own = (event as Partial<PointerEvent>).pointerType;
  return typeof own === "string" && own !== "" ? own : lastDown;
};

export function useHoverCard({ root, find, selector, mode, enabled }: HoverCardOptions) {
  const id = useId();
  const card = useRef<HTMLDivElement>(null);
  const link = useRef<HTMLAnchorElement>(null);
  const focusLink = useRef(false);
  const pointer = useRef<Element | null>(null);
  const lastDown = useRef("");
  const opening = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState<HoverTarget | null>(null);

  useLayoutEffect(() => {
    const track = (event: PointerEvent) => {
      if (event.pointerType === "mouse" || event.pointerType === "pen")
        pointer.current = event.target instanceof Element ? event.target : null;
    };
    const leaveWindow = (event: PointerEvent) => {
      if ((event.pointerType === "mouse" || event.pointerType === "pen") && event.relatedTarget === null)
        pointer.current = null;
    };
    document.addEventListener("pointerover", track, true);
    document.addEventListener("pointerout", leaveWindow, true);
    return () => {
      document.removeEventListener("pointerover", track, true);
      document.removeEventListener("pointerout", leaveWindow, true);
      clearTimeout(opening.current);
      clearTimeout(closing.current);
    };
  }, []);

  // Block HTML can change while the groups keep their identity.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !enabled) return;
    const panel = card.current;
    let restoringFocus = false;
    const clearOpen = () => {
      clearTimeout(opening.current);
      opening.current = undefined;
    };
    const clearClose = () => {
      clearTimeout(closing.current);
      closing.current = undefined;
    };
    const clear = () => {
      clearOpen();
      clearClose();
    };
    const inside = (target: EventTarget | null) =>
      !!open && target instanceof Node && (open.element.contains(target) || panel?.contains(target));
    const hovered = () => pointer.current?.isConnected && inside(pointer.current);
    const focused = (target: EventTarget | null = document.activeElement) => inside(target);
    const close = (restore = false) => {
      clear();
      focusLink.current = false;
      if (restore && open?.element.isConnected) {
        restoringFocus = true;
        focusReadingTarget(open.element);
        restoringFocus = false;
      }
      setOpen(null);
    };
    const show = (next: HoverTarget, focus = false) => {
      clear();
      focusLink.current = focus;
      setOpen(next);
    };
    const delay = (next: HoverTarget) => {
      clearOpen();
      if (next.element === open?.element) return;
      opening.current = setTimeout(() => {
        if (find(next.element)) show(next);
      }, 500);
    };
    const leave = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      if (!find(event.target) && !panel?.contains(event.target as Node)) return;
      clearOpen();
      if (inside(event.relatedTarget)) {
        clearClose();
        return;
      }
      if (inside(event.target) && !focused()) {
        clearClose();
        closing.current = setTimeout(() => {
          closing.current = undefined;
          // A different element may still be waiting for its hover delay.
          if (!hovered() && !focused()) setOpen(null);
        }, 300);
      }
    };
    const enter = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      if (panel?.contains(event.target as Node)) {
        clearClose();
        return;
      }
      const next = find(event.target);
      if (next) {
        if (next.element === open?.element) clearClose();
        if (!next.element.contains(event.relatedTarget as Node | null)) delay(next);
      }
    };
    const focus = (event: FocusEvent) => {
      if (restoringFocus) return;
      if (focused(event.target)) clearClose();
      const next = find(event.target);
      if (next) delay(next);
    };
    const blur = (event: FocusEvent) => {
      clearOpen();
      if (inside(event.target) && !focused(event.relatedTarget) && !hovered()) close();
    };
    const click = (event: MouseEvent) => {
      const next = find(event.target);
      if (!next) return;
      if (mode === "button") {
        if (window.getSelection()?.isCollapsed !== false) show(next);
        return;
      }
      if (pointerTypeOf(event, lastDown.current) === "touch") {
        if (window.getSelection()?.isCollapsed === false) return;
        event.preventDefault();
        show(next);
      } else if (open) close();
    };
    const down = (event: PointerEvent) => {
      lastDown.current = event.pointerType;
    };
    const key = (event: KeyboardEvent) => {
      // A keyboard click has an empty pointerType; it must not inherit an earlier touch.
      lastDown.current = "";
      if (mode !== "button" || (event.key !== "Enter" && event.key !== " ")) return;
      const next = find(event.target);
      if (!next) return;
      event.preventDefault();
      show(next, true);
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (focused()) {
        event.preventDefault();
        event.stopPropagation();
      }
      close(!!panel?.contains(document.activeElement));
    };
    const outside = (event: PointerEvent) => {
      if (!inside(event.target)) close();
    };
    const follow = () => close(!!panel?.contains(document.activeElement));
    const position = () => {
      if (!open || !panel) return;
      const anchor = open.element.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8));
      const below = anchor.bottom + 6;
      const top = below + bounds.height <= window.innerHeight - 8 ? below : anchor.top - bounds.height - 6;
      panel.style.left = `${left}px`;
      panel.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8))}px`;
    };
    const decorated: HTMLElement[] = [];
    for (const candidate of element.querySelectorAll(selector)) {
      const valid = find(candidate);
      if (!valid) continue;
      const expanded = valid.element === open?.element;
      decorated.push(valid.element);
      if (mode === "button") {
        valid.element.tabIndex = 0;
        valid.element.setAttribute("role", "button");
      }
      valid.element.setAttribute("aria-haspopup", "dialog");
      valid.element.setAttribute("aria-expanded", String(expanded));
      if (expanded) valid.element.setAttribute("aria-controls", id);
      else valid.element.removeAttribute("aria-controls");
    }
    if (open && !find(open.element)) close();
    element.addEventListener("pointerover", enter);
    element.addEventListener("pointerout", leave);
    element.addEventListener("focusin", focus);
    element.addEventListener("focusout", blur);
    element.addEventListener("click", click);
    element.addEventListener("keydown", key);
    element.addEventListener("pointerdown", down, true);
    if (open) {
      panel?.addEventListener("pointerover", enter);
      panel?.addEventListener("pointerout", leave);
      panel?.addEventListener("focusin", focus);
      panel?.addEventListener("focusout", blur);
      link.current?.addEventListener("click", follow);
      window.addEventListener("keydown", dismiss, true);
      window.addEventListener("pointerdown", outside);
      window.addEventListener("resize", position);
      window.addEventListener("scroll", position, true);
      position();
      if (focusLink.current) {
        focusLink.current = false;
        link.current?.focus();
      }
    }
    const anchorLink = link.current;
    return () => {
      for (const mark of decorated) {
        for (const attribute of ATTRIBUTES[mode]) mark.removeAttribute(attribute);
      }
      element.removeEventListener("pointerover", enter);
      element.removeEventListener("pointerout", leave);
      element.removeEventListener("focusin", focus);
      element.removeEventListener("focusout", blur);
      element.removeEventListener("click", click);
      element.removeEventListener("keydown", key);
      element.removeEventListener("pointerdown", down, true);
      panel?.removeEventListener("pointerover", enter);
      panel?.removeEventListener("pointerout", leave);
      panel?.removeEventListener("focusin", focus);
      panel?.removeEventListener("focusout", blur);
      anchorLink?.removeEventListener("click", follow);
      window.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  });

  return { id, card, link, open };
}
