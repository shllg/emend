import { PairingCreated } from "@recense/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { encode } from "uqr";
import { post } from "../api/client.ts";
import { Banner } from "../components/ui/Banner.tsx";
import { Button } from "../components/ui/Button.tsx";
import { Dialog } from "../components/ui/Dialog.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { type PairingIntent, takePairingIntent } from "../lib/pairing-intent.ts";

async function createPairing() {
  const pairing = await post("/api/v1/pairings", { purpose: "device" }, PairingCreated);
  const now = Date.now();
  const deadline = now + Math.max(0, Math.min(600_000, Date.parse(pairing.expiresAt) - now));
  const url = new URL(pairing.url);
  const qr = encode(pairing.url, { border: 4 });
  // Retain only the QR matrix and safe display fields, never the secret URL.
  return {
    code: pairing.code,
    deadline,
    origin: url.origin,
    loopback: ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    qr: {
      size: qr.size,
      cells: qr.data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [{ x, y }] : []))),
    },
  };
}
type PairingDisplay = Awaited<ReturnType<typeof createPairing>>;
type PairingState =
  | (PairingDisplay & { expired: false })
  | (Pick<PairingDisplay, "origin" | "loopback"> & { expired: true });

function remainingSeconds(deadline: number) {
  return Math.max(0, Math.min(600, Math.ceil((deadline - Date.now()) / 1000)));
}

export function PairDevicePage() {
  const navigate = useNavigate();
  const router = useRouter();
  const opener = useRef<PairingIntent | undefined>(undefined);
  const client = useQueryClient();
  const pending = useRef<{ attempt: number; promise: Promise<PairingDisplay> } | null>(null);
  const closing = useRef(false);
  const lifetime = useRef(0);
  const [pairing, setPairing] = useState<PairingState>();
  const [seconds, setSeconds] = useState(0);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const intent = takePairingIntent();
    if (intent) {
      opener.current = intent;
      setAttempt(1);
    }
  }, []);
  useEffect(() => {
    const mounted = ++lifetime.current;
    return () => {
      // StrictMode's immediate re-setup cancels this; every actual route exit refreshes.
      queueMicrotask(() => {
        if (lifetime.current === mounted) {
          void client.invalidateQueries({ queryKey: ["devices"], refetchType: "all" });
        }
      });
    };
  }, [client]);
  useEffect(() => {
    if (attempt === 0) return;
    let active = true;
    if (pending.current?.attempt !== attempt) pending.current = { attempt, promise: createPairing() };
    void pending.current.promise.then(
      (value) => {
        if (!active) return;
        const remaining = remainingSeconds(value.deadline);
        setSeconds(remaining);
        if (remaining === 0) {
          pending.current = null;
          setPairing({ expired: true, origin: value.origin, loopback: value.loopback });
        } else setPairing({ ...value, expired: false });
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  useEffect(() => {
    if (!pairing || pairing.expired) return;
    const interval = window.setInterval(() => {
      const remaining = remainingSeconds(pairing.deadline);
      setSeconds(remaining);
      if (remaining === 0) {
        pending.current = null;
        setPairing({ expired: true, origin: pairing.origin, loopback: pairing.loopback });
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [pairing]);
  function newCode() {
    setPairing(undefined);
    setFailed(false);
    setAttempt((value) => value + 1);
  }
  async function close() {
    if (closing.current) return;
    closing.current = true;
    const devicesIndex = opener.current?.devicesIndex;
    const goBack = devicesIndex !== undefined && router.history.location.state.__TSR_index === devicesIndex + 1;
    // Replace first so Forward cannot restore this pairing after going back.
    await navigate({ to: "/devices", replace: true });
    if (goBack) router.history.back();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
      title="Pair a device"
      description={
        attempt === 0 ? (
          "Create a code for another browser or phone."
        ) : (
          <>
            Scan the QR code to pair with this hub, or open{" "}
            {pairing ? <span className="font-mono text-13 wrap-anywhere">{pairing.origin}</span> : "this hub"} on your
            device and type the code.
          </>
        )
      }
      actions={
        <Button data-autofocus variant="ghost" onClick={() => void close()}>
          Done
        </Button>
      }
    >
      <div className="mt-4">
        {attempt === 0 ? (
          <Button variant="primary" onClick={newCode}>
            Create code
          </Button>
        ) : failed ? (
          <Banner tone="danger" inline actionLabel="Try again" onAction={newCode}>
            Could not create a pairing. Try again.
          </Banner>
        ) : (
          !pairing && <p role="status">Creating pairing…</p>
        )}
        {pairing && (
          <>
            {pairing.loopback && (
              <Banner tone="warning" inline>
                This hub accepts connections from this computer only. To pair a phone, start recense with --tailscale.
              </Banner>
            )}
            {pairing.expired ? (
              <div className="mt-4 flex flex-col items-start gap-2">
                <p role="status" className="text-12 text-fg-3">
                  This code expired.
                </p>
                <Button onClick={newCode}>New code</Button>
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-[minmax(0,1fr)] items-center justify-items-center gap-5">
                <svg
                  role="img"
                  aria-label="Pairing QR code"
                  viewBox={`0 0 ${pairing.qr.size} ${pairing.qr.size}`}
                  width="256"
                  height="256"
                  className="h-auto min-w-0 w-full max-w-[256px]"
                  shapeRendering="crispEdges"
                >
                  <title>Pairing QR code</title>
                  <rect width={pairing.qr.size} height={pairing.qr.size} fill="white" />
                  {pairing.qr.cells.map(({ x, y }) => (
                    <rect key={`${x}:${y}`} x={x} y={y} width="1" height="1" fill="black" />
                  ))}
                </svg>
                <div className="flex min-w-0 flex-col items-start gap-2">
                  <span className="text-12 font-medium tracking-(--tracking-label) text-fg-3 uppercase">Code</span>
                  <p className="font-mono text-[26px] leading-none font-semibold tracking-[0.12em]">{pairing.code}</p>
                  <p className="inline-flex items-center gap-1 text-12 text-fg-3">
                    <Icon icon={Clock} size={12} />
                    Expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
