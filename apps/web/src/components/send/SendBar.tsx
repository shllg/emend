import { DEFAULT_MODE, type GoMode, LIMITS } from "@recense/contract";
import { Check, Pencil, Send } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { mutationMessage, useReviewMutation } from "../../api/mutations.ts";
import { plural } from "../../lib/count.ts";
import {
  beginReviewSend,
  clearDraft,
  clearDraftIfUnchanged,
  finishReviewSend,
  instructionKey,
  isReviewDraftSaving,
  isReviewSending,
  listDrafts,
  loadDraft,
  saveDraft,
  subscribeDrafts,
} from "../../lib/drafts.ts";
import { openHandoffNotice, type SendBaseline, useHandoffNotice } from "../../lib/handoff-notices.ts";
import { useReadOnlyReview } from "../../lib/read-only-review.ts";
import { useShortcut } from "../../lib/use-shortcut.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { inputClass, inputSizes } from "../ui/field.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { useToast } from "../ui/Toast.tsx";
import { cn, focusRing } from "../ui/utils.ts";
import { agentStatusText, HandOverNote, ResumeDialog, type SendAgent, SentNotice, showsHandOver } from "./HandOver.tsx";
import { ModePicker } from "./ModePicker.tsx";
import { ReviewActions, type ReviewLifecycle } from "./ReviewActions.tsx";

export function SendBar({
  reviewId,
  revision,
  newestRevision,
  revisionError = false,
  unsentCount,
  approved = false,
  lifecycle,
  agent,
  phone = false,
}: {
  reviewId: string;
  revision: number | undefined;
  newestRevision: number;
  revisionError?: boolean;
  unsentCount: number;
  approved?: boolean;
  /** Snooze, retire and delete. Without it the bar has no actions menu. */
  lifecycle?: ReviewLifecycle;
  /** Whether an agent waits, and when one last picked up or was released. Without it the bar says nothing about the agent. */
  agent?: SendAgent;
  phone?: boolean;
}) {
  const readOnly = useReadOnlyReview();
  const [mode, setMode] = useState<GoMode>(DEFAULT_MODE);
  const storageKey = instructionKey(reviewId);
  const instruction = useSyncExternalStore(subscribeDrafts, () => (readOnly ? "" : loadDraft(storageKey)));
  const unsavedCount = useSyncExternalStore(subscribeDrafts, () => (readOnly ? 0 : listDrafts(reviewId).length));
  const commentSaving = useSyncExternalStore(subscribeDrafts, () => isReviewDraftSaving(reviewId));
  const reviewSending = useSyncExternalStore(subscribeDrafts, () => isReviewSending(reviewId));
  const shortcut = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘↵" : "Ctrl ↵";
  const [sheetOpen, setSheetOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const submitting = useRef(false);
  const approveTrigger = useRef<HTMLButtonElement>(null);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const agentNow = useRef(agent);
  useLayoutEffect(() => {
    agentNow.current = agent;
  });
  const sendTrigger = useRef<HTMLButtonElement>(null);
  const notice = useHandoffNotice(reviewId);
  const desktopInstructions = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = desktopInstructions.current;
    if (!field || phone) return;
    field.style.height = "";
    if (!instruction || CSS.supports?.("field-sizing", "content")) return;
    field.style.height = "auto";
    const styles = getComputedStyle(field);
    const border = (Number.parseFloat(styles.borderTopWidth) || 0) + (Number.parseFloat(styles.borderBottomWidth) || 0);
    field.style.height = `${field.scrollHeight + border}px`;
  }, [instruction, phone]);
  const focusDesktop = useRef(false);
  const sheetFormRef = useCallback((node: HTMLFormElement | null) => {
    if (!node) return;
    const dialog = node.closest('[role="dialog"]');
    // Capture focus before removing the portal, when activeElement still names its control.
    return () => {
      focusDesktop.current = dialog?.contains(document.activeElement) ?? false;
    };
  }, []);
  const mutation = useReviewMutation(reviewId);
  const sending = mutation.isPending || reviewSending;
  useEffect(() => {
    if (phone) {
      focusDesktop.current = false;
      return;
    }
    if (sheetOpen) setSheetOpen(false);
    const field = desktopInstructions.current;
    if (focusDesktop.current && field && !sending) {
      focusDesktop.current = false;
      if (document.activeElement === document.body) field.focus();
    }
  }, [phone, sheetOpen, sending]);
  const toast = useToast();
  const formId = useId();
  const blocked = useId();
  const sendReasonId = useId();
  const sendCountId = useId();
  const revisionStatus = useId();
  const olderReasonId = useId();
  const retired = lifecycle?.state === "settled";
  const showNote = showsHandOver({ approved, retired, releasedAt: agent?.releasedAt ?? null });
  const canResume = !phone && showNote && !!agent && !agent.agentWaiting;
  // A menu item runs its handler after the menu closes, and the bar can stop offering
  // "How to resume" while the dialog is open.
  useEffect(() => {
    if (resumeOpen && !canResume) setResumeOpen(false);
  }, [resumeOpen, canResume]);
  const unavailable =
    revision === undefined ? (revisionError ? "Could not load this revision." : "Loading revision…") : undefined;
  const olderReason =
    revision !== undefined && revision < newestRevision
      ? `Revision ${newestRevision} is newer. Switch to it to send or approve.`
      : undefined;
  const disabled =
    readOnly || sending || commentSaving || unsavedCount > 0 || revision === undefined || !!olderReason || retired;
  const approveDisabled = disabled || unsentCount > 0 || approved;
  const instructionsDisabled = readOnly || sending;
  useShortcut(
    "review.instructions",
    () => {
      const field = desktopInstructions.current;
      if (!field || field.disabled) return false;
      field.focus();
      return true;
    },
    { enabled: !instructionsDisabled },
  );
  useShortcut(
    "review.approve",
    () => {
      const button = approveTrigger.current;
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    { enabled: !approveDisabled },
  );
  const approveBlocked = unsentCount > 0 && !approved && !retired;
  // When approving stops being possible (a newer revision, comments, another tab, a retirement) the
  // dialog's Approve would do nothing: close it and let the bar show its usual reason.
  const cannotApprove =
    commentSaving ||
    unsavedCount > 0 ||
    revision === undefined ||
    !!olderReason ||
    retired ||
    unsentCount > 0 ||
    approved;
  useEffect(() => {
    if (!confirmApprove || !cannotApprove || sending) return;
    if (approved) setApprovedHere(true);
    setConfirmApprove(false);
  }, [confirmApprove, cannotApprove, sending, approved]);
  const statusRef = useRef<HTMLDivElement>(null);
  const noticeReturnFocus = useCallback(() => {
    const control = desktopInstructions.current ?? sendTrigger.current;
    return control && !control.disabled ? control : statusRef.current;
  }, []);
  // After this dialog's approval the trigger is disabled: focus goes to the bar's status, not to the
  // page. Set in the same update that closes the dialog, because the cached `approved` arrives later.
  const [approvedHere, setApprovedHere] = useState(false);
  const unsavedReason = unsavedCount
    ? unsavedCount === 1
      ? "1 unsaved comment: save or discard it first."
      : `${unsavedCount} unsaved comments: save or discard them first.`
    : undefined;
  const retiredReason = retired ? "This review is retired. Reopen it to send or approve." : undefined;
  const sendReason =
    (readOnly ? "This is a sample. Nothing is sent." : undefined) ??
    retiredReason ??
    unsavedReason ??
    (instruction.length > LIMITS.instructionChars
      ? `Shorten the instructions to ${LIMITS.instructionChars} characters.`
      : unsentCount === 0 && !instruction.trim()
        ? "Write a comment or an instruction first."
        : undefined);
  const commentCount = `${unsentCount} ${plural(unsentCount, "comment")}`;
  const changeInstruction = (value: string) => {
    if (readOnly) return;
    if (!submitting.current) mutation.reset();
    if (value) saveDraft(storageKey, value);
    else clearDraft(storageKey);
  };
  const changeMode = (value: GoMode) => {
    if (!submitting.current) mutation.reset();
    setMode(value);
  };
  const submit = async (kind: "go" | "approve") => {
    if (
      submitting.current ||
      disabled ||
      listDrafts(reviewId).length > 0 ||
      isReviewDraftSaving(reviewId) ||
      isReviewSending(reviewId) ||
      (kind === "go" ? !!sendReason : unsentCount > 0 || approved)
    )
      return;
    if (!beginReviewSend(reviewId)) return;
    submitting.current = true;
    // Read at click time, before the request: the mutation's own refetch may change these while it
    // runs, and "picked up" must compare against what the reader saw when they pressed Send.
    const atSend: SendBaseline = {
      waited: agentNow.current?.agentWaiting ?? false,
      pickedUpAt: agentNow.current?.pickedUpAt ?? null,
      newestRevision: agentNow.current?.newestRevision ?? 0,
    };
    try {
      await mutation.mutateAsync({
        path: `/api/v1/reviews/${encodeURIComponent(reviewId)}/sends`,
        body: kind === "approve" ? { revision, kind } : { revision, kind, mode, instruction },
        // The server's answer finishes a Send; the refetch lands after and may be slow.
        refresh: "background",
        accepted: { kind: kind === "approve" ? "approve" : "send", revision },
      });
      if (kind === "go") {
        clearDraftIfUnchanged(storageKey, instruction);
        openHandoffNotice(reviewId, atSend);
      }
      if (!mounted.current) return;
      if (kind === "go") {
        setSheetOpen(false);
      } else {
        setApprovedHere(true);
        setConfirmApprove(false);
        toast.show({ tone: "success", title: `Approved revision ${revision}` });
      }
    } catch {
      // The mutation retains the error for the inline alert.
    } finally {
      if (kind === "go" && desktopInstructions.current) focusDesktop.current = true;
      submitting.current = false;
      finishReviewSend(reviewId);
    }
  };
  const feedback = mutation.error && (
    <p role="alert" className="m-0 text-13 text-danger-fg">
      {mutationMessage(mutation.error)}
    </p>
  );
  const reason = sendReason && (
    <span id={sendReasonId} className="text-fg-3 [font:var(--type-meta)]">
      {sendReason}
    </span>
  );
  const olderMessage = olderReason && <span id={olderReasonId}>{olderReason}</span>;
  const describedBy =
    [unavailable && revisionStatus, sendReason && sendReasonId, olderReason && olderReasonId]
      .filter(Boolean)
      .join(" ") || undefined;
  const approvalReason = <span id={blocked}>Send or delete before approving</span>;
  const approveButton = (
    <Button
      ref={approveTrigger}
      variant="approve"
      size={phone ? "lg" : "md"}
      icon={Check}
      disabled={approveDisabled}
      title={
        phone
          ? undefined
          : [
              approveBlocked && "Send or delete before approving",
              retiredReason ?? unsavedReason,
              unavailable,
              olderReason,
            ]
              .filter(Boolean)
              .join(" ") || undefined
      }
      aria-describedby={
        [
          approveBlocked && blocked,
          (unsavedReason || retiredReason) && sendReasonId,
          unavailable && revisionStatus,
          olderReason && olderReasonId,
        ]
          .filter(Boolean)
          .join(" ") || undefined
      }
      onClick={() => {
        // Approving asks first: nothing is sent until the dialog's Approve is pressed.
        if (submitting.current) return;
        mutation.reset();
        setApprovedHere(false);
        setConfirmApprove(true);
      }}
    >
      {approved ? "Approved" : phone || revision === undefined ? "Approve" : `Approve revision ${revision}`}
    </Button>
  );
  const actions = !readOnly && lifecycle && (
    <ReviewActions
      reviewId={reviewId}
      lifecycle={lifecycle}
      unsentCount={unsentCount}
      phone={phone}
      howToResume={
        !phone && agent ? { disabled: !canResume || sending, onSelect: () => setResumeOpen(true) } : undefined
      }
    />
  );
  const status = (
    <div
      ref={statusRef}
      tabIndex={-1}
      className={cn("flex min-w-0 flex-col gap-0.5 outline-none", phone && "flex-1 overflow-hidden")}
    >
      <span className="flex items-center gap-1.5 whitespace-nowrap text-13 font-semibold leading-[1.2] text-fg-1">
        {unsentCount > 0 && (
          <span
            aria-hidden={phone ? undefined : true}
            className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-[5px] text-[10.5px] font-semibold tabular-nums text-accent-fg"
          >
            {unsentCount}
          </span>
        )}
        {unsentCount > 0 && " "}
        {phone
          ? unsentCount > 0
            ? "to send"
            : "Nothing to send"
          : unsentCount > 0
            ? `${unsentCount} unsent ${plural(unsentCount, "comment")}`
            : "No unsent comments"}
      </span>
      {phone ? (
        <span className="text-fg-3 [font:var(--type-meta)]">{revision !== undefined && `Revision ${revision}`}</span>
      ) : (
        showNote &&
        agent && (
          <span className="text-fg-3 [font:var(--type-meta)]">
            {agentStatusText(agent)}
            {canResume && (
              <>
                {" · "}
                <button
                  type="button"
                  disabled={sending}
                  className={cn(
                    "border-0 bg-transparent p-0 text-(--fg-link) underline decoration-1 underline-offset-2 [font:inherit] enabled:hover:text-(--fg-link-hover) disabled:cursor-not-allowed disabled:opacity-48",
                    focusRing,
                  )}
                  onClick={() => setResumeOpen(true)}
                >
                  How to resume
                </button>
              </>
            )}
          </span>
        )
      )}
    </div>
  );
  return (
    <section aria-label="Send and approve" className="shrink-0 border-t border-line-1 bg-surface">
      {notice && (
        <SentNotice
          key={notice.id}
          reviewId={reviewId}
          entry={notice}
          agent={
            agent ?? { agentWaiting: false, pendingSend: true, pickedUpAt: null, releasedAt: null, newestRevision: 0 }
          }
          phone={phone}
          returnFocus={noticeReturnFocus}
        />
      )}
      {readOnly && <p className="px-4 pt-2 text-13 text-fg-3">This is a sample. Nothing is sent.</p>}
      {phone ? (
        <div className="flex min-h-13 flex-nowrap items-center gap-[0.625rem] py-1.5 pr-[0.625rem] pl-[0.875rem]">
          {/* This row fills the phone width exactly, so density changes only its height. */}
          {status}
          <div className="flex shrink-0 flex-nowrap items-center gap-[0.375rem] [&>*]:shrink-0">
            {actions}
            {approveButton}
            <Sheet
              side="bottom"
              title="Send feedback"
              open={sheetOpen}
              onOpenChange={(open) => {
                if (open && !submitting.current) mutation.reset();
                setSheetOpen(open);
              }}
              trigger={
                <Button
                  ref={sendTrigger}
                  variant="primary"
                  size="lg"
                  icon={Send}
                  disabled={disabled}
                  loading={sending}
                  aria-describedby={
                    [
                      unavailable && revisionStatus,
                      (unsavedReason || retiredReason) && sendReasonId,
                      olderReason && olderReasonId,
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                >
                  Send
                </Button>
              }
              footer={
                <div className="flex w-full flex-col gap-2">
                  {reason}
                  {olderReason && <p className="m-0 text-fg-3 [font:var(--type-meta)]">{olderMessage}</p>}
                  {unavailable && (
                    <p
                      id={revisionStatus}
                      role={revisionError ? "alert" : "status"}
                      className="m-0 text-fg-3 [font:var(--type-meta)]"
                    >
                      {unavailable}
                    </p>
                  )}
                  {feedback}
                  <Button
                    type="submit"
                    form={formId}
                    variant="primary"
                    size="lg"
                    fullWidth
                    icon={Send}
                    disabled={disabled || !!sendReason}
                    loading={sending}
                    aria-describedby={describedBy}
                  >
                    {unsentCount > 0
                      ? `Send ${commentCount} on revision ${revision ?? "…"}`
                      : `Send instructions on revision ${revision ?? "…"}`}
                  </Button>
                </div>
              }
            >
              <form
                ref={sheetFormRef}
                id={formId}
                className="space-y-4"
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    event.target instanceof HTMLInputElement &&
                    event.target.type === "radio"
                  )
                    event.preventDefault();
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit("go");
                }}
              >
                <ModePicker cards value={mode} onChange={changeMode} disabled={sending || readOnly} />
                <Textarea
                  label="Instructions"
                  placeholder="Optional. Applies to every comment in this Send."
                  rows={2}
                  maxLength={LIMITS.instructionChars}
                  disabled={sending}
                  value={instruction}
                  onChange={(event) => changeInstruction(event.target.value)}
                />
                {showNote && agent && <HandOverNote reviewId={reviewId} agent={agent} lifecycle={lifecycle} />}
              </form>
            </Sheet>
          </div>
        </div>
      ) : (
        <form
          className="flex min-h-(--sendbar-h) items-center gap-2.5 py-2 pr-3 pl-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit("go");
          }}
        >
          {status}
          <div className="flex min-w-0 flex-1 justify-end gap-2">
            <div className="relative flex min-w-0 max-w-[520px] flex-1 items-center">
              <Icon icon={Pencil} size={14} className="pointer-events-none absolute left-[9px] text-fg-3" />
              <textarea
                ref={desktopInstructions}
                aria-label="Instructions"
                rows={1}
                enterKeyHint="enter"
                placeholder="Instructions for the agent (optional)"
                className={cn(
                  inputClass,
                  inputSizes.sm,
                  "h-[1.75rem] min-h-[1.75rem] max-h-32 resize-none overflow-y-auto py-[3px] pl-[30px] leading-[1.25rem]",
                  instruction && "h-auto [field-sizing:content]",
                )}
                maxLength={LIMITS.instructionChars}
                disabled={instructionsDisabled}
                value={instruction}
                onChange={(event) => changeInstruction(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" ||
                    !(event.metaKey || event.ctrlKey) ||
                    event.nativeEvent.isComposing ||
                    event.keyCode === 229
                  )
                    return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
              />
              <kbd className="ml-1.5 shrink-0 text-fg-3 [font:var(--type-meta)]">{shortcut}</kbd>
            </div>
            <ModePicker value={mode} onChange={changeMode} disabled={sending || readOnly} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            {approveButton}
            {unsentCount > 0 && (
              <span id={sendCountId} className="tabular-nums text-fg-3 [font:var(--type-meta)]">
                {unsentCount} to send
              </span>
            )}
            <Button
              type="submit"
              variant="primary"
              icon={Send}
              disabled={disabled || !!sendReason}
              loading={sending}
              aria-describedby={[describedBy, unsentCount > 0 && sendCountId].filter(Boolean).join(" ") || undefined}
              title={[unavailable, sendReason, olderReason].filter(Boolean).join(" ") || undefined}
            >
              Send
            </Button>
          </div>
          <div hidden>
            {approveBlocked && approvalReason}
            {reason}
            {olderMessage}
          </div>
        </form>
      )}
      {!phone && agent && (
        <ResumeDialog
          reviewId={reviewId}
          agent={agent}
          lifecycle={lifecycle}
          open={resumeOpen}
          onOpenChange={setResumeOpen}
          returnFocus={statusRef}
        />
      )}
      <Dialog
        open={confirmApprove}
        returnFocus={approvedHere ? statusRef : approveTrigger}
        preferReturnFocus={approvedHere}
        onOpenChange={(open) => {
          if (!open && !sending) setConfirmApprove(false);
        }}
        title={revision === undefined ? "Approve this revision?" : `Approve revision ${revision}?`}
        description={`The agent receives the approval, now if one is waiting and otherwise when it next picks up. The review ${lifecycle?.groupId ? "stays in its group" : "moves to Done"}.`}
        actions={
          <>
            <Button data-autofocus disabled={sending} onClick={() => setConfirmApprove(false)}>
              Cancel
            </Button>
            <Button variant="approve" loading={sending} onClick={() => void submit("approve")}>
              Approve
            </Button>
          </>
        }
      >
        {feedback && <div className="mt-2">{feedback}</div>}
      </Dialog>
      {(!phone || !sheetOpen) &&
        (unavailable ||
          (phone && (approveBlocked || olderReason || unsavedReason || retiredReason)) ||
          (mutation.error && !confirmApprove)) && (
          <div className="space-y-1 px-4 pb-2">
            {unavailable && (
              <p
                id={revisionStatus}
                role={revisionError ? "alert" : "status"}
                className="m-0 text-fg-3 [font:var(--type-meta)]"
              >
                {unavailable}
              </p>
            )}
            {phone && approveBlocked && <p className="m-0 text-fg-3 [font:var(--type-meta)]">{approvalReason}</p>}
            {phone && (unsavedReason || retiredReason) && reason}
            {phone && olderReason && <p className="m-0 text-fg-3 [font:var(--type-meta)]">{olderMessage}</p>}
            {!confirmApprove && feedback}
          </div>
        )}
    </section>
  );
}
