import { unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseServeArgs } from "../commands/serve.ts";
import { CliError } from "../http.ts";
import { readOwnedService, type ServiceContext, ServiceFileNotOwned, validatePaths } from "./common.ts";
import { serviceField } from "./launchd.ts";

// The service of the name before the rename. recense neither starts nor keeps it.
const unitName = "emend";
const systemdPrefix = "# written by emend\n";
const launchdLabel = "dev.emend.server";
const launchdPrefix = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- written by emend -->\n';

type LegacyContext = Pick<ServiceContext, "home" | "io" | "tool" | "now" | "sleep">;

export const legacyUnitPath = (home: string, configHome: string | undefined) =>
  join(configHome && isAbsolute(configHome) ? configHome : join(home, ".config"), `systemd/user/${unitName}.service`);
export const legacyPlistPath = (home: string) => join(home, `Library/LaunchAgents/${launchdLabel}.plist`);

async function legacyContent(platform: string, context: Pick<ServiceContext, "home" | "io">) {
  const [path, prefix] =
    platform === "linux"
      ? [legacyUnitPath(context.home, context.io.env.XDG_CONFIG_HOME), systemdPrefix]
      : [legacyPlistPath(context.home), launchdPrefix];
  validatePaths(path);
  try {
    return await readOwnedService(path, prefix);
  } catch (error) {
    // A file of that name that the old product did not write is not ours to touch.
    if (error instanceof ServiceFileNotOwned) return undefined;
    throw error;
  }
}

/** True when a service of the old name is installed. */
export async function legacyServiceInstalled(
  platform: string,
  context: Pick<ServiceContext, "home" | "io">,
): Promise<boolean> {
  if (platform !== "linux" && platform !== "darwin") return false;
  return (await legacyContent(platform, context)) !== undefined;
}

/** The words of a systemd ExecStart line, undoing the quoting and the `%%` and `$$` escapes the old unit used. */
function systemdWords(line: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i] ?? "")) {
      i++;
      continue;
    }
    let word = "";
    if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) i++;
        word += line[i++];
      }
      i++;
    } else {
      while (i < line.length && !/\s/.test(line[i] ?? "")) word += line[i++];
    }
    words.push(word.replaceAll("%%", "%").replaceAll("$$", "$"));
  }
  return words;
}

const unxml = (value: string) =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

/** The options the old service passed to `serve`, and the state folder it pinned, read from its own file. */
function legacyOptions(platform: string, content: string): { words: string[]; stateDir?: string } | undefined {
  let words: string[];
  let stateDir: string | undefined;
  if (platform === "linux") {
    const line = /^ExecStart=(.*)$/m.exec(content)?.[1];
    if (line === undefined) return undefined;
    words = systemdWords(line);
    const environment = /^Environment=(.*)$/gm;
    for (let match = environment.exec(content); match; match = environment.exec(content)) {
      const [assignment] = systemdWords(match[1] ?? "");
      if (assignment?.startsWith("EMEND_HOME=")) stateDir = assignment.slice("EMEND_HOME=".length);
    }
  } else {
    const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content)?.[1];
    if (block === undefined) return undefined;
    words = [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unxml(match[1] ?? ""));
    const home = /<key>EMEND_HOME<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(content)?.[1];
    if (home !== undefined) stateDir = unxml(home);
  }
  // [node, entry, "serve", ...options]
  return words[2] === "serve" ? { words: words.slice(3), ...(stateDir === undefined ? {} : { stateDir }) } : undefined;
}

export interface LegacyService {
  /** The serve options the old service ran with; absent when they could not be read. */
  flags?: string[];
  /** The state folder the old service pinned with EMEND_HOME. */
  stateDir?: string;
}

/**
 * Reads what the service of the old name ran with, and changes nothing. Returns undefined when none is there.
 * With `needOptions` it refuses when the old options cannot be read, because dropping them silently could
 * move the server or lose its route.
 */
export async function inspectLegacyService(
  platform: string,
  context: Pick<ServiceContext, "home" | "io">,
  needOptions = false,
): Promise<LegacyService | undefined> {
  if (platform !== "linux" && platform !== "darwin") return undefined;
  const content = await legacyContent(platform, context);
  if (content === undefined) return undefined;
  const parsed = legacyOptions(platform, content);
  let flags: string[] | undefined;
  try {
    if (parsed) {
      parseServeArgs(parsed.words);
      flags = parsed.words;
    }
  } catch {
    flags = undefined;
  }
  if (needOptions && flags === undefined)
    throw new CliError(
      "could not read the options of the old emend service, so it was left running; run recense service install with the options it used (see emend.service or dev.emend.server.plist).",
    );
  return {
    ...(flags === undefined ? {} : { flags }),
    ...(parsed?.stateDir === undefined ? {} : { stateDir: parsed.stateDir }),
  };
}

const launchdTarget = (uid: number) => `gui/${uid}/${launchdLabel}`;

/** The process id of the old service's server; zero when it does not run. */
export async function legacyServicePid(platform: string, context: LegacyContext, uid?: number): Promise<number> {
  if (platform === "linux") {
    const systemctl = await context.tool("systemctl");
    const result = await systemctl(["--user", "show", "--property=MainPID", "--value", unitName], "ignore");
    const pid = Number(result.stdout.trim());
    return result.code === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
  }
  if (uid === undefined) throw new CliError("Could not determine the service user.");
  const launchctl = await context.tool("launchctl");
  const result = await launchctl(["print", launchdTarget(uid)], "ignore");
  const pid = Number(serviceField(result.stdout, "pid"));
  return result.code === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

/**
 * Stops the old service and waits until it is gone, but leaves its file and its enabled state alone. Returns a
 * function that starts it again, for a handover that fails after this point.
 */
export async function stopLegacyService(
  platform: string,
  context: LegacyContext,
  uid?: number,
): Promise<() => Promise<void>> {
  const deadline = context.now() + 10000;
  const wait = async (running: () => Promise<boolean>) => {
    while (await running()) {
      const remaining = deadline - context.now();
      if (remaining <= 0) throw new CliError("the old emend service did not stop; it was left as it was. Try again.");
      await context.sleep(Math.min(200, remaining));
    }
  };
  if (platform === "linux") {
    const systemctl = await context.tool("systemctl");
    await systemctl(["--user", "stop", unitName], "ignore");
    await wait(async () => (await systemctl(["--user", "is-active", unitName], "ignore")).code === 0);
    return async () => void (await systemctl(["--user", "start", unitName], "ignore"));
  }
  if (uid === undefined) throw new CliError("Could not determine the service user.");
  const launchctl = await context.tool("launchctl");
  await launchctl(["bootout", launchdTarget(uid)], "ignore");
  await wait(async () => (await launchctl(["print", launchdTarget(uid)], "ignore")).code === 0);
  return async () => void (await launchctl(["bootstrap", `gui/${uid}`, legacyPlistPath(context.home)], "ignore"));
}

/** Removes the stopped service of the old name: its enabled state and its file. */
export async function removeLegacyService(platform: string, context: LegacyContext, uid?: number): Promise<void> {
  const { home, io, tool } = context;
  if (platform === "linux") {
    const systemctl = await tool("systemctl");
    await systemctl(["--user", "disable", unitName], "report");
    await unlink(legacyUnitPath(home, io.env.XDG_CONFIG_HOME));
    await systemctl(["--user", "daemon-reload"]);
  } else {
    if (uid === undefined) throw new CliError("Could not determine the service user.");
    await unlink(legacyPlistPath(home));
  }
  io.stdout("recense: removed the old emend service; the recense service replaces it\n");
}
