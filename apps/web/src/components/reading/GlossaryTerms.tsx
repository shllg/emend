import type { GlossaryTerm } from "@emend/contract";
import { type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type ActiveTerm = { element: HTMLElement; index: number };

function termAt(target: EventTarget | null, root: HTMLElement, terms: GlossaryTerm[]): ActiveTerm | undefined {
  if (!(target instanceof Element)) return;
  const element = target.closest<HTMLElement>("span.emend-term[data-emend-term]");
  const block = element?.closest<HTMLElement>("[data-block-id]");
  const value = element?.dataset.emendTerm;
  if (
    !element ||
    !root.contains(element) ||
    !block ||
    !root.contains(block) ||
    block.dataset.blockId?.startsWith("glossary-") ||
    !value ||
    !/^\d+$/.test(value)
  )
    return;
  const index = Number(value);
  if (index >= terms.length) return;
  return { element, index };
}

type GlossaryTermsProps = {
  root: RefObject<HTMLElement | null>;
  terms?: GlossaryTerm[];
  href: (blockId: string) => string;
};

export function GlossaryTerms(props: GlossaryTermsProps) {
  return props.terms?.length ? <TermCards {...props} terms={props.terms} /> : null;
}

function TermCards({ root, terms, href }: GlossaryTermsProps & { terms: GlossaryTerm[] }) {
  const id = useId();
  const card = useRef<HTMLDivElement>(null);
  const link = useRef<HTMLAnchorElement>(null);
  const focusLink = useRef(false);
  const pointer = useRef<Element | null>(null);
  const opening = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState<ActiveTerm | null>(null);
  const term = open && terms?.[open.index];

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
    if (!element || !terms?.length) return;
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
        open.element.focus();
        restoringFocus = false;
      }
      setOpen(null);
    };
    const show = (next: ActiveTerm, focus = false) => {
      clear();
      focusLink.current = focus;
      setOpen(next);
    };
    const delay = (next: ActiveTerm) => {
      clearOpen();
      if (next.element === open?.element) return;
      opening.current = setTimeout(() => {
        if (termAt(next.element, element, terms)) show(next);
      }, 500);
    };
    const leave = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      if (!termAt(event.target, element, terms) && !panel?.contains(event.target as Node)) return;
      if (inside(event.relatedTarget)) {
        clearClose();
        return;
      }
      clearOpen();
      if (inside(event.target) && !focused()) {
        clearClose();
        closing.current = setTimeout(() => {
          closing.current = undefined;
          // A different term may still be waiting for its hover delay.
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
      const next = termAt(event.target, element, terms);
      if (next) {
        if (next.element === open?.element) clearClose();
        if (!next.element.contains(event.relatedTarget as Node | null)) delay(next);
      }
    };
    const focus = (event: FocusEvent) => {
      if (restoringFocus) return;
      if (focused(event.target)) clearClose();
      const next = termAt(event.target, element, terms);
      if (next) delay(next);
    };
    const blur = (event: FocusEvent) => {
      clearOpen();
      if (inside(event.target) && !focused(event.relatedTarget) && !hovered()) close();
    };
    const click = (event: MouseEvent) => {
      const next = termAt(event.target, element, terms);
      if (next && window.getSelection()?.isCollapsed !== false) show(next);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const next = termAt(event.target, element, terms);
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
    const follow = () => close();
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
    for (const candidate of element.querySelectorAll("span.emend-term[data-emend-term]")) {
      const valid = termAt(candidate, element, terms);
      if (!valid) continue;
      const expanded = valid.element === open?.element;
      decorated.push(valid.element);
      valid.element.tabIndex = 0;
      valid.element.setAttribute("role", "button");
      valid.element.setAttribute("aria-haspopup", "dialog");
      valid.element.setAttribute("aria-expanded", String(expanded));
      if (expanded) valid.element.setAttribute("aria-controls", id);
      else valid.element.removeAttribute("aria-controls");
    }
    if (open && !termAt(open.element, element, terms)) close();
    element.addEventListener("pointerover", enter);
    element.addEventListener("pointerout", leave);
    element.addEventListener("focusin", focus);
    element.addEventListener("focusout", blur);
    element.addEventListener("click", click);
    element.addEventListener("keydown", key);
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
        for (const attribute of ["tabindex", "role", "aria-haspopup", "aria-expanded", "aria-controls"])
          mark.removeAttribute(attribute);
      }
      element.removeEventListener("pointerover", enter);
      element.removeEventListener("pointerout", leave);
      element.removeEventListener("focusin", focus);
      element.removeEventListener("focusout", blur);
      element.removeEventListener("click", click);
      element.removeEventListener("keydown", key);
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

  if (!term) return null;
  return createPortal(
    <div ref={card} id={id} className="em-term-card" role="dialog" aria-labelledby={`${id}-term`}>
      <strong id={`${id}-term`} dir="auto">
        {term.term}
      </strong>
      <p dir="auto">{term.definition}</p>
      <a ref={link} href={href(term.blockId)} dir="auto">
        Glossary
      </a>
    </div>,
    document.body,
  );
}
