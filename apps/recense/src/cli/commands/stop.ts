import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Io } from "../../main.ts";
import { checkTokenFileMode } from "../../state/token-file.ts";
import { escapeReference } from "../escape.ts";
import { CliError, CliUsageError } from "../http.ts";
import { pidMayBeServer, type ServerRecord, serverRecord } from "../server-client.ts";
import { servicePid } from "../service/pid.ts";
import { requestServerStop } from "../service/takeover.ts";
import { removeStaleTailscaleServe } from "../tailscale.ts";
import { tailscaleOrigin } from "../tailscale-marker.ts";

export async function stopCommand(stateDir: string, args: string[], io: Io) {
  if (args.length) throw new CliUsageError("Usage: recense stop.");
  let before: ServerRecord | undefined;
  const url = await requestServerStop(stateDir, {
    now: io.service?.now,
    sleep: io.service?.sleep,
    beforeProbe: async (record) => {
      before = record;
      const pid = await servicePid(io);
      if (pid === null) {
        let running = true;
        try {
          process.kill(record.pid, 0);
        } catch (error) {
          running = (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
        if (running)
          throw new CliError(
            `could not check whether the recense service runs the server at ${escapeReference(record.url)}; nothing was changed. Run recense service status, then try again.`,
          );
      }
      if (pid === record.pid)
        throw new CliError(
          `the recense server at ${escapeReference(record.url)} runs as the recense service; run recense service install to restart it, or recense service uninstall to stop it.`,
        );
      await checkTokenFileMode(join(stateDir, "admin.token"));
    },
    messages: (reference) => ({
      unanswered: `the recense server at ${reference} did not answer; try again.`,
      changed: `the recense server at ${reference} changed while recense asked it to stop; try again.`,
      unsupported: `the recense server at ${reference} is from an older recense and cannot be asked to stop; end its process yourself: https://github.com/shllg/recense/blob/release/docs/setup/troubleshooting.md#a-server-from-an-older-recense-cannot-be-asked-to-stop`,
      notStopped: `the recense server at ${reference} did not stop; try again.`,
    }),
  });
  if (before) {
    const now = io.service?.now ?? (() => performance.now());
    const sleep = io.service?.sleep ?? delay;
    const deadline = now() + 15000;
    for (;;) {
      try {
        process.kill(before.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
      }
      // A live pid that runs some other program is a stale record whose pid was reused, not a server closing.
      if (!pidMayBeServer(before.pid)) break;
      // Discovery is removed after db.close(); zombies still answer kill(pid, 0).
      // The per-process key also distinguishes a replacement that reused this pid.
      const current = await serverRecord(stateDir);
      if (!current || current.pid !== before.pid || current.key !== before.key) break;
      if (now() >= deadline)
        throw new CliError(`the recense server at ${escapeReference(before.url)} did not stop; try again.`);
      await sleep(Math.min(100, Math.max(1, deadline - now())));
    }
  }
  if (url === undefined) {
    const route = await removeStaleTailscaleServe(stateDir, io.env, {
      now: io.service?.now,
      sleep: io.service?.sleep,
    });
    const origin = "dnsName" in route ? escapeReference(tailscaleOrigin(route.dnsName, route.httpsPort)) : "";
    io.stdout(
      route.removed
        ? `recense: no recense server is running; removed the Tailscale Serve route a stopped recense server left at ${origin}\n`
        : "notInstalled" in route
          ? `recense: no recense server is running; tailscale was not found on PATH, so the Tailscale Serve route at ${origin} may still exist.\n`
          : "recense: no recense server is running.\n",
    );
  } else {
    io.stdout(`recense: stopped the recense server at ${escapeReference(url)}\n`);
  }
}
