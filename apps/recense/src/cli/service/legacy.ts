import { unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseServeArgs } from "../commands/serve.ts";
import { CliError } from "../http.ts";
import { readOwnedService, type ServiceContext, ServiceFileNotOwned, validatePaths } from "./common.ts";

// The service of the name before the rename. recense neither starts nor keeps it.
const unitName = "emend";
const systemdPrefix = "# written by emend\n";
const launchdLabel = "dev.emend.server";
const launchdPrefix = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- written by emend -->\n';

type LegacyContext = Pick<ServiceContext, "home" | "io" | "tool">;

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
 * Stops and removes the service of the old name, the way recense removes its own. Returns what it knew about
 * the old service, or undefined when none was there. With `needOptions` it refuses, before it stops anything,
 * when the old options cannot be read, because dropping them silently could move the server or lose its route.
 */
export async function removeLegacyService(
  platform: string,
  context: LegacyContext,
  uid?: number,
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
  const { home, io, tool } = context;
  if (platform === "linux") {
    const path = legacyUnitPath(home, io.env.XDG_CONFIG_HOME);
    const systemctl = await tool("systemctl");
    await systemctl(["--user", "disable", "--now", unitName], "report");
    await unlink(path);
    await systemctl(["--user", "daemon-reload"]);
  } else {
    if (uid === undefined) throw new CliError("Could not determine the service user.");
    const launchctl = await tool("launchctl");
    await launchctl(["bootout", `gui/${uid}/${launchdLabel}`], "report");
    await unlink(legacyPlistPath(home));
  }
  io.stdout("recense: removed the old emend service; the recense service replaces it\n");
  return {
    ...(flags === undefined ? {} : { flags }),
    ...(parsed?.stateDir === undefined ? {} : { stateDir: parsed.stateDir }),
  };
}
