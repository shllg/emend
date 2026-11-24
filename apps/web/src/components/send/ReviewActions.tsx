import { type InboxGroup, LIMITS, type ReviewState } from "@recense/contract";
import { useQuery } from "@tanstack/react-query";
import {
  AlarmClock,
  Archive,
  BellOff,
  Ellipsis,
  FolderInput,
  Pin,
  PinOff,
  Terminal,
  Trash2,
  Undo2,
} from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client.ts";
import {
  type LifecycleAction,
  mutationMessage,
  useCreateGroup,
  useLifecycleMutation,
  useMoveToGroup,
  usePinReview,
} from "../../api/mutations.ts";
import { inboxQuery } from "../../api/queries.ts";
import { plural } from "../../lib/count.ts";
import { type SnoozeChoice, snoozeChoices, wakeTime } from "../../lib/time.ts";
import { useShortcut } from "../../lib/use-shortcut.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, type MenuItem } from "../ui/Menu.tsx";
import { TextField } from "../ui/TextField.tsx";
import { useToast } from "../ui/Toast.tsx";

export interface ReviewLifecycle {
  title: string;
  groupId: string | null;
  pinned: boolean;
  state: ReviewState;
  snoozed: boolean;
  snoozedUntil: string | null;
  /** Called after the server moved the review to the bin, before the toast. */
  onDeleted: () => void;
}

type Panel = "snooze" | "retire" | "delete" | "group" | null;
/** The discard button ignores presses this long after its label changed, so a late click cannot hit it. */
const DISCARD_GUARD_MS = 1000;

interface ReviewActionsOptions {
  reviewId: string;
  lifecycle: ReviewLifecycle;
  unsentCount: number;
  howToResume?: { disabled: boolean; onSelect: () => void };
}

export function useReviewActions({ reviewId, lifecycle, unsentCount, howToResume }: ReviewActionsOptions) {
  const { title, state, snoozed, pinned, onDeleted } = lifecycle;
  const [panel, setPanel] = useState<Panel>(null);
  const [now, setNow] = useState(Date.now);
  // Retire: the unsent count when the dialog opened, and whether the server refused for new comments.
  const [openedWith, setOpenedWith] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [guarded, setGuarded] = useState(false);
  const mutation = useLifecycleMutation(reviewId);
  const createGroup = useCreateGroup();
  const moveGroup = useMoveToGroup(reviewId);
  const pinReview = usePinReview(reviewId);
  const inbox = useQuery({ ...inboxQuery(), enabled: panel === "group" });
  const groups = [...(inbox.data?.groups ?? [])].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const [groupName, setGroupName] = useState("");
  const toast = useToast();
  const mounted = useRef(true);
  const busy = useRef(false);
  const deleted = useRef(false);
  const pending = mutation.isPending || createGroup.isPending || moveGroup.isPending || pinReview.isPending;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const open = (next: Exclude<Panel, null>) => {
    if (deleted.current || busy.current) return;
    setGroupName("");
    setNow(Date.now());
    setConflict(false);
    setOpenedWith(unsentCount);
    setPanel(next);
  };
  const close = () => {
    if (!busy.current) setPanel(null);
  };
  const togglePin = async () => {
    if (pending || busy.current || deleted.current) return;
    busy.current = true;
    try {
      await pinReview.mutateAsync(!pinned);
      toast.show({ tone: "success", title: pinned ? "Unpinned" : "Pinned" });
    } catch (error) {
      toast.show({ tone: "danger", title: mutationMessage(error as Error) });
    } finally {
      busy.current = false;
    }
  };
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
  const move = async (group: InboxGroup | null, create = false) => {
    if (busy.current || deleted.current || (create && !groupName.trim())) return;
    busy.current = true;
    try {
      const target = create ? await createGroup.mutateAsync(groupName) : group;
      await moveGroup.mutateAsync(target?.id ?? null);
      if (mounted.current) setPanel(null);
      const previous = groups.find((item) => item.id === lifecycle.groupId);
      toast.show({
        tone: "success",
        title: target
          ? `Moved to “${target.name}”`
          : previous
            ? `Removed from “${previous.name}”`
            : "Removed from group",
      });
    } catch (error) {
      toast.show({ tone: "danger", title: mutationMessage(error as Error) });
    } finally {
      busy.current = false;
    }
  };
  const items: MenuItem[] = [];
  if (howToResume)
    items.push(
      {
        label: "How to resume",
        icon: Terminal,
        opensDialog: true,
        disabled: howToResume.disabled,
        onSelect: howToResume.onSelect,
      },
      { separator: true },
    );
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
  items.push({ label: pinned ? "Unpin" : "Pin", icon: pinned ? PinOff : Pin, onSelect: () => void togglePin() });
  items.push({ label: "Move to group…", icon: FolderInput, opensDialog: true, onSelect: () => open("group") });
  items.push({ separator: true });
  items.push({ label: "Delete", icon: Trash2, danger: true, opensDialog: true, onSelect: () => open("delete") });
  return {
    items,
    pending,
    panel,
    open,
    close,
    togglePin,
    busy,
    deleted,
    lifecycle,
    unsentCount,
    now,
    inbox,
    groups,
    groupName,
    setGroupName,
    createGroup,
    moveGroup,
    move,
    snooze,
    retire,
    remove,
    discard,
    guarded,
    retireLabel,
    unsentAlert,
  };
}

export function ReviewActionDialogs({
  actions,
  returnFocus,
}: {
  actions: ReturnType<typeof useReviewActions>;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const {
    pending,
    panel,
    close,
    lifecycle,
    unsentCount,
    now,
    inbox,
    groups,
    groupName,
    setGroupName,
    createGroup,
    moveGroup,
    move,
    snooze,
    retire,
    remove,
    discard,
    guarded,
    retireLabel,
    unsentAlert,
  } = actions;
  const { title } = lifecycle;
  const cancel = (
    <Button data-autofocus disabled={pending} onClick={close}>
      Cancel
    </Button>
  );
  return (
    <>
      <Dialog
        open={panel === "group"}
        returnFocus={returnFocus}
        onOpenChange={(next) => !next && close()}
        title={
          <>
            Move “<bdi>{title}</bdi>” to a group
          </>
        }
        titleClassName="[overflow-wrap:anywhere]"
        description="It stays in the group until you move it out. New revisions keep it there."
        actions={cancel}
      >
        <div className="mt-3 flex flex-col gap-1.5">
          {inbox.isPending && <p role="status">Loading groups…</p>}
          {inbox.isError && (
            <>
              <p role="alert">Could not load groups.</p>
              <Button onClick={() => void inbox.refetch()}>Retry</Button>
            </>
          )}
          {groups.map((group) => (
            <Button
              key={group.id}
              fullWidth
              className="justify-between"
              disabled={pending || group.id === lifecycle.groupId}
              onClick={() => void move(group)}
            >
              <span dir="auto" className="min-w-0 truncate" title={group.name}>
                {group.name}
              </span>
              {group.id === lifecycle.groupId && <span className="shrink-0 text-fg-3">Current</span>}
            </Button>
          ))}
          {lifecycle.groupId && (
            <Button fullWidth disabled={pending} onClick={() => void move(null)}>
              Remove from group
            </Button>
          )}
          {inbox.data &&
            (groups.length >= LIMITS.groups ? (
              <p className="text-13 text-fg-3">You have the most groups allowed.</p>
            ) : (
              <form
                className="mt-3 flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void move(null, true);
                }}
              >
                <TextField
                  label="New group"
                  dir="auto"
                  value={groupName}
                  maxLength={LIMITS.groupNameChars}
                  disabled={pending}
                  onChange={(event) => setGroupName(event.target.value)}
                />
                <Button
                  type="submit"
                  disabled={pending || !groupName.trim()}
                  loading={createGroup.isPending || moveGroup.isPending}
                >
                  Create and move
                </Button>
              </form>
            ))}
        </div>
      </Dialog>
      <Dialog
        open={panel === "snooze"}
        returnFocus={returnFocus}
        onOpenChange={(next) => !next && close()}
        title="Snooze this review"
        description={
          lifecycle.groupId !== null
            ? "It stays in its group, snoozed until then. A new revision wakes it early."
            : "It leaves your active list until then. A new revision wakes it early."
        }
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
        returnFocus={returnFocus}
        onOpenChange={(next) => !next && close()}
        title="Retire this review?"
        description={
          <>
            {lifecycle.groupId !== null
              ? "It stays in its group, closed without an approval, and an agent waiting on it stops."
              : "It moves to Done without an approval, and an agent waiting on it stops."}
            {discard && ` Its ${unsentCount} unsent ${plural(unsentCount, "comment")} will be deleted.`}
          </>
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
        returnFocus={returnFocus}
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

/** The "More review actions" menu beside Approve, and the dialogs it opens. */
export function ReviewActions({ phone, ...options }: ReviewActionsOptions & { phone: boolean }) {
  const actions = useReviewActions(options);
  const { pending, busy, deleted, open, togglePin } = actions;
  const { state } = options.lifecycle;
  const trigger = useRef<HTMLButtonElement>(null);
  useShortcut(
    "review.snooze",
    () => {
      if (state !== "open" || pending || busy.current || deleted.current) return false;
      open("snooze");
      return true;
    },
    { enabled: state === "open" && !pending },
  );
  useShortcut(
    "review.pin",
    () => {
      if (pending || busy.current || deleted.current) return false;
      void togglePin();
      return true;
    },
    { enabled: !pending },
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
        items={actions.items}
      />
      <ReviewActionDialogs actions={actions} returnFocus={trigger} />
    </>
  );
}
