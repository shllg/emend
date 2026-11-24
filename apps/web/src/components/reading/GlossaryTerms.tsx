import type { GlossaryTerm } from "@recense/contract";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { type HoverTarget, useHoverCard } from "../../lib/use-hover-card.ts";

// Blocks stored before the rename carry `emend-term` and `data-emend-term`; they keep working.
const TERM = "span:is(.recense-term, .emend-term):is([data-recense-term], [data-emend-term])";

function termAt(target: EventTarget | null, root: HTMLElement, terms: GlossaryTerm[]): HoverTarget | undefined {
  if (!(target instanceof Element)) return;
  const element = target.closest<HTMLElement>(TERM);
  const block = element?.closest<HTMLElement>("[data-block-id]");
  const value = element?.dataset.recenseTerm ?? element?.dataset.emendTerm;
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
  return { element, key: index };
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
  const { id, card, link, open } = useHoverCard({
    root,
    find: (target) => (root.current ? termAt(target, root.current, terms) : undefined),
    selector: TERM,
    mode: "button",
    enabled: terms.length > 0,
  });
  const term = open && terms[open.key];

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
