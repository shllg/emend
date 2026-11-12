import type { ReviewView } from "@emend/contract";
import { ChevronDown } from "lucide-react";
import { relativeTime } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";
import { Menu } from "../ui/Menu.tsx";
import { cn } from "../ui/utils.ts";

export function RevisionPicker({
  review,
  seq,
  onChange,
  compact = false,
}: {
  review: ReviewView;
  seq: number;
  onChange: (seq: number) => void;
  /** Phone: the button shows only the numbers, and never shrinks or wraps. */
  compact?: boolean;
}) {
  const latest = review.newestRevision;
  const older = seq < latest;
  const now = Date.now();
  return (
    <Menu
      label={older ? `Revision ${seq}, ${latest} is newer` : `Revision ${seq} of ${latest}`}
      align="left"
      trigger={
        <Button
          size="sm"
          iconRight={ChevronDown}
          className={cn("gap-1.5 pr-1.5 leading-none shadow-none", compact && "shrink-0 whitespace-nowrap")}
        >
          {compact ? (
            older ? (
              <span className="font-semibold text-warning-fg">
                {seq} of {latest}
              </span>
            ) : (
              <>
                <span className="font-mono text-11 font-semibold font-stretch-mono">{seq}</span>{" "}
                <span className="text-fg-3">of {latest}</span>
              </>
            )
          ) : (
            <>
              Revision <span className="font-mono text-11 font-semibold font-stretch-mono">{seq}</span>
              {older ? (
                <span className="font-semibold text-warning-fg">· {latest} is newer</span>
              ) : (
                <span className="text-fg-3">of {latest}</span>
              )}
            </>
          )}
        </Button>
      }
      items={[
        {
          radioGroup: {
            value: String(seq),
            onValueChange: (value) => onChange(Number(value)),
            items: [...review.revisions]
              .sort((a, b) => b.seq - a.seq)
              .map((revision) => ({
                value: String(revision.seq),
                label: (
                  <>
                    Revision {revision.seq}
                    {revision.seq === latest && (
                      <span className="inline-flex h-4 shrink-0 items-center rounded-xs bg-accent px-[5px] text-[9.5px] font-semibold leading-none tracking-[.04em] text-accent-fg uppercase">
                        Latest
                      </span>
                    )}
                  </>
                ),
                hint: relativeTime(revision.createdAt, now),
              })),
          },
        },
      ]}
    />
  );
}
