import { ChevronDown, ChevronRight } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { plural } from "../../lib/count.ts";
import { ChangedMarker } from "../status/ChangedMarker.tsx";
import { TopicRank } from "../status/TopicRank.tsx";
import type { ReaderGroup } from "./BlockReader.tsx";
import { TopicChips } from "./TopicChips.tsx";

const presentationClasses = {
  tldr: " em-writeup-card",
  decisions: " em-writeup-callout em-writeup-decisions",
  glossary: "",
  outOfScope: " em-writeup-quiet",
  whereToLook: " em-writeup-callout em-writeup-guide",
  context: " em-writeup-muted",
} satisfies Record<NonNullable<ReaderGroup["presentation"]>, string>;

export const ReadingFoldContext = createContext<{
  reviewId: string;
  revision: number;
  choices: Map<string, boolean>;
} | null>(null);

export function ReadingGroup({
  group,
  headingId,
  changedIn,
  children,
}: {
  group: ReaderGroup;
  headingId: string;
  changedIn?: number;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const folds = useContext(ReadingFoldContext);
  const foldKey = JSON.stringify([folds?.reviewId, folds?.revision, group.key]);
  const defaultOpen =
    changedIn !== undefined || (group.presentation !== "glossary" && group.topic?.attention !== "skim");
  const [choice, setChoice] = useState({ open: defaultOpen });
  // Read the active entry during render; switching fold maps needs no extra render cycle.
  const open = folds ? (folds.choices.get(foldKey) ?? defaultOpen) : choice.open;
  const rememberOpen = useCallback(
    (next: boolean) => {
      folds?.choices.set(foldKey, next);
      setChoice({ open: next });
    },
    [folds, foldKey],
  );
  const bodyId = `${headingId}-body`;
  useLayoutEffect(() => {
    // React treats hidden as a boolean; the native value also supports browser Find.
    if (!open) body.current?.setAttribute("hidden", "until-found");
  }, [open]);
  useEffect(() => {
    const section = root.current;
    const reveal = () => {
      // Navigation scrolls in the same turn. Expose the mounted blocks before React updates the button.
      if (body.current) body.current.hidden = false;
      if (group.presentation === "glossary") {
        const glossary = section?.querySelector<HTMLDetailsElement>("details.em-writeup-glossary");
        if (glossary) glossary.open = true;
      }
      rememberOpen(true);
    };
    section?.addEventListener("emend:reveal-reading", reveal);
    section?.addEventListener("beforematch", reveal);
    return () => {
      section?.removeEventListener("emend:reveal-reading", reveal);
      section?.removeEventListener("beforematch", reveal);
    };
  }, [group.presentation, rememberOpen]);
  const heading = group.heading != null && (
    <div className={group.topic ? "em-topic-header" : "mb-3 flex items-center gap-2.5"}>
      {group.topic && (
        <>
          <button
            type="button"
            className="em-topic-fold"
            aria-labelledby={headingId}
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => rememberOpen(!open)}
          >
            {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
          </button>
          <TopicChips topic={group.topic} />
          {group.rank !== undefined && <TopicRank rank={group.rank} />}
        </>
      )}
      <h2
        id={headingId}
        className={
          group.topic
            ? "em-topic-title"
            : group.presentation && group.presentation !== "glossary"
              ? "em-writeup-kicker"
              : "min-w-0 flex-1 wrap-anywhere text-fg-reading-strong [font:var(--type-h2)]"
        }
      >
        {group.heading}
      </h2>
      {!open && !!group.commentCount && (
        <span className="em-topic-comments">
          {group.commentCount} {plural(group.commentCount, "comment")}
        </span>
      )}
      {group.topic && !open && changedIn !== undefined && <ChangedMarker revision={changedIn} />}
      {group.action}
    </div>
  );
  const items = group.blocks.filter((block) => block.kind === "item").length;
  const terms = items || group.blocks.length;
  return (
    <section
      ref={root}
      id={group.id}
      data-reading-section={group.key}
      aria-labelledby={group.labelledBy ?? headingId}
      className={`em-reading-group${group.topic ? " em-topic-section" : ""}${group.presentation ? presentationClasses[group.presentation] : ""}`}
    >
      {group.presentation === "glossary" ? (
        <details
          className="em-writeup-glossary"
          open={open}
          onToggle={(event) => {
            if (event.target === event.currentTarget) rememberOpen(event.currentTarget.open);
          }}
        >
          <summary id={headingId}>
            Glossary · {terms} {plural(terms, "term")}
          </summary>
          {children}
        </details>
      ) : (
        <>
          {heading}
          {group.meta}
          {group.topic ? (
            <div ref={body} id={bodyId} hidden={!open}>
              {children}
            </div>
          ) : (
            children
          )}
        </>
      )}
    </section>
  );
}
