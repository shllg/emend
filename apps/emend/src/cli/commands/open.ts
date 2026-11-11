import { spawn } from "node:child_process";
import { PairingCreated } from "@emend/contract";
import type { Io } from "../../main.ts";
import { readConfig } from "../config.ts";
import { findExecutable } from "../executable.ts";
import { apiRequest, CliError } from "../http.ts";
import { ensureServer } from "../server-client.ts";
import { localTarget, readAttachment } from "../target.ts";
import { hubVersionNotice, localVersionNotice, printVersionNotice } from "../version-notice.ts";

export async function findBrowserOpener(env = process.env) {
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!command) return null;
  return findExecutable(command, env.PATH ?? "").catch(() => null);
}
export async function openBrowser(url: string, env = process.env, timeoutMs = 5_000): Promise<boolean> {
  const binary = await findBrowserOpener(env);
  if (!binary) return false;
  return new Promise((resolve) => {
    try {
      const child = spawn(binary.file, [url], {
        detached: true,
        stdio: "ignore",
        cwd: "/",
        env: { ...env, PATH: binary.path },
      });
      let settled = false;
      const finish = (opened: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.unref();
        resolve(opened);
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
    } catch {
      resolve(false);
    }
  });
}
export async function openCommand(stateDir: string, configDir: string, io: Io) {
  const config = await readConfig(stateDir, configDir);
  const openUrl = io.openUrl ?? ((url: string) => openBrowser(url, io.env));
  const attachment = await readAttachment(stateDir);
  if (attachment) {
    const notice = hubVersionNotice(attachment.hubUrl);
    let opened = false;
    if (config.openBrowser) {
      try {
        opened = await openUrl(attachment.hubUrl);
      } catch {
        /* Print the hub URL. */
      }
    }
    io.stdout(opened ? "Opening emend in your browser.\n" : `${attachment.hubUrl}\n`);
    printVersionNotice(io, await notice);
    return;
  }
  let url: string;
  try {
    ({ url } = await ensureServer(stateDir, { env: io.env }));
  } catch {
    throw new CliError("Could not start the emend server.");
  }
  const notice = await localVersionNotice(stateDir, io, url);
  const terminalHint = `emend is running at ${url}. Run emend in a terminal to get a sign-in link.\n`;
  if (!io.isTTY && (!config.openBrowser || (!io.openUrl && !(await findBrowserOpener(io.env))))) {
    io.stdout(terminalHint);
    printVersionNotice(io, notice);
    return;
  }
  const response = PairingCreated.safeParse(
    await apiRequest(stateDir, await localTarget(stateDir, url, "admin"), "/pairings", {
      method: "POST",
      body: { purpose: "device" },
    }),
  );
  if (!response.success) throw new CliError("The emend server returned an invalid response.");
  // The hub browser always opens loopback, even when pairing links advertise Tailscale.
  const localLink = new URL(response.data.url);
  const localOrigin = new URL(url);
  localLink.protocol = localOrigin.protocol;
  localLink.host = localOrigin.host;
  const browserUrl = localLink.href;
  let opened = false;
  if (config.openBrowser) {
    try {
      opened = await openUrl(browserUrl);
    } catch {
      /* Offer the one-time link only in a terminal. */
    }
  }
  io.stdout(
    opened
      ? "Opening emend in your browser.\n"
      : io.isTTY
        ? `Open this link within 10 minutes: ${browserUrl}\n`
        : terminalHint,
  );
  printVersionNotice(io, notice);
}
