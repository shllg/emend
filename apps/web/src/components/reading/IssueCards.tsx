import { type IssueRef, type IssueState, RepoUrl } from "@emend/contract";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { type HoverTarget, useHoverCard } from "../../lib/use-hover-card.ts";

const ISSUE = "a[data-emend-issue]";
const STATE_WORDS: Record<IssueState, string> = { open: "Open", closed: "Closed", merged: "Merged" };

const issueUrl = (repoUrl: string, number: number) => String(new URL(`${repoUrl}/issues/${number}`));

/** Only an anchor the server made from a number it has a title for gets a card. */
function issueAt(
  target: EventTarget | null,
  root: HTMLElement,
  repoUrl: string,
  refs: IssueRef[],
): HoverTarget | undefined {
  if (!(target instanceof Element)) return;
  const element = target.closest<HTMLElement>(ISSUE);
  const block = element?.closest<HTMLElement>("[data-block-id]");
  const value = element?.dataset.emendIssue;
  if (
    !element ||
    !root.contains(element) ||
    !block ||
    !root.contains(block) ||
    element.closest("[data-thread-card]") ||
    !value ||
    !/^[1-9]\d{0,6}$/.test(value)
  )
    return;
  const number = Number(value);
  if (!refs.some((ref) => ref.number === number)) return;
  if (element.getAttribute("href") !== issueUrl(repoUrl, number)) return;
  return { element, key: number };
}

type IssueCardsProps = {
  root: RefObject<HTMLElement | null>;
  repoUrl?: string | null;
  refs?: IssueRef[];
};

export function IssueCards({ repoUrl, refs, ...props }: IssueCardsProps) {
  const parsed = RepoUrl.safeParse(repoUrl);
  return refs?.length && parsed.success ? <Cards {...props} repoUrl={parsed.data} refs={refs} /> : null;
}

function Cards({ root, repoUrl, refs }: IssueCardsProps & { repoUrl: string; refs: IssueRef[] }) {
  const { id, card, link, open } = useHoverCard({
    root,
    find: (target) => (root.current ? issueAt(target, root.current, repoUrl, refs) : undefined),
    selector: ISSUE,
    mode: "link",
    enabled: true,
  });
  const issue = open && refs.find((ref) => ref.number === open.key);
  if (!issue) return null;
  return createPortal(
    <div ref={card} id={id} className="em-term-card" role="dialog" aria-labelledby={`${id}-number ${id}-title`}>
      <div>
        <strong id={`${id}-number`}>#{issue.number}</strong>{" "}
        <span className="em-issue-state">{STATE_WORDS[issue.state]}</span>
      </div>
      <p id={`${id}-title`} dir="auto">
        {issue.title}
      </p>
      <a
        ref={link}
        href={issueUrl(repoUrl, issue.number)}
        target="_blank"
        rel="noopener noreferrer nofollow"
        dir="auto"
      >
        View on {new URL(repoUrl).host}
      </a>
    </div>,
    document.body,
  );
}
