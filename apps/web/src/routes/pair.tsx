import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, pair } from "../api/client.ts";
import { Button } from "../components/ui/Button.tsx";
import { PairingCodeInput } from "../components/ui/PairingCodeInput.tsx";
import { subscribePairingSecret, takePairingSecret } from "../lib/pairing-secret.ts";

export function PairPage() {
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(window.location.hostname);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const codeInput = useRef<HTMLInputElement>(null);
  const redeemed = useRef(new Set<string>());
  useEffect(() => {
    if (error && !busy) codeInput.current?.focus();
  }, [error, busy]);
  const redeem = useCallback(
    async (input: { secret: string } | { code: string }) => {
      setBusy(true);
      setError("");
      try {
        await pair(input);
        client.clear();
        await navigate({ to: "/", replace: true });
      } catch (error) {
        setError(
          error instanceof ApiError && error.status === 429
            ? "Too many wrong codes. Wait 10 minutes, then try again."
            : error instanceof ApiError && (error.status === 401 || error.status === 400)
              ? "That code did not work. Check it on the hub and try again."
              : "Could not pair. Check your connection and try again.",
        );
      } finally {
        setBusy(false);
      }
    },
    [client, navigate],
  );
  useEffect(() => {
    const consume = () => {
      const secret = takePairingSecret();
      if (!secret || redeemed.current.has(secret)) return;
      redeemed.current.add(secret);
      void redeem({ secret });
    };
    const unsubscribe = subscribePairingSecret(consume);
    consume();
    return unsubscribe;
  }, [redeem]);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-6 pt-14 pb-6">
      <p className="mb-3 font-mono text-[32px] font-medium leading-none text-fg-1">recense</p>
      <h1 className="text-24 font-semibold leading-(--lh-tight) tracking-(--tracking-tight)">
        {loopback ? "Sign in" : "Pair this device"}
      </h1>
      {loopback ? (
        <>
          {busy ? (
            <p role="status">Pairing…</p>
          ) : (
            <p className="text-15 text-fg-2">
              Run <code>recense</code> in a terminal on the machine that runs recense. It opens this page signed in, or
              prints a one-time link you can open here.
            </p>
          )}
          {error && (
            <p role="alert" className="text-13 text-danger-fg">
              {error}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="text-15 text-fg-2">
            On a browser that is already signed in, open Devices, choose Pair a device, and type the code it shows here.
          </p>
          <p className="text-12 text-fg-3">
            The app on your home screen pairs once more with a code, even after Safari has paired.
          </p>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && code.replace(/-/g, "").length === 8) void redeem({ code });
            }}
          >
            <PairingCodeInput
              ref={codeInput}
              id="pairing-code"
              label="Pairing code"
              value={code}
              onChange={(value) => {
                setCode(value);
                setError("");
              }}
              error={error}
              required
              disabled={busy}
            />
            <Button
              type="submit"
              disabled={busy || code.replace(/-/g, "").length !== 8}
              variant="primary"
              size="lg"
              fullWidth
            >
              Pair
            </Button>
            {busy && <p role="status">Pairing…</p>}
          </form>
        </>
      )}
    </main>
  );
}
