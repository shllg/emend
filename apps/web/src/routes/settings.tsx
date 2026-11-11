import { ApprovedActiveHours, type HoursSetting, MAX_APPROVED_ACTIVE_HOURS, SettingsView } from "@emend/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { patch } from "../api/client.ts";
import { settingsQuery } from "../api/queries.ts";
import { AppFrame } from "../components/layout/AppFrame.tsx";
import { Button } from "../components/ui/Button.tsx";
import { TextField } from "../components/ui/TextField.tsx";

const hours = (value: number) => `${value} ${value === 1 ? "hour" : "hours"}`;

function InboxSettings({ setting }: { setting: HoursSetting }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const initial = setting.source === "default" ? "" : String(setting.value);
  const value = draft ?? initial;
  const mutation = useMutation({
    mutationFn: (approvedActiveHours: number | null) =>
      patch("/api/v1/settings", { approvedActiveHours }, SettingsView),
    onSuccess: (view) => {
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
    if (value !== initial) mutation.mutate(value === "" ? null : Number(value));
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
          <Button type="submit" variant="primary" disabled={value === initial || mutation.isPending}>
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
        </div>
      </main>
    </AppFrame>
  );
}
