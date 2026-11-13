import type { ReviewState } from "@emend/contract";
import { AlarmClock, Archive, BellOff, Ellipsis, Trash2, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { type LifecycleAction, mutationMessage, useLifecycleMutation } from "../../api/mutations.ts";
import { plural } from "../../lib/count.ts";
import { type SnoozeChoice, snoozeChoices, wakeTime } from "../../lib/time.ts";
import { useShortcut } from "../../lib/use-shortcut.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, type MenuItem } from "../ui/Menu.tsx";
import { useToast } from "../ui/Toast.tsx";

export interface ReviewLifecycle {
  title: string;
  state: ReviewState;
  snoozed: boolean;
  snoozedUntil: string | null;
  /** Called after the server moved the review to the bin, before the toast. */
  onDeleted: () => void;
}

type Panel = "snooze" | "retire" | "delete" | null;
/** The discard button ignores presses this long after its label changed, so a late click cannot hit it. */
const DISCARD_GUARD_MS = 1000;

/** The "More review actions" menu beside Approve, and the dialogs it opens. */
export function ReviewActions({
  reviewId,
  lifecycle,
  unsentCount,
  phone,
}: {
  reviewId: string;
  lifecycle: ReviewLifecycle;
  unsentCount: number;
  phone: boolean;
}) {
  const { title, state, snoozed, onDeleted } = lifecycle;
  const [panel, setPanel] = useState<Panel>(null);
  const [now, setNow] = useState(Date.now);
  // Retire: the unsent count when the dialog opened, and whether the server refused for new comments.
  const [openedWith, setOpenedWith] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [guarded, setGuarded] = useState(false);
  const mutation = useLifecycleMutation(reviewId);
  const toast = useToast();
  const trigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const deleted = useRef(false);
  const pending = mutation.isPending;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const open = (next: Exclude<Panel, null>) => {
    if (deleted.current) return;
    setNow(Date.now());
    setConflict(false);
    setOpenedWith(unsentCount);
    setPanel(next);
  };
  const close = () => {
    if (!busy.current) setPanel(null);
  };
  useShortcut(
    "review.snooze",
    () => {
      if (state !== "open" || pending || busy.current || deleted.current) return false;
      open("snooze");
      return true;
    },
    { enabled: state === "open" && !pending },
  );
  /** Returns whether the server accepted the action. A failure shows the server's message in a toast. */
  const run = async (input: LifecycleAction) => {
    if (busy.current || deleted.current) return false;
    busy.current = true;
    try {
      await mutation.mutateAsync(input);
      if (input.action === "bin") {
        // Done: close at once, and every later press is a no-op.
        deleted.current = true;
        if (mounted.current) setPanel(null);
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "unsent_comments" && input.action === "retire") {
        if (mounted.current) setConflict(true);
      } else toast.show({ tone: "danger", title: mutationMessage(error as Error) });
      return false;
    } finally {
      busy.current = false;
    }
  };
  const snooze = async (choice: SnoozeChoice) => {
    const when = choice.id === "revision" ? undefined : choice.until;
    const ok = await run({ action: "snooze", body: when ? { until: when.toISOString() } : { untilRevision: true } });
    if (!ok) return;
    if (mounted.current) setPanel(null);
    toast.show({
      tone: "success",
      title: when ? `Snoozed until ${wakeTime(when, Date.now())}` : "Snoozed until it changes",
    });
  };
  const unsnooze = async () => {
    if (await run({ action: "unsnooze" })) toast.show({ tone: "success", title: "Review unsnoozed" });
  };
  const reopen = async () => {
    if (await run({ action: "reopen" })) toast.show({ tone: "success", title: "Review reopened" });
  };
  const discard = unsentCount > 0;
  const added = unsentCount - openedWith;
  const unsentAlert =
    added > 0
      ? `${added} new unsent ${plural(added, "comment")} arrived.`
      : conflict
        ? "New unsent comments arrived."
        : added < 0
          ? "Some unsent comments were sent or deleted."
          : null;
  const retireLabel = discard ? `Discard ${unsentCount} unsent ${plural(unsentCount, "comment")} and retire` : "Retire";
  // A press aimed at the old label must not land on the new one.
  const shownLabel = useRef<string | null>(null);
  useEffect(() => {
    if (panel !== "retire") {
      shownLabel.current = null;
      setGuarded(false);
      return;
    }
    const changed = shownLabel.current !== null && shownLabel.current !== retireLabel;
    shownLabel.current = retireLabel;
    if (!changed) return;
    setGuarded(true);
    const timer = setTimeout(() => setGuarded(false), DISCARD_GUARD_MS);
    return () => clearTimeout(timer);
  }, [panel, retireLabel]);
  const retire = async () => {
    if (guarded) return;
    const ok = await run({ action: "retire", body: discard ? { discardUnsent: true } : {} });
    if (!ok) return;
    if (mounted.current) setPanel(null);
    toast.show({ tone: "success", title: "Review retired" });
  };
  const remove = async () => {
    if (!(await run({ action: "bin" }))) return;
    onDeleted();
    toast.show({ tone: "success", title: `Moved “${title}” to the bin` });
  };
  const items: MenuItem[] = [];
  if (state === "open") {
    items.push({
      label: snoozed ? "Snooze again" : "Snooze",
      icon: AlarmClock,
      opensDialog: true,
      onSelect: () => open("snooze"),
    });
    if (snoozed) items.push({ label: "Unsnooze", icon: BellOff, onSelect: () => void unsnooze() });
    items.push({ label: "Retire", icon: Archive, opensDialog: true, onSelect: () => open("retire") });
  }
  if (state === "settled") items.push({ label: "Reopen", icon: Undo2, onSelect: () => void reopen() });
  if (items.length > 0) items.push({ separator: true });
  items.push({ label: "Delete", icon: Trash2, danger: true, opensDialog: true, onSelect: () => open("delete") });
  const cancel = (
    <Button data-autofocus disabled={pending} onClick={close}>
      Cancel
    </Button>
  );
  return (
    <>
      <Menu
        label="More review actions"
        size={phone ? "lg" : "md"}
        triggerRef={trigger}
        trigger={
          // aria-disabled, not disabled: the trigger keeps keyboard focus while an action runs.
          <IconButton
            label="More review actions"
            icon={Ellipsis}
            size={phone ? "lg" : "md"}
            tooltip={false}
            aria-disabled={pending}
            aria-busy={pending}
            onPointerDown={(event) => pending && event.preventDefault()}
            onKeyDown={(event) => {
              // Only the keys that open the menu; Tab and the rest still work.
              if (pending && [" ", "Enter", "ArrowDown", "ArrowUp"].includes(event.key)) event.preventDefault();
            }}
          />
        }
        items={items}
      />
      <Dialog
        open={panel === "snooze"}
        returnFocus={trigger}
        onOpenChange={(next) => !next && close()}
        title="Snooze this review"
        description="It leaves your active list until then. A new revision wakes it early."
        actions={cancel}
      >
        <div className="mt-3 flex flex-col gap-1.5">
          {snoozeChoices(new Date(now)).map((choice) => (
            <Button
              key={choice.id}
              fullWidth
              disabled={pending}
              className="justify-start"
              onClick={() => void snooze(choice)}
            >
              <span>{choice.label}</span>
              {choice.id !== "revision" && (
                <span className="font-normal text-fg-3"> · {wakeTime(choice.until, now)}</span>
              )}
            </Button>
          ))}
        </div>
      </Dialog>
      <Dialog
        open={panel === "retire"}
        returnFocus={trigger}
        onOpenChange={(next) => !next && close()}
        title="Retire this review?"
        description={
          discard
            ? `It moves to Done without an approval, and an agent waiting on it stops. Its ${unsentCount} unsent ${plural(unsentCount, "comment")} will be deleted.`
            : "It moves to Done without an approval, and an agent waiting on it stops."
        }
        actions={
          <>
            {cancel}
            <Button
              variant={discard ? "danger" : "primary"}
              loading={pending}
              aria-disabled={guarded || undefined}
              onClick={() => void retire()}
            >
              {retireLabel}
            </Button>
          </>
        }
      >
        {unsentAlert && (
          <p role="alert" className="m-0 mt-2 text-13 text-danger-fg">
            {unsentAlert}
          </p>
        )}
      </Dialog>
      <Dialog
        open={panel === "delete"}
        returnFocus={trigger}
        onOpenChange={(next) => !next && close()}
        title={`Delete “${title}”?`}
        description="It moves to the bin in Settings, where you can restore it or delete it for good. It leaves the inbox, and an agent waiting on it stops."
        actions={
          <>
            {cancel}
            <Button variant="danger" loading={pending} onClick={() => void remove()}>
              Move to bin
            </Button>
          </>
        }
      />
    </>
  );
}
