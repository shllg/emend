import {
  ApprovedActiveHours,
  type BinItem,
  type HoursSetting,
  MAX_APPROVED_ACTIVE_HOURS,
  SettingsView,
} from "@emend/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { change, patch } from "../api/client.ts";
import { mutationMessage } from "../api/mutations.ts";
import { binQuery, settingsQuery } from "../api/queries.ts";
import { AppFrame } from "../components/layout/AppFrame.tsx";
import { Button } from "../components/ui/Button.tsx";
import { Dialog } from "../components/ui/Dialog.tsx";
import { TextField } from "../components/ui/TextField.tsx";
import { useToast } from "../components/ui/Toast.tsx";
import { plural } from "../lib/count.ts";
import { relativeTime } from "../lib/time.ts";

const hours = (value: number) => `${value} ${value === 1 ? "hour" : "hours"}`;

function InboxSettings({ setting }: { setting: HoursSetting }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const initial = setting.source === "default" ? "" : String(setting.value);
  const value = draft ?? initial;
  const changed = draft !== undefined && (value === "" ? null : Number(value)) !== setting.override;
  const mutation = useMutation({
    mutationFn: (approvedActiveHours: number | null) =>
      patch("/api/v1/settings", { approvedActiveHours }, SettingsView),
    onSuccess: async (view) => {
      await client.cancelQueries({ queryKey: ["settings"] });
      client.setQueryData(["settings"], view);
      setDraft(undefined);
      setError(undefined);
      void client.invalidateQueries({ queryKey: ["inbox"] });
      void client.invalidateQueries({ queryKey: ["review"] });
    },
  });
  function save() {
    if (mutation.isPending) return;
    const parsed = ApprovedActiveHours.safeParse(Number(value));
    if (input.current?.validity.badInput || (value !== "" && (!/^\d+$/.test(value) || !parsed.success))) {
      setError("Enter whole hours from 0 to 720.");
      return;
    }
    if (changed) mutation.mutate(value === "" ? null : Number(value));
  }
  return (
    <section aria-labelledby="inbox-settings" className="mt-6">
      <h2 id="inbox-settings" className="mb-4 text-16 font-semibold">
        Inbox
      </h2>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <TextField
            ref={input}
            label="Keep approved reviews in Active for"
            type="number"
            min={0}
            max={MAX_APPROVED_ACTIVE_HOURS}
            step={1}
            inputMode="numeric"
            placeholder={hours(setting.default)}
            value={value}
            disabled={mutation.isPending}
            error={error}
            aria-describedby="approved-hours-note"
            onChange={(event) => {
              setDraft(event.target.value);
              setError(event.target.validity.badInput ? "Enter whole hours from 0 to 720." : undefined);
            }}
          />
          <span className="pb-2 text-14 text-fg-3">{value === "1" ? "hour" : "hours"}</span>
          <Button type="submit" variant="primary" disabled={!changed || mutation.isPending}>
            Save
          </Button>
          {setting.source === "override" && (
            <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate(null)}>
              Reset
            </Button>
          )}
        </div>
        <div id="approved-hours-note" className="mt-2 text-14 text-fg-3">
          <p>
            {setting.source === "default"
              ? "Default."
              : setting.source === "file"
                ? "From the config file."
                : "Set here."}
          </p>
          {setting.source === "override" && setting.file !== null && <p>The config file says {hours(setting.file)}.</p>}
          {setting.fileError && <p>The config file's value can't be used, so it is ignored.</p>}
        </div>
        {mutation.isError && (
          <p role="alert" className="mt-2 text-14 text-fg-3">
            Could not save settings. Try again.
          </p>
        )}
      </form>
    </section>
  );
}

type Confirm = { kind: "one"; item: BinItem } | { kind: "all" } | null;

function BinSettings() {
  const client = useQueryClient();
  const toast = useToast();
  const bin = useQuery(binQuery());
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const items = bin.data?.items ?? [];
  const total = bin.data?.total ?? 0;
  /** Runs one request. A failure shows the server's message; every outcome refreshes the lists. */
  async function run(request: () => Promise<unknown>, success: string, reviewId?: string) {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    try {
      await request();
      toast.show({ tone: "success", title: success });
      return true;
    } catch (error) {
      toast.show({ tone: "danger", title: mutationMessage(error as Error) });
      return false;
    } finally {
      busy.current = false;
      setPending(false);
      void client.invalidateQueries({ queryKey: ["bin"] });
      void client.invalidateQueries({ queryKey: ["inbox"] });
      if (reviewId) {
        void client.invalidateQueries({ queryKey: ["review", reviewId] });
        void client.invalidateQueries({ queryKey: ["revision", reviewId] });
      } else void client.invalidateQueries({ queryKey: ["review"] });
    }
  }
  const restore = (item: BinItem) =>
    run(
      () => change(`/api/v1/reviews/${encodeURIComponent(item.id)}/restore`, "POST"),
      `Restored “${item.title}”`,
      item.id,
    );
  const confirmed = async () => {
    if (!confirm) return;
    const ok =
      confirm.kind === "one"
        ? await run(
            () => change(`/api/v1/reviews/${encodeURIComponent(confirm.item.id)}`, "DELETE"),
            `Deleted “${confirm.item.title}”`,
            confirm.item.id,
          )
        : await run(() => change("/api/v1/bin", "DELETE"), "Emptied the bin");
    if (ok) setConfirm(null);
  };
  const now = Date.now();
  return (
    <section aria-labelledby="bin-settings" className="mt-10">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="bin-settings" className="text-16 font-semibold">
          Bin
        </h2>
        <Button variant="danger" disabled={total === 0 || pending} onClick={() => setConfirm({ kind: "all" })}>
          Empty bin
        </Button>
      </div>
      {bin.isPending && <p role="status">Loading the bin…</p>}
      {bin.isError && <p role="alert">Could not load the bin. Try again.</p>}
      {bin.data && items.length === 0 && <p className="text-14 text-fg-3">The bin is empty.</p>}
      {items.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line-1 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-14 font-medium" dir="auto">
                  {item.title}
                </p>
                <p className="m-0 truncate text-13 text-fg-3" dir="auto">
                  {item.machine} · Deleted {relativeTime(item.binnedAt, now)}
                </p>
              </div>
              <Button disabled={pending} onClick={() => void restore(item)}>
                Restore
              </Button>
              <Button variant="danger" disabled={pending} onClick={() => setConfirm({ kind: "one", item })}>
                Delete for good
              </Button>
            </li>
          ))}
        </ul>
      )}
      {bin.data && total > items.length && (
        <p className="mt-2 text-14 text-fg-3">
          Showing the newest {items.length} of {total}.
        </p>
      )}
      <Dialog
        open={confirm !== null}
        onOpenChange={(next) => !next && !busy.current && setConfirm(null)}
        title={confirm?.kind === "one" ? `Delete “${confirm.item.title}” for good?` : "Empty the bin?"}
        description={
          confirm?.kind === "one"
            ? "This removes the review, its revisions, comments and Sends. This cannot be undone."
            : `This deletes the ${total} ${plural(total, "review")} in the bin for good, with their revisions, comments and Sends. This cannot be undone.`
        }
        actions={
          <>
            <Button data-autofocus disabled={pending} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={pending} onClick={() => void confirmed()}>
              {confirm?.kind === "one" ? "Delete for good" : "Empty bin"}
            </Button>
          </>
        }
      />
    </section>
  );
}

export function SettingsPage() {
  const settings = useQuery(settingsQuery());
  return (
    <AppFrame>
      <main className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-5 pt-8 pb-20">
          <h1 className="text-24 font-semibold leading-(--lh-tight) tracking-(--tracking-tight)">Settings</h1>
          {settings.isPending && <p role="status">Loading settings…</p>}
          {settings.isError && <p role="alert">Could not load settings. Try again.</p>}
          {settings.data && <InboxSettings setting={settings.data.approvedActiveHours} />}
          <BinSettings />
        </div>
      </main>
    </AppFrame>
  );
}
