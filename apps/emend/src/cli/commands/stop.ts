import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Io } from "../../main.ts";
import { checkTokenFileMode } from "../../state/token-file.ts";
import { escapeReference } from "../escape.ts";
import { CliError, CliUsageError } from "../http.ts";
import { type ServerRecord, serverRecord } from "../server-client.ts";
import { servicePid } from "../service/pid.ts";
import { requestServerStop } from "../service/takeover.ts";
import { removeStaleTailscaleServe } from "../tailscale.ts";
import { tailscaleOrigin } from "../tailscale-marker.ts";

export async function stopCommand(stateDir: string, args: string[], io: Io) {
  if (args.length) throw new CliUsageError("Usage: emend stop.");
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
            `could not check whether the emend service runs the server at ${escapeReference(record.url)}; nothing was changed. Run emend service status, then try again.`,
          );
      }
      if (pid === record.pid)
        throw new CliError(
          `the emend server at ${escapeReference(record.url)} runs as the emend service; run emend service install to restart it, or emend service uninstall to stop it.`,
        );
      await checkTokenFileMode(join(stateDir, "admin.token"));
    },
    messages: (reference) => ({
      unanswered: `the emend server at ${reference} did not answer; try again.`,
      changed: `the emend server at ${reference} changed while emend asked it to stop; try again.`,
      unsupported: `the emend server at ${reference} is from an older emend and cannot be asked to stop; end its process yourself: https://github.com/shllg/emend/blob/release/docs/setup/troubleshooting.md#a-server-from-an-older-emend-cannot-be-asked-to-stop`,
      notStopped: `the emend server at ${reference} did not stop; try again.`,
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
      // Discovery is removed after db.close(); zombies still answer kill(pid, 0).
      // The per-process key also distinguishes a replacement that reused this pid.
      const current = await serverRecord(stateDir);
      if (!current || current.pid !== before.pid || current.key !== before.key) break;
      if (now() >= deadline)
        throw new CliError(`the emend server at ${escapeReference(before.url)} did not stop; try again.`);
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
        ? `emend: no emend server is running; removed the Tailscale Serve route a stopped emend server left at ${origin}\n`
        : "notInstalled" in route
          ? `emend: no emend server is running; tailscale was not found on PATH, so the Tailscale Serve route at ${origin} may still exist.\n`
          : "emend: no emend server is running.\n",
    );
  } else {
    io.stdout(`emend: stopped the emend server at ${escapeReference(url)}\n`);
  }
}
