import { type PublishLink, type ReviewView, type RevisionView, reviewDownloadPath } from "@emend/contract";
import {
  CircleDot,
  ExternalLink,
  FileDown,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  MessageSquarePlus,
} from "lucide-react";
import { type Ref, useEffect, useState } from "react";
import { plural } from "../../lib/count.ts";
import { reviewLineTotals } from "../../lib/diff-totals.ts";
import { LineTotals } from "../diff/LineTotals.tsx";
import type { DiffCounts } from "../diff/presentation.ts";
import { AgentStatus, agentStatusOf } from "../status/AgentStatus.tsx";
import { OriginBadge } from "../status/OriginBadge.tsx";
import { SnoozeBadge, StateBadge } from "../status/StateBadge.tsx";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { CopyTextMenu } from "../ui/CopyTextMenu.tsx";
import { Icon } from "../ui/Icon.tsx";
import { cn } from "../ui/utils.ts";
import { LayoutControls } from "./LayoutControls.tsx";
import { RevisionPicker } from "./RevisionPicker.tsx";

const linkIcon = { pr: GitPullRequest, issue: CircleDot, other: ExternalLink } as const;

/** The server validates links; the browser checks again before it makes one clickable. */
function safeLinks(links: PublishLink[] | undefined) {
  return (links ?? []).flatMap((link) => {
    try {
      const url = new URL(link.url);
      // `host` is punycode for a non-ASCII host, so a lookalike shows as what it is.
      return url.protocol === "https:" && url.username === "" && url.password === ""
        ? [{ ...link, host: url.host, href: url.href }]
        : [];
    } catch {
      return [];
    }
  });
}

export function ReviewHeader({
  review,
  revision,
  counts,
  seq,
  ready,
  phone,
  titleRef,
  onRevisionChange,
  onCommentReview,
  onDownload,
}: {
  review: ReviewView;
  revision?: RevisionView;
  counts: ReadonlyMap<string, DiffCounts>;
  seq: number;
  ready: number;
  phone: boolean;
  titleRef: Ref<HTMLHeadingElement>;
  onRevisionChange: (seq: number) => void;
  onCommentReview?: () => void;
  onDownload?: () => void;
}) {
  const agent = agentStatusOf(review);
  // The same minute clock the inbox rows use, so "Picked up 5m" stays current.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const commits =
    revision &&
    [revision.base?.slice(0, 7), revision.head === "worktree" ? "working tree" : revision.head?.slice(0, 7)]
      .filter(Boolean)
      .join(" → ");
  const links = safeLinks(revision?.links);
  const total = revision ? reviewLineTotals(revision, counts) : null;
  const metaItem = "inline-flex min-w-0 items-center gap-[5px] wrap-anywhere";
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1 border-b border-line-1 bg-surface",
        phone ? "px-4 py-3" : "px-5 pt-3 pb-2.5",
      )}
    >
      <div className={phone ? "flex items-center gap-3" : "flex flex-wrap items-start gap-3"}>
        {phone ? (
          <CopyTextMenu
            text={review.title}
            noun="title"
            heading={{
              as: "h1",
              ref: titleRef,
              tabIndex: -1,
              className:
                "m-0 min-w-0 flex-[1_1_240px] text-[17px] font-semibold leading-[1.3] tracking-[-0.01em] text-fg-1",
            }}
            trigger={{
              className: "block w-full border-0 bg-transparent p-0 text-start [font:inherit] [color:inherit]",
              children: <span className="block truncate">{review.title}</span>,
            }}
            blocks={[
              {
                content: review.title,
                className:
                  "px-2.5 pt-2 pb-1 font-sans text-13 whitespace-pre-wrap text-fg-1 [overflow-wrap:anywhere] select-text",
              },
            ]}
          />
        ) : (
          <h1
            ref={titleRef}
            tabIndex={-1}
            className="m-0 min-w-0 flex-[1_1_240px] text-pretty wrap-anywhere text-[17px] font-semibold leading-[1.3] tracking-[-0.01em] text-fg-1"
          >
            {review.title}
          </h1>
        )}
        {phone && <RevisionPicker compact review={review} seq={seq} onChange={onRevisionChange} />}
        {!phone && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {onDownload ? (
              <Button
                variant="ghost"
                size="sm"
                icon={FileDown}
                title="Download this revision, with docs if you pick them"
                onClick={onDownload}
              >
                Download
              </Button>
            ) : (
              <Button asChild variant="ghost" size="sm" icon={FileDown} title="Download this revision as one HTML file">
                <a href={reviewDownloadPath(review.id, seq)} download>
                  Download
                </a>
              </Button>
            )}
            <Button variant="ghost" size="sm" icon={MessageSquarePlus} disabled={!revision} onClick={onCommentReview}>
              Comment on review
            </Button>
            <LayoutControls />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-fg-3 [font:var(--type-meta)]">
        <span className="inline-flex min-w-0 items-center gap-1.5 wrap-anywhere">
          <OriginBadge origin={review.origin} dot className="size-[7px] opacity-85" />
          {review.origin.name}
        </span>
        {review.project !== null && (
          <>
            <span aria-hidden="true" className="text-line-strong">
              ·
            </span>
            <span dir="auto" className="min-w-0 wrap-anywhere">
              {review.project}
            </span>
          </>
        )}
        {review.state !== "open" && (
          <>
            <span aria-hidden="true" className="text-line-strong">
              ·
            </span>
            <StateBadge state={review.state} />
          </>
        )}
        {review.snoozed && (
          <>
            <span aria-hidden="true" className="text-line-strong">
              ·
            </span>
            <SnoozeBadge until={review.snoozedUntil} now={Date.now()} />
          </>
        )}
        {agent && agent !== "approved" && (
          <>
            <span aria-hidden="true" className="text-line-strong">
              ·
            </span>
            <AgentStatus status={agent} pickedUpAt={review.pickedUpAt} now={now} className="font-normal text-fg-3" />
          </>
        )}
      </div>
      {(!phone || review.branch || revision?.files.length === 0 || total) && (
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 font-mono text-12 leading-[1.2] font-stretch-mono text-fg-3">
          {review.branch && (
            <span className={metaItem}>
              <Icon icon={GitBranch} size={13} />
              {review.branch}
            </span>
          )}
          {!phone && commits && (
            <span className={metaItem}>
              <Icon icon={GitCommitHorizontal} size={13} />
              {commits}
            </span>
          )}
          <LineTotals counts={total} />
          {revision?.files.length === 0 && (
            <span className={metaItem}>
              <Icon icon={FileText} size={13} />
              {revision.docs.length} {plural(revision.docs.length, "doc")} · no code changes
            </span>
          )}
          {!phone && <RevisionPicker review={review} seq={seq} onChange={onRevisionChange} />}
        </div>
      )}
      {links.length > 0 && (
        <ul
          aria-label="Links"
          className="m-0 flex min-w-0 list-none flex-wrap items-center gap-1.5 p-0 text-12 leading-[1.2]"
        >
          {links.map((link, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two links may share a URL; the list never reorders.
            <li key={`${index}:${link.url}`} className="min-w-0 max-w-full">
              <a
                href={link.href}
                title={link.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex max-w-full items-center gap-1 rounded-sm border border-line-1 px-1.5 py-[3px] text-fg-2 no-underline hover:bg-hover hover:text-fg-1"
              >
                <Icon icon={linkIcon[link.kind ?? "other"]} size={12} />
                <span className="min-w-0 shrink-[0.2] truncate">{link.label}</span>
                {/* An agent writes the label, so the real host stays visible; the host gives way first. */}
                <span className="min-w-0 shrink-[3] truncate text-11 text-fg-3">{link.host}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {review.importedAt && (
        <p className="m-0 wrap-anywhere text-fg-3 [font:var(--type-meta)]">
          Copied from {review.origin.name} on {new Date(review.importedAt).toLocaleDateString()}. Comments, Sends and
          approvals before then were made there.
        </p>
      )}
      {ready > seq && (
        <Banner tone="info" actionLabel="Show" onAction={() => onRevisionChange(ready)}>
          Revision {ready} is ready.
        </Banner>
      )}
    </div>
  );
}
