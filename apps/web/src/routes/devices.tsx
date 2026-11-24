import { DeviceList, type DeviceView } from "@recense/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouter } from "@tanstack/react-router";
import { Download, LogOut, MonitorSmartphone, QrCode, RefreshCw, RotateCw, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, change, get } from "../api/client.ts";
import { AppFrame } from "../components/layout/AppFrame.tsx";
import { useRequestUpdate } from "../components/layout/UpdateGate.tsx";
import { Button } from "../components/ui/Button.tsx";
import { Dialog } from "../components/ui/Dialog.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { type AppUpdateSnapshot, appUpdate, buildTag, useAppUpdate } from "../lib/app-update.ts";
import { requestPairingFromLink } from "../lib/pairing-intent.ts";
import { checkedText, relativeTime } from "../lib/time.ts";

function updateStatus(update: AppUpdateSnapshot) {
  switch (update.state) {
    case "unsupported":
      return "Updates need the installed app over a secure connection.";
    case "checking":
      return "Checking for updates…";
    case "current":
      return "This is the newest version.";
    case "available":
      return "An update is ready.";
    case "updating":
      return "Updating…";
    case "reload-needed":
      return "Another window installed an update. Reload to use it.";
    case "error":
      return `Could not check for updates: ${update.reason ?? "the check failed"}.`;
    default:
      return "";
  }
}

function AppSection({ now }: { now: number }) {
  const update = useAppUpdate();
  const request = useRequestUpdate();
  const tag = buildTag();
  const busy = update.state === "checking" || update.state === "updating";
  const checked = update.checkedAt === null ? "" : checkedText(new Date(update.checkedAt).toISOString(), now);
  return (
    <section aria-labelledby="app-heading" className="mt-10">
      <h2 id="app-heading" className="text-18 font-semibold leading-(--lh-snug)">
        App
      </h2>
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-line-1 bg-surface px-3.5 py-3">
        <div className="min-w-0 flex-1 basis-[15rem]">
          <p className="text-14 font-semibold">{`recense ${__RECENSE_VERSION__}${tag ? ` (${tag})` : ""}`}</p>
          <p aria-live="polite" className="mt-0.5 text-12 text-fg-3">
            {updateStatus(update)}
          </p>
          {checked && update.state !== "unsupported" && <p className="text-12 text-fg-3">{checked}</p>}
        </div>
        {update.state === "available" && (
          <Button size="sm" variant="primary" icon={Download} onClick={() => request("update")}>
            Update now
          </Button>
        )}
        {update.state === "reload-needed" && (
          <Button size="sm" variant="primary" icon={RotateCw} onClick={() => request("reload")}>
            Reload
          </Button>
        )}
        {update.state !== "unsupported" && (
          // aria-disabled, not disabled: the button keeps keyboard focus while a check runs.
          <Button
            size="sm"
            icon={RefreshCw}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) void appUpdate.checkForUpdate();
            }}
          >
            Check for update
          </Button>
        )}
      </div>
    </section>
  );
}

export function DevicesPage() {
  const router = useRouter();
  const client = useQueryClient();
  const [selected, setSelected] = useState<DeviceView | null>(null);
  const [now, setNow] = useState(Date.now);
  const revoking = useRef(false);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: ({ signal }) => get("/api/v1/devices", DeviceList, signal),
  });
  async function refreshDevices() {
    setSelected(null);
    await client.invalidateQueries({ queryKey: ["devices"] });
  }
  const revoke = useMutation({
    mutationFn: (device: DeviceView) => change(`/api/v1/devices/${device.id}`, "DELETE"),
    onSuccess: async (_data, device) => {
      if (device.current) {
        client.clear();
        window.location.assign("/pair");
      } else await refreshDevices();
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 404) await refreshDevices();
    },
    onSettled: () => {
      revoking.current = false;
    },
  });
  return (
    <AppFrame>
      <main className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-5 pt-8 pb-20">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1 basis-[20rem]">
              <h1 className="text-24 font-semibold leading-(--lh-tight) tracking-(--tracking-tight)">Devices</h1>
              <p className="mt-1 text-14 text-fg-3">
                Browsers and machines that can use this hub. Sign-ins last 30 days and renew while in use.
              </p>
            </div>
            <Button asChild variant="primary" icon={QrCode}>
              <Link to="/devices/pair" onClick={(event) => requestPairingFromLink(event, router.history.location)}>
                Pair a device
              </Link>
            </Button>
          </div>
          {devices.isPending && <p role="status">Loading devices…</p>}
          {devices.isError && <p role="alert">Could not load devices. Try again.</p>}
          {devices.data?.items.length === 0 && <p className="text-14 text-fg-3">No paired devices.</p>}
          {!!devices.data?.items.length && (
            <ul className="divide-y divide-line-1 rounded-lg border border-line-1 bg-surface">
              {devices.data.items.map((device) => (
                <li key={device.id} className="flex flex-wrap items-center gap-3 px-3.5 py-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-fg-2">
                    <Icon icon={device.kind === "browser" ? MonitorSmartphone : Server} size={18} />
                  </span>
                  <div className="min-w-0 flex-1 basis-[9rem]">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="min-w-0 text-14 font-semibold wrap-anywhere">{device.name}</p>
                      {device.current && (
                        <span className="rounded-sm border border-line-1 bg-sunken px-1.5 py-0.5 text-11 font-medium text-fg-2">
                          This device
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-12 text-fg-3">
                      {device.kind === "browser" ? "Browser · paired " : "Machine · attached "}
                      <time dateTime={device.createdAt}>{new Date(device.createdAt).toLocaleDateString()}</time>
                    </p>
                  </div>
                  <p className="text-12 text-fg-3">
                    <span className="sr-only">Last seen: </span>
                    {device.lastSeenAt ? (
                      <time dateTime={device.lastSeenAt}>{relativeTime(device.lastSeenAt, now)}</time>
                    ) : (
                      "never"
                    )}
                  </p>
                  <Button
                    size="sm"
                    variant={device.current ? "ghost" : "danger"}
                    icon={device.current ? LogOut : undefined}
                    disabled={revoke.isPending}
                    onClick={() => {
                      revoke.reset();
                      setSelected(device);
                    }}
                  >
                    {device.current ? "Sign out" : "Revoke"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <AppSection now={now} />
        </div>
      </main>
      {selected && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !revoking.current) setSelected(null);
          }}
          title={selected.current ? "Sign out of this browser?" : `Revoke ${selected.name}?`}
          description={
            selected.current
              ? "You will need a new code to sign in again."
              : selected.kind === "browser"
                ? "It signs out now and needs a new code to pair again."
                : "It loses access to this hub now and needs a new code to attach again."
          }
          actions={
            <>
              <Button data-autofocus variant="ghost" disabled={revoke.isPending} onClick={() => setSelected(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={revoke.isPending}
                onClick={() => {
                  if (revoking.current) return;
                  revoking.current = true;
                  revoke.mutate(selected);
                }}
              >
                {selected.current ? "Sign out" : "Revoke"}
              </Button>
            </>
          }
        >
          {revoke.isError && (
            <p role="alert" className="mt-4 text-13 text-danger-fg">
              Could not revoke the device. Try again.
            </p>
          )}
        </Dialog>
      )}
      <Outlet />
    </AppFrame>
  );
}
