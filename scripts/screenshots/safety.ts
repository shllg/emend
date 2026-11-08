import { lstatSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { stateDir } from "../../apps/emend/src/state/paths.ts";

type Environment = Record<string, string | undefined>;

// Protect both the default location and any explicit parent override. Only path metadata is read.
// `accountHome` is the passwd home (os.userInfo().homedir), which emend's own config code also
// trusts; it can differ from $HOME, so its defaults are protected too.
export function protectedStateDirs(env: Environment, platform: string, home: string, accountHome = home): string[] {
  // The plain defaults stay protected whether or not XDG_DATA_HOME points elsewhere.
  const dirs = [home, accountHome].flatMap((entry) => [
    stateDir({ XDG_DATA_HOME: env.XDG_DATA_HOME }, platform, entry),
    stateDir({}, platform, entry),
    stateDir(env, platform, entry),
  ]);
  return [...new Set(dirs)];
}

// Resolve existing ancestors even when the state directory itself does not exist yet.
// In particular, a dangling symlink is an error, not permission to treat the path as safe.
export function canonicalPath(path: string): string {
  if (!isAbsolute(path)) throw new Error("Screenshot paths must be absolute");
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(canonicalPath(dirname(path)), basename(path));
  }
  return realpathSync(path);
}

export function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function overlaps(a: string, b: string): boolean {
  return a === b || inside(a, b) || inside(b, a);
}

export interface SealedPaths {
  root: string;
  tmpDir: string;
  emendHome: string;
  realStateDirs: readonly string[];
}

// The guard is pure; the caller supplies canonicalPath at the filesystem boundary.
export function assertSealedPaths(paths: SealedPaths, canonicalize: (path: string) => string): void {
  if (!paths.realStateDirs.length) throw new Error("The real state directories must be supplied");
  const all = [paths.root, paths.tmpDir, paths.emendHome, ...paths.realStateDirs];
  if (all.some((path) => !isAbsolute(path))) throw new Error("Screenshot paths must be absolute");
  const [root, tmpDir, emendHome, ...realStateDirs] = all.map((path) => canonicalize(path));
  if (!inside(tmpDir, root)) throw new Error("The sealed root must resolve inside the temporary directory");
  if (!inside(root, emendHome)) throw new Error("EMEND_HOME must resolve inside the sealed root");
  for (const state of realStateDirs) {
    if (overlaps(emendHome, state)) throw new Error("EMEND_HOME overlaps real emend state");
    // Cleanup removes the whole root, so it must not contain real state either.
    if (overlaps(root, state)) throw new Error("The sealed root overlaps real emend state");
  }
}

/** Before anything is created: the temporary parent must not equal, contain or sit inside real state. */
export function assertTempParent(
  tmpDir: string,
  realStateDirs: readonly string[],
  canonicalize: (path: string) => string,
): void {
  if (!isAbsolute(tmpDir)) throw new Error("The temporary directory must be absolute");
  const parent = canonicalize(tmpDir);
  for (const state of realStateDirs)
    if (overlaps(parent, canonicalize(state))) throw new Error("The temporary directory overlaps real emend state");
}

/**
 * Chromium creates `SingletonLock` (a symlink, hence lstat) in its `--user-data-dir` before it
 * serves anything, so it exists once the first CDP command is answered. A Chromium that ignores the
 * folder (a snap or flatpak build) leaves it out, and the run must not go on with the user's own
 * profile.
 */
export function assertProfileUsed(profile: string): void {
  try {
    lstatSync(join(profile, "SingletonLock"));
  } catch {
    throw new Error(
      "Chromium did not use the throwaway profile folder. Use a Chromium from your system packages, or pass --chromium <path>.",
    );
  }
}

/** A process group may be signalled only while its leader has not exited and it is not swept yet. */
export function maySignalGroup(child: { exitCode: number | null; signalCode: string | null }, swept: boolean): boolean {
  return !swept && child.exitCode === null && child.signalCode === null;
}

// Deliberately takes no parent environment. Keep every child, including git and Chromium, on this list.
export function childEnvironment(root: string, platform: string): Record<string, string> {
  if (!isAbsolute(root)) throw new Error("The sealed root must be absolute");
  return {
    PATH: platform === "darwin" ? "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin" : "/usr/bin:/bin",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    TMPDIR: join(root, "tmp"),
    EMEND_HOME: join(root, "emend"),
    LANG: "C.UTF-8",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
  };
}

export function assertSafePort(port: number, inUse = false): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid screenshot port");
  if (port === 3636) throw new Error("Port 3636 is reserved for the real emend server");
  if (inUse) throw new Error(`Screenshot port ${port} already accepts connections on 127.0.0.1`);
}

/** The rule for a failed probe: only a refused connection means the port is free. */
export function portProbeFailed(code: string | undefined): false {
  if (code === "ECONNREFUSED") return false;
  throw new Error(`Cannot check screenshot port (${code ?? "socket error"})`);
}

// A refused connection is the only result that means free. Permissions, timeouts and other
// failures must stop the run, rather than silently treating an untested port as available.
export function acceptsLoopbackConnection(port: number): Promise<boolean> {
  assertSafePort(port);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      try {
        resolve(portProbeFailed(error.code));
      } catch (failure) {
        reject(failure);
      }
    });
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error("Timed out checking screenshot port"));
    });
  });
}

export async function assertPortAvailable(
  port: number,
  probe: (port: number) => Promise<boolean> = acceptsLoopbackConnection,
): Promise<void> {
  assertSafePort(port);
  assertSafePort(port, await probe(port));
}

export function sealedOrigin(port: number): string {
  assertSafePort(port);
  return `http://127.0.0.1:${port}`;
}

function assertSealedOrigin(origin: string): void {
  let valid = false;
  try {
    valid = origin === sealedOrigin(Number(new URL(origin).port));
  } catch {
    // Do not echo untrusted URLs, which could contain credentials.
  }
  if (!valid) throw new Error("Expected the sealed HTTP loopback origin");
}

export function requestAllowed(url: string, origin: string): boolean {
  assertSealedOrigin(origin);
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "data:" ||
      parsed.protocol === "blob:" ||
      (parsed.origin === origin && !parsed.username && !parsed.password)
    );
  } catch {
    return false;
  }
}

export function assertRequestAllowed(url: string, origin: string): void {
  if (requestAllowed(url, origin)) return;
  let blocked = "invalid URL";
  try {
    const parsed = new URL(url);
    blocked = parsed.origin === "null" ? parsed.protocol : parsed.origin;
  } catch {
    // Error text must never include a pairing fragment or other credentials.
  }
  throw new Error(`Blocked screenshot request to ${blocked}`);
}

export function parsePairingLink(output: string, origin: string): string {
  assertSealedOrigin(origin);
  const links = (stripVTControlCharacters(output).match(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"'\x1b]+/gi) ?? []).filter((link) =>
    link.includes("/pair"),
  );
  if (links.length !== 1) throw new Error("Expected exactly one pairing link from the sealed CLI");
  let parsed: URL;
  try {
    parsed = new URL(links[0]);
  } catch {
    throw new Error("Invalid pairing link from the sealed CLI");
  }
  if (
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/pair" ||
    parsed.search ||
    !/^#emp_[A-Za-z0-9_-]{43}$/.test(parsed.hash)
  ) {
    throw new Error("Pairing link must target the sealed origin and carry one fragment secret");
  }
  return parsed.href;
}

// ---- Output folder, fixture paths ---------------------------------------------------------------

/** The screenshot folder must not overlap real emend state; PNGs are written into it. */
export function assertOutputFolder(out: string, realStateDirs: readonly string[], canonicalize: (path: string) => string): void {
  if (!isAbsolute(out)) throw new Error("The screenshot folder must be absolute");
  const folder = canonicalize(out);
  for (const state of realStateDirs) {
    if (overlaps(folder, canonicalize(state))) throw new Error("The screenshot folder overlaps real emend state");
  }
}

/** A fixture path to delete must stay inside the fixture repository. */
export function assertInsideRoot(root: string, path: string): string {
  const target = resolve(root, path);
  if (!inside(resolve(root), target)) throw new Error("A fixture path leaves its repository");
  return target;
}

// ---- Browser decisions --------------------------------------------------------------------------

export type TargetKind = "controlled" | "inert" | "violation";

const CONTROLLED_TARGETS = new Set(["page", "iframe", "worker", "shared_worker", "service_worker"]);

/**
 * Targets that get Fetch interception are controlled. Only browser chrome that cannot reach the
 * network may be detached; every other type, or an `other` or `browser_ui` target with a web URL, is a
 * violation.
 */
export function classifyTarget(type: string, url: string): TargetKind {
  if (CONTROLLED_TARGETS.has(type)) return "controlled";
  if (type === "browser") return "inert";
  // Headless Chromium also lists its own UI pages (browser_ui, chrome:// URLs) as targets.
  if (type === "other" || type === "browser_ui") {
    try {
      if (["chrome:", "chrome-extension:"].includes(new URL(url).protocol)) return "inert";
    } catch {
      // An unparseable URL is not inert.
    }
  }
  return "violation";
}

/** WebSocket and WebTransport bypass Fetch interception, so their creation is checked here. */
export function socketAllowed(url: string, origin: string): boolean {
  assertSealedOrigin(origin);
  try {
    const parsed = new URL(url);
    return parsed.protocol === "ws:" && parsed.host === new URL(origin).host && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** The Chromium command line. Pure, so a test can pin every flag. */
export function chromiumArgs(profile: string, platform: string): string[] {
  if (!isAbsolute(profile)) throw new Error("The browser profile must be absolute");
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    ...(platform === "darwin" ? ["--use-mock-keychain", "--password-store=basic"] : []),
    "about:blank",
  ];
}

// ---- PNG metadata -------------------------------------------------------------------------------

const KEEP_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "sRGB", "gAMA", "cHRM", "pHYs"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Keeps the pixel and colour chunks only; text, time, exif and profile chunks are dropped. */
export function filterPng(png: Buffer): Buffer {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Not a PNG");
  const kept: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  let ended = false;
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error("Truncated PNG chunk");
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) throw new Error("Truncated PNG chunk");
    const type = png.toString("latin1", offset + 4, offset + 8);
    if (KEEP_CHUNKS.has(type)) kept.push(png.subarray(offset, end));
    offset = end;
    if (type === "IEND") {
      ended = true;
      break; // Anything after IEND is dropped.
    }
  }
  if (!ended) throw new Error("PNG has no IEND chunk");
  return Buffer.concat(kept);
}

/** The real state directories of this machine, from the parent's own environment and both homes. */
export function currentProtectedStateDirs(): string[] {
  return protectedStateDirs(process.env, process.platform, homedir(), userInfo().homedir);
}
