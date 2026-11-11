import type { InboxItem } from "@emend/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, PanelLeftClose, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { inboxQuery, serverNow } from "../api/queries.ts";
import { needsAttention, ReviewRow } from "../components/inbox/ReviewRow.tsx";
import { AppFrame } from "../components/layout/AppFrame.tsx";
import { Button } from "../components/ui/Button.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { IconButton } from "../components/ui/IconButton.tsx";
import { SegmentedControl } from "../components/ui/SegmentedControl.tsx";
import { Select } from "../components/ui/Select.tsx";
import { TextField } from "../components/ui/TextField.tsx";
import { plural } from "../lib/count.ts";
import { useInboxArrivals } from "../lib/inbox-arrivals.tsx";
import { useWakeTimer } from "../lib/wake-timer.ts";

const lists = [
  { list: "active", title: "Active" },
  { list: "snoozed", title: "Snoozed" },
  { list: "done", title: "Done" },
] as const;

function effectiveList(review: InboxItem, now: number) {
  return review.activeUntil !== null && new Date(review.activeUntil).getTime() <= now ? "done" : review.list;
}

type Kind = "" | "review" | "publish";
// A per-browser convenience: the inbox unmounts whenever a review opens.
const kindKey = "emend:inbox-kind";
function readKind(): Kind {
  try {
    const stored = localStorage.getItem(kindKey);
    return stored === "review" || stored === "publish" ? stored : "";
  } catch {
    return "";
  }
}

export function Inbox({
  compact = false,
  currentReviewId,
  hideHead = false,
  onCollapse,
  onOpen,
}: {
  compact?: boolean;
  currentReviewId?: string;
  hideHead?: boolean;
  onCollapse?: () => void;
  onOpen?: () => void;
}) {
  const query = useQuery(inboxQuery());
  const [filter, setFilter] = useState("");
  const [machine, setMachine] = useState("");
  const [project, setProject] = useState("");
  const [kind, setKindState] = useState<Kind>(readKind);
  const setKind = (next: Kind) => {
    setKindState(next);
    try {
      if (next) localStorage.setItem(kindKey, next);
      else localStorage.removeItem(kindKey);
    } catch {}
  };
  const [now, setNow] = useState(Date.now);
  const [doneOpen, setDoneOpen] = useState(false);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const items = query.data?.items ?? [];
  const wall = Date.now();
  const estimate = query.data ? serverNow(query.data, wall) : wall;
  const approvalWake = (review: InboxItem) =>
    review.activeUntil === null ? null : new Date(wall + (Date.parse(review.activeUntil) - estimate)).toISOString();
  const client = useQueryClient();
  // Snoozes and approval windows end without an event: ask again when either time passes.
  // Until the refetch lands, a passed snooze reads "waking up".
  useWakeTimer(
    items.flatMap((review) => [review.snoozedUntil, approvalWake(review)]),
    (passed) => {
      setNow(Date.now());
      void client.invalidateQueries({ queryKey: ["inbox"] });
      for (const review of items) {
        const activeUntil = approvalWake(review);
        if (
          (review.snoozedUntil && passed.includes(review.snoozedUntil)) ||
          (activeUntil && passed.includes(activeUntil))
        )
          void client.invalidateQueries({ queryKey: ["review", review.id] });
      }
    },
  );
  const origins = [...new Map(items.map(({ origin }) => [origin.id, origin])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const machineFilter =
    !compact && origins.length > 1 && origins.some((origin) => origin.id === machine) ? machine : "";
  const projects = [...new Set(items.flatMap((review) => (review.project === null ? [] : [review.project])))].sort(
    (a, b) => a.localeCompare(b),
  );
  const projectFilter = !compact && projects.length > 1 && projects.includes(project) ? project : "";
  const needle = filter.toLocaleLowerCase();
  const filtered = items.filter(
    (review) =>
      (!machineFilter || review.origin.id === machineFilter) &&
      (!projectFilter || review.project === projectFilter) &&
      // Keep the open sidebar review, and never hide an agent-waiting item under Reviews.
      (!kind ||
        review.kind === kind ||
        (kind === "review" && review.agentWaiting) ||
        (compact && review.id === currentReviewId)) &&
      [review.title, review.branch, review.origin.name, review.project].some((value) =>
        value?.toLocaleLowerCase().includes(needle),
      ),
  );
  const highlighted = useInboxArrivals(items);
  const Heading = compact ? "h3" : "h2";
  const attention = items.filter(needsAttention).length;
  return (
    <div className={compact ? "flex min-h-0 flex-1 flex-col" : "mx-auto w-full max-w-[760px] px-5 pt-8 pb-20"}>
      {!hideHead &&
        (compact ? (
          <div className="flex items-center justify-between pt-2.5 pr-2 pb-1.5 pl-4">
            <h2 className="text-13 font-medium leading-[1.2] text-fg-2">Inbox</h2>
            <IconButton label="Collapse inbox" icon={PanelLeftClose} size="sm" onClick={onCollapse} />
          </div>
        ) : (
          <div className="mb-4 flex flex-wrap items-baseline gap-x-3">
            <h1 className="text-24 font-semibold leading-(--lh-tight) tracking-(--tracking-tight)">Inbox</h1>
            {query.data && (
              <p className="mt-1 text-14 text-fg-3">
                {attention ? `${attention} ${plural(attention, "needs", "need")} you` : "Nothing needs you"} ·{" "}
                {origins.length} {plural(origins.length, "machine")}
              </p>
            )}
          </div>
        ))}
      <div className={compact ? "flex flex-col gap-2 px-2.5 pb-2" : "mb-3 flex flex-wrap items-center gap-2.5"}>
        <TextField
          aria-label="Filter reviews"
          placeholder="Filter by title, branch, machine, project"
          icon={Search}
          size="sm"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className={compact ? "min-w-0" : "min-w-0 flex-[1_1_16rem]"}
        />
        {items.length > 0 && (
          <SegmentedControl
            label="Kind"
            size="sm"
            className={compact ? "w-full [&>button]:flex-1 [&>button]:justify-center" : "max-w-full shrink-0"}
            value={kind}
            onChange={(value) => {
              if (value === "" || value === "review" || value === "publish") setKind(value);
            }}
            options={[
              { value: "", label: "All" },
              { value: "review", label: "Reviews" },
              { value: "publish", label: "Pubs" },
            ]}
          />
        )}
        {!compact && origins.length > 1 && (
          <Select
            aria-label="Machine"
            size="sm"
            className="min-w-0 max-w-full"
            value={machineFilter}
            onChange={(event) => setMachine(event.target.value)}
            options={[
              { value: "", label: "All machines" },
              ...origins.map((origin) => ({ value: origin.id, label: origin.name })),
            ]}
          />
        )}
        {!compact && projects.length > 1 && (
          <Select
            aria-label="Project"
            dir="auto"
            size="sm"
            className="min-w-0 max-w-full"
            value={projectFilter}
            onChange={(event) => setProject(event.target.value)}
            options={[{ value: "", label: "All projects" }, ...projects.map((name) => ({ value: name, label: name }))]}
          />
        )}
      </div>
      <div className={compact ? "relative min-h-0 flex-1 overflow-y-auto px-1.5 pt-1 pb-3" : "py-1"}>
        {query.isPending && (
          <p role="status" className="p-4">
            Loading reviews…
          </p>
        )}
        {query.isError && (
          <div className="p-4">
            <p role="alert">Could not load reviews.</p>
            <Button onClick={() => void query.refetch()}>Retry</Button>
          </div>
        )}
        {query.data && items.length === 0 && <p className="p-4 text-fg-3">No reviews yet.</p>}
        {items.length > 0 && filtered.length === 0 && (
          <div className="p-4">
            <p className="text-fg-3">No reviews match this filter.</p>
            <Button
              variant="ghost"
              onClick={() => {
                setFilter("");
                setMachine("");
                setProject("");
                setKind("");
              }}
            >
              Clear filter
            </Button>
          </div>
        )}
        {query.data &&
          items.length > 0 &&
          filtered.length > 0 &&
          lists.map(({ list, title }) => {
            const rows = filtered.filter((review) => effectiveList(review, estimate) === list);
            if (list === "done")
              rows.sort(
                (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
              );
            const nothingActive =
              list === "active" && !items.some((review) => effectiveList(review, estimate) === "active");
            if (rows.length === 0 && !nothingActive) return null;
            // A filter that matches only Done rows would otherwise show nothing.
            const expanded = list !== "done" || doneOpen || needle !== "";
            const heading = (
              <>
                {title}
                <span className="ml-1.5 font-normal tabular-nums text-fg-3">{rows.length}</span>
              </>
            );
            const headingClass =
              "m-0 px-2.5 pt-3 pb-1 font-mono text-11 font-medium leading-(--lh-snug) font-stretch-mono tracking-(--tracking-label) text-fg-3 uppercase";
            return (
              <section key={list} aria-label={title}>
                <Heading className={headingClass}>
                  {list === "done" && needle === "" ? (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-[inherit] text-[inherit] uppercase"
                      onClick={() => setDoneOpen(!doneOpen)}
                    >
                      <Icon icon={expanded ? ChevronDown : ChevronRight} size={12} />
                      {heading}
                    </button>
                  ) : (
                    heading
                  )}
                </Heading>
                {nothingActive && <p className="px-2.5 py-2 text-13 text-fg-3">No active reviews.</p>}
                {expanded && rows.length > 0 && (
                  <ul>
                    {rows.map((review) => (
                      <ReviewRow
                        key={review.id}
                        review={review}
                        now={now}
                        onOpen={onOpen}
                        highlight={highlighted.has(review.id)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
      </div>
    </div>
  );
}
export function InboxPage() {
  return (
    <AppFrame>
      <main className="relative min-h-0 flex-1 overflow-y-auto">
        <Inbox />
      </main>
    </AppFrame>
  );
}
