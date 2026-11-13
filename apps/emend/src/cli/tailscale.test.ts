import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LIMITS } from "@emend/contract";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { run } from "../main.ts";
import * as stateFiles from "../state/files.ts";
import { StateDirModeError, StateFolderWriteError, writeSecretFile } from "../state/files.ts";
import * as executables from "./executable.ts";
import { CliError } from "./http.ts";
import * as reads from "./publish/read.ts";
import { ensureTailscaleServe, removeStaleTailscaleServe, removeTailscaleServe, tailscaleSelf } from "./tailscale.ts";
import * as markers from "./tailscale-marker.ts";
import { loopbackState, readTailscaleMarker } from "./tailscale-marker.ts";

vi.mock("node:net", async (original) => ({ ...(await original<typeof import("node:net")>()) }));

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const dirs: string[] = [];
// CLI calls and removeTailscaleServe do not expose RunOptions. Keep this boundary in place even
// after restoreAllMocks and fixture removal, including the default macOS app fallback.
vi.mock("./executable.ts", async (original) => {
  const actual = await original<typeof import("./executable.ts")>();
  return {
    async findExecutable(...args: Parameters<typeof actual.findExecutable>) {
      const searchPath = args[1];
      if (
        searchPath === undefined ||
        searchPath
          .split(delimiter)
          .filter(Boolean)
          .some((entry) => !dirs.some((dir) => entry === dir || entry.startsWith(`${dir}${sep}`)))
      ) {
        throw new Error("executable lookup outside the test fixtures");
      }
      return actual.findExecutable(...args);
    },
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fake(status: unknown, config: unknown = {}, denied: boolean | "status" = false) {
  const dir = await mkdtemp(join(tmpdir(), "emend-tailscale-"));
  dirs.push(dir);
  const log = join(dir, "calls.jsonl");
  await writeFile(
    join(dir, "tailscale"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(log)}
/usr/bin/env > ${quote(join(dir, "env"))}
if [ "$1" = status ]; then printf '%s\\n' ${quote(JSON.stringify(status))}
elif [ "$2" = status ]; then
  ${denied === "status" ? "printf 'permission denied' >&2; exit 1" : ":"}
  printf '%s\\n' ${quote(JSON.stringify(config))}
else ${denied ? "printf '%s\\n' 'Access denied: try sudo tailscale set --operator=$USER' >&2; exit 1" : "printf ok"}
fi
`,
    { mode: 0o700 },
  );
  return {
    dir,
    env: {
      PATH: `.:relative:${dir}`,
      HOME: dir,
      EMEND_HOME: join(dir, "state"),
      NODE_OPTIONS: "--this-must-not-be-inherited",
    },
    options: { platform: "linux" as const, appPath: join(dir, "missing-app") },
    calls: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => ({ args: line.split(" ") })),
    childEnv: async () =>
      Object.fromEntries(
        (await readFile(join(dir, "env"), "utf8"))
          .trim()
          .split("\n")
          .filter((line) => !/^(PWD|SHLVL|_)=/.test(line))
          .map((line) => {
            const at = line.indexOf("=");
            return [line.slice(0, at), line.slice(at + 1)];
          }),
      ),
  };
}
const running = { BackendState: "Running", Self: { DNSName: "Hub.Example.ts.net." } };
async function fakeApp() {
  const app = await fake(running);
  const appDir = join(app.dir, "app");
  await mkdir(appDir);
  const appPath = join(appDir, "Tailscale");
  await rename(join(app.dir, "tailscale"), appPath);
  return { ...app, appPath };
}
test("status normalizes DNS and runs with only the minimal environment", async () => {
  const f = await fake(running);
  expect(await tailscaleSelf(f.env, undefined, f.options)).toEqual({ dnsName: "hub.example.ts.net" });
  const [call] = await f.calls();
  expect(call?.args).toEqual(["status", "--json"]);
  expect(await f.childEnv()).toEqual({ PATH: f.dir, HOME: f.env.HOME, LC_ALL: "C" });
});

test("a Tailscale wrapper receives only the safe PATH and never runs repository bash", async () => {
  const f = await fake(running);
  const repo = join(f.dir, "repo");
  const bin = join(repo, "bin");
  await mkdir(bin, { recursive: true });
  await mkdir(join(repo, ".git/objects"), { recursive: true });
  await mkdir(join(repo, ".git/refs"));
  await writeFile(join(repo, ".git/HEAD"), "ref: refs/heads/main\n");
  const marker = join(f.dir, "repository-bash-ran");
  await writeFile(join(bin, "bash"), `#!/bin/sh\nprintf ran > '${marker.replaceAll("'", "'\\''")}'\nexit 1\n`, {
    mode: 0o700,
  });
  await symlink("/bin/bash", join(f.dir, "bash"));
  const wrapper = join(f.dir, "tailscale");
  await writeFile(wrapper, (await readFile(wrapper, "utf8")).replace("#!/bin/sh", "#!/usr/bin/env bash"));
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  const env = { ...f.env, PATH: `${bin}:${f.dir}` };
  expect(await tailscaleSelf(env, undefined, f.options)).toEqual({ dnsName: "hub.example.ts.net" });
  expect(await f.childEnv()).toEqual({ PATH: f.dir, HOME: f.env.HOME, LC_ALL: "C" });
  await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an empty filtered helper PATH uses the fixed default", async () => {
  const f = await fake(running);
  vi.spyOn(executables, "findExecutable").mockResolvedValue({ file: join(f.dir, "tailscale"), path: "" });
  expect(await tailscaleSelf(f.env, undefined, f.options)).toEqual({ dnsName: "hub.example.ts.net" });
  expect(await f.childEnv()).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: f.env.HOME, LC_ALL: "C" });
});

test.each([true, false])(
  "darwin runs the app with the fixed system PATH (caller absolute entries: %s)",
  async (absolute) => {
    const app = await fakeApp();
    const searchPath = absolute ? `${join(app.dir, "first")}:${join(app.dir, "second")}` : "";
    const env = {
      ...app.env,
      PATH: `.:relative:${searchPath}:`,
      HOME: join(app.dir, "home"),
      LC_ALL: "fr_FR.UTF-8",
      NODE_OPTIONS: "--this-must-not-be-inherited",
    };
    expect(await tailscaleSelf(env, undefined, { platform: "darwin", appPath: app.appPath })).toEqual({
      dnsName: "hub.example.ts.net",
    });
    expect(await app.calls()).toEqual([{ args: ["status", "--json"] }]);
    expect(await app.childEnv()).toEqual({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: env.HOME,
      LC_ALL: "C",
    });
  },
);
test.each([undefined, ""])(
  "darwin runs the app with the fixed system PATH when the caller's PATH is %j",
  async (path) => {
    const app = await fakeApp();
    const env = { ...app.env, PATH: path, HOME: join(app.dir, "home") };
    expect(await tailscaleSelf(env, undefined, { platform: "darwin", appPath: app.appPath })).toEqual({
      dnsName: "hub.example.ts.net",
    });
    expect(await app.calls()).toEqual([{ args: ["status", "--json"] }]);
    expect(await app.childEnv()).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: env.HOME, LC_ALL: "C" });
  },
);
test("darwin prefers tailscale on PATH over the app", async () => {
  const app = await fakeApp();
  const path = await fake(running);
  expect(await tailscaleSelf(path.env, undefined, { platform: "darwin", appPath: app.appPath })).toEqual({
    dnsName: "hub.example.ts.net",
  });
  expect(await path.calls()).toEqual([{ args: ["status", "--json"] }]);
  expect(await path.childEnv()).toEqual({ PATH: path.dir, HOME: path.env.HOME, LC_ALL: "C" });
  await expect(app.calls()).rejects.toMatchObject({ code: "ENOENT" });
});
test("linux never uses the app even when it is executable", async () => {
  const app = await fakeApp();
  await expect(tailscaleSelf(app.env, undefined, { platform: "linux", appPath: app.appPath })).rejects.toThrow(
    "tailscale is not installed or not on PATH.",
  );
  await expect(app.calls()).rejects.toMatchObject({ code: "ENOENT" });
});
const lookupRefusals = [
  (name: string) => `${name} on PATH sits inside the current repository; emend does not run it.`,
  (name: string) => `Could not check where ${name} on PATH runs; emend does not run it.`,
];
test.each(["linux", "darwin"] as const)(
  "%s preserves helper lookup refusals without trying the app",
  async (platform) => {
    const f = await fake(running);
    const lookup = vi.spyOn(executables, "findExecutable");
    for (const message of lookupRefusals) {
      const refusal = new CliError(message("tailscale"));
      lookup.mockClear().mockRejectedValue(refusal);
      await expect(tailscaleSelf(f.env, undefined, { ...f.options, platform })).rejects.toBe(refusal);
      expect(lookup).toHaveBeenCalledExactlyOnceWith("tailscale", f.dir);
    }
  },
);
test("darwin preserves helper lookup refusals from the app fallback", async () => {
  const app = await fakeApp();
  const lookup = vi.spyOn(executables, "findExecutable");
  for (const message of lookupRefusals) {
    const refusal = new CliError(message("Tailscale"));
    lookup
      .mockClear()
      .mockRejectedValueOnce(new CliError("tailscale was not found on PATH"))
      .mockRejectedValueOnce(refusal);
    await expect(tailscaleSelf(app.env, undefined, { platform: "darwin", appPath: app.appPath })).rejects.toBe(refusal);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenLastCalledWith("Tailscale", join(app.dir, "app"));
  }
});
test.each(["missing", "non-executable", "directory"])("darwin rejects a %s app binary", async (kind) => {
  const app = await fakeApp();
  if (kind === "non-executable") await chmod(app.appPath, 0o600);
  else {
    await rm(app.appPath);
    if (kind === "directory") await mkdir(app.appPath);
  }
  await expect(tailscaleSelf(app.env, undefined, { platform: "darwin", appPath: app.appPath })).rejects.toThrow(
    "tailscale is not installed or not on PATH.",
  );
  await expect(app.calls()).rejects.toMatchObject({ code: "ENOENT" });
});
test.each(["NeedsLogin", "Stopped"])("%s returns null and the CLI prints the required line", async (state) => {
  const f = await fake({ BackendState: state });
  expect(await tailscaleSelf(f.env, undefined, f.options)).toBeNull();
  const stderr: string[] = [];
  const stdout: string[] = [];
  expect(
    await run(["serve", "--tailscale"], {
      env: f.env,
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
    }),
  ).toBe(1);
  expect(stderr).toEqual(["emend: Tailscale is not running or not logged in.\n"]);
  expect(stdout).toEqual([]);
});
test.each([
  "localhost",
  "-bad.example",
  "bad-.example",
  "bad/name.example",
  "a..example",
  `${"a".repeat(64)}.example`,
  `${"a.".repeat(127)}com`,
])("rejects invalid DNS %s", async (name) => {
  const f = await fake({ BackendState: "Running", Self: { DNSName: name } });
  expect(await tailscaleSelf(f.env, undefined, f.options)).toBeNull();
});
test("missing binary prints only the fixed error", async () => {
  const app = await fakeApp();
  await rm(app.appPath);
  const tailscale = await import("./tailscale.ts");
  const self = tailscale.tailscaleSelf;
  vi.spyOn(tailscale, "tailscaleSelf").mockImplementation((env, signal) =>
    self(env, signal, { platform: "darwin", appPath: app.appPath }),
  );
  const stderr: string[] = [];
  expect(
    await run(["serve", "--tailscale"], {
      env: { ...app.env, PATH: ".:relative" },
      stdout: () => {
        throw Error("unexpected stdout");
      },
      stderr: (s) => stderr.push(s),
    }),
  ).toBe(1);
  expect(stderr).toEqual(["emend: tailscale is not installed or not on PATH.\n"]);
});
const proxy = {
  TCP: { "443": { HTTPS: true } },
  Web: { "hub.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3636" } } } },
};

const dnsName = "hub.example.ts.net";
const ownership = (port = 3636, pid = process.pid) => ({ target: `http://127.0.0.1:${port}`, dnsName, pid });
function markerPid(state: "running" | "ESRCH" | "EPERM" = "ESRCH") {
  const owner = 2_000_000_000;
  // Recovery fixtures use closed ports; live-owner fixtures use open ports.
  vi.spyOn(markers, "loopbackState").mockResolvedValue(state === "ESRCH" ? "refused" : "open");
  const kill = process.kill;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== owner) return kill(pid, signal);
    expect(signal).toBe(0);
    if (state === "running") return true;
    throw Object.assign(new Error("synthetic owner state"), { code: state });
  });
  return owner;
}
const route = (port = 3636) => ({
  TCP: { "443": { HTTPS: true } },
  Web: { [`${dnsName}:443`]: { Handlers: { "/": { Proxy: ownership(port).target } } } },
});

async function ownedFake(config: unknown = {}, marker: unknown = ownership(), currentDnsName = dnsName) {
  const status = { ...running, Self: { DNSName: currentDnsName } };
  const f = await fake(status, config);
  const stateDir = join(f.dir, "state");
  await mkdir(stateDir, { mode: 0o700 });
  const path = join(stateDir, "tailscale-serve.json");
  if (marker !== null) writeSecretFile(path, JSON.stringify(marker));
  const configPath = join(f.dir, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(f.dir, "tailscale"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(join(f.dir, "calls.jsonl"))}
if [ "$1" = status ]; then printf '%s\\n' ${quote(JSON.stringify(status))}
elif [ "$2" = status ]; then
  /bin/cat ${quote(configPath)}
  if [ -f ${quote(join(f.dir, "next-marker.json"))} ]; then
    /bin/cp ${quote(join(f.dir, "next-marker.json"))} ${quote(path)}
  fi
  if [ -f ${quote(join(f.dir, "next-config.json"))} ]; then
    /bin/cp ${quote(join(f.dir, "next-config.json"))} ${quote(configPath)}
    /bin/rm ${quote(join(f.dir, "next-config.json"))}
  fi
elif [ "$2" = --bg ]; then
  /bin/cp ${quote(path)} ${quote(join(f.dir, "marker-at-setup.json"))} 2>/dev/null || :
  if [ -f ${quote(join(f.dir, "deny-setup"))} ]; then printf 'Access denied: operator required' >&2; exit 1; fi
  https="\${3#--https=}"
  printf '{"TCP":{"%s":{"HTTPS":true}},"Web":{"${currentDnsName}:%s":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "$https" "$https" "$4" > ${quote(configPath)}
  if [ -f ${quote(join(f.dir, "fail-setup"))} ]; then exit 1; fi
elif [ "$3" = off ]; then
  if [ -f ${quote(join(f.dir, "fail-off"))} ]; then exit 1; fi
  printf '{}' > ${quote(configPath)}
fi
`,
    { mode: 0o700 },
  );
  return {
    ...f,
    stateDir,
    path,
    configPath,
    setup: (httpsPort?: number) =>
      ensureTailscaleServe(3636, f.env, currentDnsName, undefined, {
        ...f.options,
        stateDir,
        ...(httpsPort ? { httpsPort } : {}),
      }),
    stop: (port = 3636, httpsPort?: number) =>
      httpsPort
        ? removeTailscaleServe(port, f.env, currentDnsName, stateDir, process.pid, undefined, httpsPort)
        : removeTailscaleServe(port, f.env, currentDnsName, stateDir),
    args: async () => (await f.calls()).map((call) => call.args),
  };
}

async function stopState(env: NodeJS.ProcessEnv) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["stop"], {
    env,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

test("stale-route cleanup refuses a loose state folder before reading its marker", async () => {
  const f = await ownedFake(route(), ownership(3636, markerPid()));
  const before = await readFile(f.path);
  await chmod(f.stateDir, 0o770);
  const readMarker = vi.spyOn(markers, "readTailscaleMarker");
  await expect(removeStaleTailscaleServe(f.stateDir, f.env)).rejects.toBeInstanceOf(StateDirModeError);
  expect(readMarker).not.toHaveBeenCalled();
  expect(await readFile(f.path)).toEqual(before);
  expect((await stat(f.stateDir)).mode & 0o777).toBe(0o770);
  await expect(lstat(join(f.stateDir, "tailscale-serve.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.calls()).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(route());
});

test("stale-route cleanup leaves a missing state folder absent", async () => {
  const f = await ownedFake({}, null);
  await rm(f.stateDir, { recursive: true });
  expect(await removeStaleTailscaleServe(f.stateDir, f.env)).toEqual({ removed: false });
  await expect(lstat(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.calls()).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["open", "unknown", "refused"] as const)(
  "stale-route cleanup checks a dead pid's %s port before removing its route",
  async (answer) => {
    const f = await ownedFake(route(), ownership(3636, markerPid()));
    const before = await readFile(f.path);
    const probe = vi.mocked(markers.loopbackState).mockResolvedValue(answer);
    expect(await removeStaleTailscaleServe(f.stateDir, f.env)).toEqual(
      answer === "refused" ? { removed: true, dnsName } : { removed: false },
    );
    expect(probe).toHaveBeenCalledWith(3636);
    if (answer === "refused") {
      expect(await f.args()).toEqual([
        ["serve", "status", "--json"],
        ["serve", "--https=443", "off"],
      ]);
      await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
    } else {
      await expect(f.calls()).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(f.stateDir, "tailscale-serve.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(f.path)).toEqual(before);
      expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(route());
    }
  },
);

test.each(["open", "unknown"] as const)(
  "startup preserves another target with a dead pid while its port is %s",
  async (answer) => {
    const owner = markerPid();
    const f = await ownedFake(route(4000), ownership(4000, owner));
    const before = await readFile(f.path);
    const probe = vi.mocked(markers.loopbackState).mockResolvedValue(answer);
    await expect(f.setup()).rejects.toThrow(
      `another emend server (process ${owner}) serves port 443 of Tailscale Serve; stop that server, then try again.`,
    );
    expect(probe).toHaveBeenCalledWith(4000);
    expect(await f.args()).toEqual([["serve", "status", "--json"]]);
    expect(await readFile(f.path)).toEqual(before);
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(route(4000));
  },
);

test("stop removes a crashed server route when no server runs", async () => {
  const f = await ownedFake(route(), ownership(3636, markerPid()));
  const fetcher = vi.spyOn(globalThis, "fetch");
  expect(await stopState(f.env)).toEqual({
    code: 0,
    stdout: [
      `emend: no emend server is running; removed the Tailscale Serve route a stopped emend server left at https://${dnsName}\n`,
    ],
    stderr: [],
  });
  expect(await f.args()).toEqual([
    ["serve", "status", "--json"],
    ["serve", "--https=443", "off"],
  ]);
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(["missing", "invalid", "running", "EPERM"] as const)(
  "stop makes no Tailscale call with a %s marker",
  async (kind) => {
    const marker = kind === "missing" ? null : kind === "invalid" ? {} : ownership(3636, markerPid(kind));
    const f = await ownedFake(route(), marker);
    expect(await stopState(f.env)).toEqual({
      code: 0,
      stdout: ["emend: no emend server is running.\n"],
      stderr: [],
    });
    await expect(f.calls()).rejects.toMatchObject({ code: "ENOENT" });
    if (marker) expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(marker);
  },
);

test.each(["target", "dnsName", "pid", "invalid"])(
  "stop leaves a replaced marker alone when its %s changes before off",
  async (key) => {
    const original = ownership(3636, markerPid());
    const f = await ownedFake(route(), original);
    const changed =
      key === "invalid"
        ? {}
        : {
            ...original,
            ...(key === "target"
              ? { target: ownership(4000).target }
              : key === "dnsName"
                ? { dnsName: "other.example.ts.net" }
                : { pid: process.pid }),
          };
    await writeFile(join(f.dir, "next-marker.json"), JSON.stringify(changed));
    expect(await stopState(f.env)).toEqual({
      code: 0,
      stdout: ["emend: no emend server is running.\n"],
      stderr: [],
    });
    expect(await f.args()).toEqual([["serve", "status", "--json"]]);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(changed);
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(route());
  },
);

test.each([{}, route(4000)])(
  "stop discards a stale marker without changing a different Serve config: %j",
  async (config) => {
    const f = await ownedFake(config, ownership(3636, markerPid()));
    expect(await stopState(f.env)).toEqual({
      code: 0,
      stdout: ["emend: no emend server is running.\n"],
      stderr: [],
    });
    expect(await f.args()).toEqual([["serve", "status", "--json"]]);
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(config);
  },
);

test.each(["off", "unreadable"])(
  "stop reports a stale-route %s failure on stderr and keeps its marker",
  async (kind) => {
    const marker = ownership(3636, markerPid());
    const f = await ownedFake(route(), marker);
    if (kind === "off") await writeFile(join(f.dir, "fail-off"), "");
    else await writeFile(f.configPath, "{");
    const reason =
      kind === "off" ? "Could not configure Tailscale Serve." : "could not read the output of tailscale status.";
    expect(await stopState(f.env)).toEqual({
      code: 1,
      stdout: [],
      stderr: [
        `emend: no emend server is running, but removing the Tailscale Serve route it left at https://${dnsName} failed: ${reason}\n`,
      ],
    });
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(marker);
  },
);

test("stop escapes a stale-route failure reason as one stderr line", async () => {
  const marker = ownership(3636, markerPid());
  const f = await ownedFake(route(), marker);
  vi.spyOn(executables, "findExecutable").mockRejectedValue(new CliError("synthetic failure\nsecond line\u001b"));
  const result = await stopState(f.env);
  expect(result.code).toBe(1);
  expect(result.stdout).toEqual([]);
  expect(result.stderr).toEqual([
    `emend: no emend server is running, but removing the Tailscale Serve route it left at https://${dnsName} failed: synthetic failure\\u{a}second line\\u{1b}\n`,
  ]);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(marker);
});

test("a crash marker adopts the same route without setup and stop removes it", async () => {
  const f = await ownedFake(route(), ownership(3636, markerPid()));
  expect(await f.setup()).toMatchObject({ created: false, owned: true });
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
  await f.stop();
  expect(await f.args()).toEqual([
    ["serve", "status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--https=443", "off"],
  ]);
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("the same route without a marker remains unowned", async () => {
  const f = await ownedFake(route(), null);
  expect(await f.setup()).toMatchObject({ created: false, owned: false });
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("restart on the same port under a new DNS name replaces the old route without probing its own listener", async () => {
  const previous = { ...ownership(3636, markerPid()), dnsName: "old.example.ts.net" };
  const currentDnsName = "new.example.ts.net";
  const f = await ownedFake(
    {
      TCP: { "443": { HTTPS: true } },
      Web: { [`${previous.dnsName}:443`]: { Handlers: { "/": { Proxy: previous.target } } } },
    },
    previous,
    currentDnsName,
  );
  const probe = vi.mocked(markers.loopbackState).mockResolvedValue("open");
  const self = await tailscaleSelf(f.env, undefined, f.options);
  expect(self).toEqual({ dnsName: currentDnsName });
  expect(
    await ensureTailscaleServe(3636, f.env, self?.dnsName, undefined, { ...f.options, stateDir: f.stateDir }),
  ).toEqual({ created: true, owned: true, otherHttpsPorts: false });
  expect(probe).not.toHaveBeenCalled();
  expect(await f.args()).toEqual([
    ["status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--https=443", "off"],
    ["serve", "status", "--json"],
    ["serve", "--bg", "--https=443", previous.target],
  ]);
  const current = { target: previous.target, dnsName: currentDnsName, pid: process.pid };
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(current);
  expect(JSON.parse(await readFile(join(f.dir, "marker-at-setup.json"), "utf8"))).toEqual(current);
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({
    TCP: { "443": { HTTPS: true } },
    Web: { [`${currentDnsName}:443`]: { Handlers: { "/": { Proxy: previous.target } } } },
  });
});

test("a marker for another port removes only that exact stale route before setup", async () => {
  const f = await ownedFake(route(4000), ownership(4000, markerPid()));
  expect(await f.setup()).toMatchObject({ created: true, owned: true });
  expect(await f.args()).toEqual([
    ["serve", "status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--https=443", "off"],
    ["serve", "status", "--json"],
    ["serve", "--bg", "--https=443", ownership().target],
  ]);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
  expect(JSON.parse(await readFile(join(f.dir, "marker-at-setup.json"), "utf8"))).toEqual(ownership());
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
});

test.each((["running", "EPERM"] as const).map((state) => ({ port: 4000, state })))(
  "a live marker for port $port is refused without touching its route or marker ($state)",
  async ({ port, state }) => {
    const f = await ownedFake(route(port), ownership(port, markerPid(state)));
    const before = await readFile(f.path);
    await expect(f.setup()).rejects.toThrow(
      `another emend server (process 2000000000) serves port 443 of Tailscale Serve; stop that server, then try again.`,
    );
    expect(await f.args()).toEqual([["serve", "status", "--json"]]);
    expect(await readFile(f.path)).toEqual(before);
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(route(port));
  },
);

test.each(["running", "EPERM"] as const)(
  "after reboot, the same route is adopted when the marker pid belongs to an unrelated live process (%s)",
  async (state) => {
    const owner = markerPid(state);
    const f = await ownedFake(route(), ownership(3636, owner));
    expect(await f.setup()).toMatchObject({ created: false, owned: true });
    expect(process.kill).not.toHaveBeenCalledWith(owner, 0);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
    expect(await f.args()).toEqual([["serve", "status", "--json"]]);
    await f.stop();
    expect(await f.args()).toEqual([
      ["serve", "status", "--json"],
      ["serve", "status", "--json"],
      ["serve", "--https=443", "off"],
    ]);
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each(["running", "EPERM"] as const)(
  "a live marker for another port whose route is gone permits fresh setup (%s)",
  async (state) => {
    const owner = markerPid(state);
    const f = await ownedFake({}, ownership(4000, owner));
    expect(await f.setup()).toMatchObject({ created: true, owned: true });
    expect(process.kill).not.toHaveBeenCalledWith(owner, 0);
    expect(await f.args()).toEqual([
      ["serve", "status", "--json"],
      ["serve", "--bg", "--https=443", ownership().target],
    ]);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
    expect(JSON.parse(await readFile(join(f.dir, "marker-at-setup.json"), "utf8"))).toEqual(ownership());
    await removeTailscaleServe(4000, f.env, dnsName, f.stateDir, owner);
    expect((await f.args()).at(-1)).toEqual(["serve", "status", "--json"]);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(route());
  },
);

test("this process cannot replace its live marker for another port", async () => {
  const f = await ownedFake(route(4000), ownership(4000));
  const probe = vi.spyOn(markers, "loopbackState").mockResolvedValue("open");
  await expect(f.setup()).rejects.toThrow(
    `another emend server (process ${process.pid}) serves port 443 of Tailscale Serve; stop that server, then try again.`,
  );
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership(4000));
  expect(probe).toHaveBeenCalledWith(4000);
});

test("this process recovers a marker with its own reused pid when the old port is closed", async () => {
  const f = await ownedFake(route(4000), ownership(4000));
  const probe = vi.spyOn(markers, "loopbackState").mockResolvedValue("refused");
  expect(await f.setup()).toMatchObject({ created: true, owned: true });
  expect(probe).toHaveBeenCalledWith(4000);
  expect(await f.args()).toEqual([
    ["serve", "status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--https=443", "off"],
    ["serve", "status", "--json"],
    ["serve", "--bg", "--https=443", ownership().target],
  ]);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
});

test("a live owner on port 80 is refused without removing its route or marker", async () => {
  const f = await ownedFake(route(80), ownership(80, markerPid("running")));
  const before = await readFile(f.path);
  const probe = vi
    .spyOn(markers, "loopbackState")
    .mockImplementation(async (port) => (port === 80 ? "open" : "refused"));
  await expect(f.setup()).rejects.toThrow(
    "another emend server (process 2000000000) serves port 443 of Tailscale Serve; stop that server, then try again.",
  );
  expect(probe).toHaveBeenCalledWith(80);
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
  expect(await readFile(f.path)).toEqual(before);
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(route(80));
});

test("stale-route recovery rechecks before off and preserves a replacement route", async () => {
  const f = await ownedFake(route(4000), ownership(4000, markerPid()));
  await writeFile(join(f.dir, "next-config.json"), JSON.stringify(route(9999)));
  await expect(f.setup()).rejects.toThrow(
    "port 443 of Tailscale Serve already has a setup emend did not make or cannot read",
  );
  expect((await f.args()).every((args) => args.join(" ") === "serve status --json")).toBe(true);
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(route(9999));
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a changed occupied route discards the marker without an off call", async () => {
  const f = await ownedFake(route(9999));
  await expect(f.setup()).rejects.toThrow(
    "port 443 of Tailscale Serve already has a setup emend did not make or cannot read; inspect it with `tailscale serve status`.",
  );
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
});

test("an empty Serve config replaces a stale marker before normal setup", async () => {
  const f = await ownedFake({}, ownership(4000, markerPid()));
  expect(await f.setup()).toMatchObject({ created: true, owned: true });
  expect(await f.args()).toEqual([
    ["serve", "status", "--json"],
    ["serve", "--bg", "--https=443", ownership().target],
  ]);
  expect(JSON.parse(await readFile(join(f.dir, "marker-at-setup.json"), "utf8"))).toEqual(ownership());
});

test("a failed bg call retains ownership for recovery on the next run", async () => {
  const f = await ownedFake({}, null);
  await writeFile(join(f.dir, "fail-setup"), "");
  await expect(f.setup()).rejects.toThrow("Could not configure Tailscale Serve.");
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
  expect(await f.setup()).toMatchObject({ created: false, owned: true });
  await f.stop();
  expect((await f.args()).filter((args) => args.includes("--bg"))).toHaveLength(1);
  expect((await f.args()).at(-1)).toEqual(["serve", "--https=443", "off"]);
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("permission-denied setup discards its marker and never adopts a later root route", async () => {
  const f = await ownedFake({}, null);
  await writeFile(join(f.dir, "deny-setup"), "");
  await expect(f.setup()).rejects.toThrow("Could not configure Tailscale Serve. Run `sudo tailscale serve");
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(f.configPath, JSON.stringify(route()));
  expect(await f.setup()).toMatchObject({ created: false, owned: false });
  expect((await f.args()).some((args) => args.includes("off"))).toBe(false);
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a failed removal retains the marker for a later retry", async () => {
  const f = await ownedFake(route());
  await writeFile(join(f.dir, "fail-off"), "");
  await expect(f.stop()).rejects.toThrow("Could not configure Tailscale Serve.");
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
});

test.each([{}, route(9999)])("stop discards the marker when the route is no longer the same: %j", async (config) => {
  const f = await ownedFake(config);
  await f.stop();
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
});

test.each(["json", "port-zero", "port-large", "dns", "extra-key", "symlink", "dangling-symlink", "oversized"])(
  "an invalid %s marker is left in place and never grants ownership",
  async (kind) => {
    const f = await ownedFake(route());
    if (kind.endsWith("symlink")) {
      await rm(f.path);
      const target = join(f.stateDir, "target.json");
      if (kind === "symlink") await writeFile(target, JSON.stringify(ownership()));
      await symlink(target, f.path);
    } else
      await writeFile(
        f.path,
        kind === "json"
          ? "{"
          : kind === "oversized"
            ? " ".repeat(LIMITS.publicJsonBytes + 1)
            : JSON.stringify(
                kind === "dns"
                  ? { ...ownership(), dnsName: "bad/name.example" }
                  : kind === "extra-key"
                    ? { ...ownership(), extra: true }
                    : ownership(kind === "port-zero" ? 0 : 65536),
              ),
      );
    const before = await lstat(f.path);
    expect(await f.setup()).toMatchObject({ created: false, owned: false });
    expect((await lstat(f.path)).ino).toBe(before.ino);
    expect(await f.args()).toEqual([["serve", "status", "--json"]]);
  },
);

test.each([undefined, null, 0, -1, 1.5, "7", Number.MAX_SAFE_INTEGER + 1])(
  "a marker with pid %j is invalid and never adopted",
  async (pid) => {
    const marker = pid === undefined ? { target: ownership().target, dnsName } : { ...ownership(), pid };
    const f = await ownedFake(route(), marker);
    expect(await readTailscaleMarker(f.stateDir)).toEqual({ kind: "invalid" });
    expect(await f.setup()).toMatchObject({ created: false, owned: false });
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(marker);
    expect(await f.args()).toEqual([["serve", "status", "--json"]]);
  },
);

test("a missing state directory is not created to store a marker", async () => {
  const f = await ownedFake({}, null);
  await rm(f.stateDir, { recursive: true });
  await expect(f.setup()).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
});

test("a state-folder permission failure while reading the marker is reported", async () => {
  const f = await ownedFake(route());
  const readRegular = reads.readRegular;
  vi.spyOn(reads, "readRegular").mockImplementation(async (...args) => {
    if (args[0] === f.path) throw Object.assign(new Error("synthetic denial"), { code: "EPERM", path: f.stateDir });
    return readRegular(...args);
  });
  await expect(f.setup()).rejects.toBeInstanceOf(StateFolderWriteError);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
});

test("an unreadable marker is not adopted or removed when its folder is accessible", async () => {
  const f = await ownedFake(route());
  const readRegular = reads.readRegular;
  vi.spyOn(reads, "readRegular").mockImplementation(async (...args) => {
    if (args[0] === f.path)
      throw Object.assign(new Error("synthetic unreadable file"), { code: "EACCES", path: f.path });
    return readRegular(...args);
  });
  expect(await f.setup()).toMatchObject({ created: false, owned: false });
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
});

test("a marker-write permission failure prevents the bg call", async () => {
  const f = await ownedFake({}, null);
  vi.spyOn(stateFiles, "writeSecretFile").mockImplementation(() => {
    throw Object.assign(new Error("synthetic denial"), { code: "EACCES", path: f.path });
  });
  await expect(f.setup()).rejects.toBeInstanceOf(StateFolderWriteError);
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["json", "unreadable", "symlink"])(
  "an invalid %s marker is replaced before setup and supports crash recovery",
  async (kind) => {
    const f = await ownedFake({});
    await writeFile(f.path, "{");
    const other = join(f.dir, "other.json");
    if (kind === "symlink") {
      await rename(f.path, other);
      await symlink(other, f.path);
    } else if (kind === "unreadable") {
      const readRegular = reads.readRegular;
      let denied = false;
      vi.spyOn(reads, "readRegular").mockImplementation(async (...args) => {
        if (args[0] === f.path && !denied) {
          denied = true;
          throw Object.assign(new Error("synthetic denial"), { code: "EACCES", path: f.path });
        }
        return readRegular(...args);
      });
    }
    expect(await f.setup()).toMatchObject({ created: true, owned: true });
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
    expect(JSON.parse(await readFile(join(f.dir, "marker-at-setup.json"), "utf8"))).toEqual(ownership());
    if (kind === "symlink") expect(await readFile(other, "utf8")).toBe("{");
    writeSecretFile(f.path, JSON.stringify(ownership(3636, markerPid())));
    expect(await f.setup()).toMatchObject({ created: false, owned: true });
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
    await f.stop();
    expect((await f.args()).filter((args) => args.includes("--bg"))).toHaveLength(1);
    expect((await f.args()).at(-1)).toEqual(["serve", "--https=443", "off"]);
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("failure to replace an invalid marker refuses before setup", async () => {
  const f = await ownedFake({});
  await writeFile(f.path, "{");
  vi.spyOn(stateFiles, "writeSecretFile").mockImplementation(() => {
    throw Object.assign(new Error("synthetic denial"), { code: "EACCES", path: f.path });
  });
  await expect(f.setup()).rejects.toBeInstanceOf(StateFolderWriteError);
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
  expect(await readFile(f.path, "utf8")).toBe("{");
});

test("a marker for another DNS name does not own the current route", async () => {
  const f = await ownedFake(route(), { ...ownership(3636, markerPid()), dnsName: "other.example.ts.net" });
  expect(await f.setup()).toMatchObject({ created: false, owned: false });
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
});
test("empty config configures exact Serve argv", async () => {
  const f = await fake(running);
  const onSetup = vi.fn();
  expect(await ensureTailscaleServe(3636, f.env, undefined, onSetup, f.options)).toEqual({
    created: true,
    otherHttpsPorts: false,
  });
  expect(onSetup).toHaveBeenCalledOnce();
  expect((await f.calls()).map((c) => c.args)).toEqual([
    ["serve", "status", "--json"],
    ["serve", "--bg", "--https=443", "http://127.0.0.1:3636"],
  ]);
});
test("matching handler leaves Serve alone", async () => {
  const f = await fake(running, proxy);
  const onSetup = vi.fn();
  expect(await ensureTailscaleServe(3636, f.env, undefined, onSetup, f.options)).toEqual({
    created: false,
    otherHttpsPorts: false,
  });
  expect(onSetup).not.toHaveBeenCalled();
  expect(await f.calls()).toHaveLength(1);
});
test.each([
  {
    TCP: { "443": { HTTPS: true } },
    Web: { "hub.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
  },
  { TCP: { "443": { TCPForward: "localhost:9999" } } },
  {
    ...proxy,
    Web: {
      "hub.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3636" }, "/other": { Text: "hi" } } },
    },
  },
  null,
  [],
  { unexpected: true },
  { Web: { strange: {} } },
])("unexpected/occupied config is never overwritten: %j", async (config) => {
  const f = await fake(running, config);
  await expect(ensureTailscaleServe(3636, f.env, undefined, undefined, f.options)).rejects.toThrow(
    "port 443 of Tailscale Serve already has a setup emend did not make or cannot read; inspect it with `tailscale serve status`.",
  );
  expect(await f.calls()).toHaveLength(1);
});
test.each([3636, 41234])("permission error offers only root's route on fixed port %s", async (port) => {
  const f = await fake(running, {}, true);
  await expect(ensureTailscaleServe(port, f.env, undefined, undefined, f.options)).rejects.toMatchObject({
    message: `Could not configure Tailscale Serve. Run \`sudo tailscale serve --bg --https=443 http://127.0.0.1:${port}\` once as root, then try again. emend uses that route and never removes it.`,
  });
});
test("permission error for an ephemeral port asks for a fixed --port and a literal placeholder", async () => {
  const f = await fake(running, {}, true);
  await expect(
    ensureTailscaleServe(41999, f.env, undefined, undefined, { ...f.options, fixedPort: false }),
  ).rejects.toMatchObject({
    message:
      "Could not configure Tailscale Serve. Use a fixed --port, run `sudo tailscale serve --bg --https=443 http://127.0.0.1:<port>` once as root with that port, then try again.",
  });
});
test.each(["status", "off"] as const)("Serve %s permission errors keep the operator-only hint", async (command) => {
  const f = await fake(running, proxy, command === "status" ? "status" : true);
  const { removeTailscaleServe } = await import("./tailscale.ts");
  await expect(
    command === "status"
      ? ensureTailscaleServe(3636, f.env, undefined, undefined, f.options)
      : removeTailscaleServe(3636, f.env),
  ).rejects.toMatchObject({
    message: "Could not configure Tailscale Serve. Run `sudo tailscale set --operator=$USER` once, then try again.",
  });
  expect((await f.calls()).map((call) => call.args)).toEqual([
    ["serve", "status", "--json"],
    ...(command === "off" ? [["serve", "--https=443", "off"]] : []),
  ]);
});

test("an unrelated HTTPS port is preserved while 443 is configured", async () => {
  const f = await fake(running, {
    TCP: { "8443": { HTTPS: true } },
    Web: { "hub.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
  });
  await ensureTailscaleServe(3636, f.env, undefined, undefined, f.options);
  expect((await f.calls()).map((call) => call.args)).toEqual([
    ["serve", "status", "--json"],
    ["serve", "--bg", "--https=443", "http://127.0.0.1:3636"],
  ]);
});

test.each([
  { unexpected: {} },
  { ETag: {} },
  { TCP: { "0443": { HTTPS: true } } },
  { TCP: { "80": null } },
  { Web: { "hub.example.ts.net:8443": null } },
])("malformed config never causes a Serve mutation: %j", async (config) => {
  const f = await fake(running, config);
  await expect(ensureTailscaleServe(3636, f.env, undefined, undefined, f.options)).rejects.toThrow(
    "port 443 of Tailscale Serve already has a setup emend did not make or cannot read",
  );
  expect(await f.calls()).toHaveLength(1);
});

test.each([
  { ...proxy, Services: { "svc:synthetic": { TCP: { "443": { HTTPS: true } } } } },
  { ...proxy, AllowFunnel: { "other.example.ts.net:443": true, "hub.example.ts.net:8443": true } },
  { ...proxy, Foreground: {} },
  { ...proxy, Web: { "hub.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3636/" } } } } },
])("recognized ancillary config and one trailing slash reuse the target: %j", async (config) => {
  const f = await fake(running, config);
  await ensureTailscaleServe(3636, f.env, "hub.example.ts.net", undefined, f.options);
  expect(await f.calls()).toHaveLength(1);
});
test("unreadable/foreign Serve setup uses the exact revised wording", async () => {
  const f = await fake(running, { TCP: { "443": { TCPForward: "127.0.0.1:9999" } } });
  await expect(ensureTailscaleServe(3636, f.env, undefined, undefined, f.options)).rejects.toThrow(
    "port 443 of Tailscale Serve already has a setup emend did not make or cannot read; inspect it with `tailscale serve status`.",
  );
});
test("malformed status JSON prints the specific failure line", async () => {
  const f = await fake(running);
  await writeFile(join(f.dir, "tailscale"), "#!/bin/sh\nprintf '{not-json'\n", { mode: 0o700 });
  const stderr: string[] = [];
  expect(
    await run(["serve", "--tailscale"], { env: f.env, stdout: () => {}, stderr: (line) => stderr.push(line) }),
  ).toBe(1);
  expect(stderr).toEqual(["emend: could not read the output of tailscale status.\n"]);
});
test("a timed-out call prints the failure line for its internal deadline", async () => {
  const f = await fake(running);
  await writeFile(join(f.dir, "tailscale"), `#!/bin/sh\nwhile [ -d ${quote(f.dir)} ]; do :; done\n`, { mode: 0o700 });
  const tailscale = await import("./tailscale.ts");
  const self = tailscale.tailscaleSelf;
  vi.spyOn(tailscale, "tailscaleSelf").mockImplementation((env, signal) =>
    self(env, signal, { ...f.options, deadlineMs: 1_000 }),
  );
  const stderr: string[] = [];
  expect(
    await run(["serve", "--tailscale"], { env: f.env, stdout: () => {}, stderr: (line) => stderr.push(line) }),
  ).toBe(1);
  expect(stderr).toEqual(["emend: tailscale did not answer within 1 second.\n"]);
}, 5_000);
test.each(["stdout", "stderr"] as const)(
  "the 16 MiB output cap rejects excess %s even with valid status JSON",
  async (stream) => {
    const f = await fake(running);
    await symlink(process.execPath, join(f.dir, "node"));
    await writeFile(
      join(f.dir, "tailscale"),
      `#!/usr/bin/env node
process.${stream}.write(" ".repeat(16 * 1024 * 1024 + 1));
process.stdout.write(${JSON.stringify(JSON.stringify(running))});
`,
      { mode: 0o700 },
    );
    await expect(tailscaleSelf(f.env, undefined, f.options)).rejects.toThrow(
      "could not read the output of tailscale status.",
    );
  },
);
test("another HTTPS port on this SNI name is reported, unlike another name or plain HTTP", async () => {
  for (const [host, https, warning] of [
    ["hub.example.ts.net", true, true],
    ["other.example.ts.net", true, false],
    ["hub.example.ts.net", false, false],
  ] as const) {
    const f = await fake(running, {
      ...proxy,
      TCP: { ...proxy.TCP, "8443": https ? { HTTPS: true } : { HTTP: true } },
      Web: { ...proxy.Web, [`${host}:8443`]: { Handlers: { "/": { Text: "synthetic" } } } },
    });
    expect(await ensureTailscaleServe(3636, f.env, "hub.example.ts.net", undefined, f.options)).toEqual({
      created: false,
      otherHttpsPorts: warning,
    });
  }
});
test.each([
  ["hub.example.ts.net", true],
  ["other.example.ts.net", false],
  [undefined, false],
] as const)("TLS-terminated TCP for %s warns without a Web entry: %s", async (terminateTLS, warning) => {
  const f = await fake(running, {
    TCP: { "8443": { TCPForward: "127.0.0.1:8080", ...(terminateTLS ? { TerminateTLS: terminateTLS } : {}) } },
  });
  expect(await ensureTailscaleServe(3636, f.env, "hub.example.ts.net", undefined, f.options)).toEqual({
    created: true,
    otherHttpsPorts: warning,
  });
});
test("stop removes only an exactly matching handler with the exact off argv", async () => {
  const f = await fake(running, proxy);
  const { removeTailscaleServe } = await import("./tailscale.ts");
  await removeTailscaleServe(3636, f.env, "hub.example.ts.net");
  expect((await f.calls()).map((call) => call.args)).toEqual([
    ["serve", "status", "--json"],
    ["serve", "--https=443", "off"],
  ]);
});
test.each([
  {},
  { TCP: { "443": { TCPForward: "127.0.0.1:9999" } } },
  { ...proxy, AllowFunnel: { "hub.example.ts.net:443": true } },
  { Foreground: { session: proxy } },
])("stop never removes an absent, foreign or unexpected setup: %j", async (config) => {
  const f = await fake(running, config);
  const { removeTailscaleServe } = await import("./tailscale.ts");
  await removeTailscaleServe(3636, f.env, "hub.example.ts.net");
  expect(await f.calls()).toHaveLength(1);
});

test("the executable boundary survives mock restoration and refuses an unregistered app", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-unregistered-app-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "Tailscale"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  vi.restoreAllMocks();
  await expect(executables.findExecutable("Tailscale", dir)).rejects.toThrow("outside the test fixtures");
});

test("later Serve calls keep their owned environment after fixture removal", async () => {
  const f = await fake(running);
  const { removeTailscaleServe } = await import("./tailscale.ts");
  await ensureTailscaleServe(3636, f.env, undefined, undefined, f.options);
  await rm(f.dir, { recursive: true, force: true });
  await expect(ensureTailscaleServe(3636, f.env, undefined, undefined, f.options)).rejects.toThrow("not installed");
  await expect(removeTailscaleServe(3636, f.env)).rejects.toThrow("not installed");
});

function holdLock(stateDir: string) {
  const holder = new DatabaseSync(join(stateDir, "tailscale-serve.lock"));
  holder.exec("PRAGMA locking_mode = EXCLUSIVE");
  holder.exec("BEGIN EXCLUSIVE");
  return () => {
    holder.exec("ROLLBACK");
    holder.close();
  };
}
function waiting(onFirstWait: () => void) {
  let at = 0;
  let waits = 0;
  return {
    waits: () => waits,
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
      waits += 1;
      if (waits === 1) onFirstWait();
    },
  };
}

test("stop waits for the route lock and skips off when a server adopted the route meanwhile", async () => {
  const f = await ownedFake(route(), ownership(3636, markerPid()));
  const unlock = holdLock(f.stateDir);
  const adopted = ownership();
  const clock = waiting(() => {
    writeSecretFile(f.path, JSON.stringify(adopted));
    vi.mocked(markers.loopbackState).mockResolvedValue("open");
    unlock();
  });
  expect(await removeStaleTailscaleServe(f.stateDir, f.env, clock)).toEqual({ removed: false });
  expect(clock.waits()).toBe(1);
  await expect(f.calls()).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(adopted);
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(route());
});

test("stop rechecks an unchanged marker whose reused pid opened its port while the lock was held", async () => {
  const f = await ownedFake(route(), ownership(3636, markerPid("running")));
  const before = await readFile(f.path);
  const probe = vi.spyOn(markers, "loopbackState").mockResolvedValue("refused");
  const unlock = holdLock(f.stateDir);
  const clock = waiting(() => {
    probe.mockResolvedValue("open");
    unlock();
  });
  expect(await removeStaleTailscaleServe(f.stateDir, f.env, clock)).toEqual({ removed: false });
  expect(clock.waits()).toBe(1);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(probe).toHaveBeenLastCalledWith(3636);
  await expect(f.calls()).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.path)).toEqual(before);
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(route());
});

test("startup recovery of another target waits for the route lock and yields to an adopting server", async () => {
  const f = await ownedFake(route(4000), ownership(4000, markerPid()));
  const unlock = holdLock(f.stateDir);
  const adopted = ownership(4000);
  const clock = waiting(() => {
    writeSecretFile(f.path, JSON.stringify(adopted));
    vi.mocked(markers.loopbackState).mockResolvedValue("open");
    unlock();
  });
  await expect(
    ensureTailscaleServe(3636, f.env, dnsName, undefined, { ...f.options, stateDir: f.stateDir, lock: clock }),
  ).rejects.toThrow(
    `another emend server (process ${process.pid}) serves port 443 of Tailscale Serve; stop that server, then try again.`,
  );
  expect(clock.waits()).toBe(1);
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(adopted);
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(route(4000));
});

test("a route change refuses with the lock message when another emend holds the lock past the deadline", async () => {
  const f = await ownedFake(route(), ownership(3636, markerPid()));
  const unlock = holdLock(f.stateDir);
  let at = 0;
  const lock = {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
    },
    timeoutMs: 100,
  };
  const message = "another emend is changing the Tailscale Serve route; try again.";
  await expect(removeStaleTailscaleServe(f.stateDir, f.env, lock)).rejects.toThrow(message);
  await expect(removeTailscaleServe(3636, f.env, dnsName, f.stateDir, undefined, lock)).rejects.toThrow(message);
  await expect(
    ensureTailscaleServe(3636, f.env, dnsName, undefined, { ...f.options, stateDir: f.stateDir, lock }),
  ).rejects.toThrow(message);
  unlock();
  await expect(f.calls()).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["missing", "invalid", "live"] as const)("a %s marker creates no lock file", async (kind) => {
  const marker = kind === "missing" ? null : kind === "invalid" ? {} : ownership(3636, markerPid("running"));
  const f = await ownedFake(route(), marker);
  expect(await removeStaleTailscaleServe(f.stateDir, f.env)).toEqual({ removed: false });
  await expect(lstat(join(f.stateDir, "tailscale-serve.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.calls()).rejects.toMatchObject({ code: "ENOENT" });
});

test("a reused pid with a closed port on another port is recovered, then this route is created", async () => {
  const f = await ownedFake(route(4000), ownership(4000, markerPid("running")));
  const probe = vi.spyOn(markers, "loopbackState").mockResolvedValue("refused");
  expect(await f.setup()).toMatchObject({ created: true, owned: true });
  expect(probe).toHaveBeenCalledWith(4000);
  expect(await f.args()).toEqual([
    ["serve", "status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--https=443", "off"],
    ["serve", "status", "--json"],
    ["serve", "--bg", "--https=443", ownership().target],
  ]);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
});

test("stop removes the route of a reused pid whose port is closed", async () => {
  const f = await ownedFake(route(), ownership(3636, markerPid("EPERM")));
  const probe = vi.spyOn(markers, "loopbackState").mockResolvedValue("refused");
  expect(await stopState(f.env)).toEqual({
    code: 0,
    stdout: [
      `emend: no emend server is running; removed the Tailscale Serve route a stopped emend server left at https://${dnsName}\n`,
    ],
    stderr: [],
  });
  expect(probe).toHaveBeenCalledWith(3636);
  expect((await f.args()).at(-1)).toEqual(["serve", "--https=443", "off"]);
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["open", "unknown"] as const)("a live pid whose port answers %s is a running owner", async (answer) => {
  const f = await ownedFake(route(4000), ownership(4000, markerPid("running")));
  vi.spyOn(markers, "loopbackState").mockResolvedValue(answer);
  await expect(f.setup()).rejects.toThrow("another emend server (process 2000000000) serves port 443");
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(route(4000));
});

test.each([
  { event: "timeout", state: "unknown" },
  { event: "EHOSTUNREACH", state: "unknown" },
  { event: "ECONNREFUSED", state: "refused" },
  { event: "connect", state: "open" },
])("the loopback probe reports $state after $event and destroys its socket", async ({ event, state }) => {
  vi.useFakeTimers();
  const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const connect = vi.spyOn(net, "connect").mockReturnValue(socket as unknown as net.Socket);
  const result = loopbackState(3636);
  expect(connect).toHaveBeenCalledWith({ host: "127.0.0.1", port: 3636 });
  if (event === "timeout") await vi.advanceTimersByTimeAsync(500);
  else if (event === "connect") socket.emit("connect");
  else socket.emit("error", Object.assign(new Error("synthetic connection error"), { code: event }));
  expect(await result).toBe(state);
  expect(socket.destroy).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

const chosen = 13636;
const routeOn = (httpsPort: number, port = 3636) => ({
  TCP: { [String(httpsPort)]: { HTTPS: true } },
  Web: { [`${dnsName}:${httpsPort}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
});
const ownershipOn = (httpsPort: number, port = 3636, pid = process.pid) => ({ ...ownership(port, pid), httpsPort });

test("a chosen HTTPS port is used for setup, the marker and the permission hint", async () => {
  const f = await ownedFake({}, null);
  expect(await f.setup(chosen)).toMatchObject({ created: true, owned: true });
  expect(await f.args()).toEqual([
    ["serve", "status", "--json"],
    ["serve", "--bg", `--https=${chosen}`, ownership().target],
  ]);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownershipOn(chosen));
  await f.stop(3636, chosen);
  expect((await f.args()).at(-1)).toEqual(["serve", `--https=${chosen}`, "off"]);
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });

  const denied = await fake(running, {}, true);
  await expect(
    ensureTailscaleServe(3636, denied.env, undefined, undefined, { ...denied.options, httpsPort: chosen }),
  ).rejects.toMatchObject({
    message: `Could not configure Tailscale Serve. Run \`sudo tailscale serve --bg --https=${chosen} http://127.0.0.1:3636\` once as root, then try again. emend uses that route and never removes it.`,
  });
  const ephemeral = await fake(running, {}, true);
  await expect(
    ensureTailscaleServe(41999, ephemeral.env, undefined, undefined, {
      ...ephemeral.options,
      httpsPort: chosen,
      fixedPort: false,
    }),
  ).rejects.toMatchObject({ message: expect.stringContaining(`--bg --https=${chosen} http://127.0.0.1:<port>`) });
});

test.each([0, 65536, 1.5, Number.NaN])(
  "an invalid HTTPS port %s is refused before Serve is read",
  async (httpsPort) => {
    const f = await fake(running);
    await expect(ensureTailscaleServe(3636, f.env, undefined, undefined, { ...f.options, httpsPort })).rejects.toThrow(
      "Invalid Tailscale Serve HTTPS port.",
    );
    await expect(lstat(join(f.dir, "calls.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("a foreign or unreadable setup on the chosen port is occupied and left alone", async () => {
  const foreign = routeOn(chosen, 9999);
  for (const config of [
    foreign,
    { TCP: { [String(chosen)]: { TCPForward: "localhost:9999" } } },
    { AllowFunnel: { [`${dnsName}:${chosen}`]: true } },
  ]) {
    const f = await fake(running, config);
    await expect(
      ensureTailscaleServe(3636, f.env, dnsName, undefined, { ...f.options, httpsPort: chosen }),
    ).rejects.toThrow(
      `port ${chosen} of Tailscale Serve already has a setup emend did not make or cannot read; inspect it with \`tailscale serve status\`.`,
    );
    expect(await f.calls()).toHaveLength(1);
  }
});

test("a setup on 443 is not considered when another port is chosen, and a 443 funnel does not block it", async () => {
  const config = { ...route(9999), AllowFunnel: { [`${dnsName}:443`]: true } };
  const f = await fake(running, config);
  expect(await ensureTailscaleServe(3636, f.env, dnsName, undefined, { ...f.options, httpsPort: chosen })).toEqual({
    created: true,
    otherHttpsPorts: true,
  });
  expect((await f.calls()).map((call) => call.args)).toEqual([
    ["serve", "status", "--json"],
    ["serve", "--bg", `--https=${chosen}`, "http://127.0.0.1:3636"],
  ]);
  // The chosen port is the one that is not "other".
  const mine = await fake(running, routeOn(chosen));
  expect(
    await ensureTailscaleServe(3636, mine.env, dnsName, undefined, { ...mine.options, httpsPort: chosen }),
  ).toEqual({
    created: false,
    otherHttpsPorts: false,
  });
});

test("a same-target route made by root on the chosen port is used and not owned", async () => {
  const f = await ownedFake(routeOn(chosen), null);
  expect(await f.setup(chosen)).toMatchObject({ created: false, owned: false });
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a crash marker on the chosen port adopts the same route", async () => {
  const f = await ownedFake(routeOn(chosen), ownershipOn(chosen, 3636, markerPid()));
  expect(await f.setup(chosen)).toMatchObject({ created: false, owned: true });
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownershipOn(chosen));
  expect(await f.args()).toEqual([["serve", "status", "--json"]]);
});

test("a port change removes emend's old route and only that one", async () => {
  const f = await ownedFake(route(), ownership(3636, markerPid("running")));
  expect(await f.setup(chosen)).toMatchObject({ created: true, owned: true });
  expect(await f.args()).toEqual([
    ["serve", "status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--https=443", "off"],
    ["serve", "status", "--json"],
    ["serve", "--bg", `--https=${chosen}`, ownership().target],
  ]);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownershipOn(chosen));

  const back = await ownedFake(routeOn(chosen), ownershipOn(chosen, 3636, markerPid("running")));
  expect(await back.setup()).toMatchObject({ created: true, owned: true });
  expect((await back.args()).filter((args) => args.includes("off"))).toEqual([["serve", `--https=${chosen}`, "off"]]);
  expect(JSON.parse(await readFile(back.path, "utf8"))).toEqual(ownership());
});

test("a port change leaves a route on the old port that is no longer emend's", async () => {
  const f = await ownedFake(route(9999), ownership(3636, markerPid("running")));
  expect(await f.setup(chosen)).toMatchObject({ created: true, owned: true });
  expect((await f.args()).filter((args) => args.includes("off"))).toEqual([]);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownershipOn(chosen));
});

test("a port change is refused while another process owns a different loopback port", async () => {
  const f = await ownedFake(routeOn(chosen, 4000), ownershipOn(chosen, 4000, markerPid("running")));
  await expect(f.setup()).rejects.toThrow(
    `another emend server (process 2000000000) serves port ${chosen} of Tailscale Serve; stop that server, then try again.`,
  );
  expect((await f.args()).filter((args) => args.includes("off"))).toEqual([]);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownershipOn(chosen, 4000, 2_000_000_000));
});

test("stop removes only the route on the marker's port and names its origin", async () => {
  const both = { TCP: { ...route().TCP, ...routeOn(chosen).TCP }, Web: { ...route().Web, ...routeOn(chosen).Web } };
  const f = await ownedFake(both, ownershipOn(chosen, 3636, markerPid()));
  expect(await stopState(f.env)).toEqual({
    code: 0,
    stdout: [
      `emend: no emend server is running; removed the Tailscale Serve route a stopped emend server left at https://${dnsName}:${chosen}\n`,
    ],
    stderr: [],
  });
  expect(await f.args()).toEqual([
    ["serve", "status", "--json"],
    ["serve", `--https=${chosen}`, "off"],
  ]);
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  // The 443 route stays: nothing here touched it.
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
});

test("stop names the chosen port when a stale-route removal fails", async () => {
  const marker = ownershipOn(chosen, 3636, markerPid());
  const f = await ownedFake(routeOn(chosen), marker);
  await writeFile(join(f.dir, "fail-off"), "");
  expect(await stopState(f.env)).toEqual({
    code: 1,
    stdout: [],
    stderr: [
      `emend: no emend server is running, but removing the Tailscale Serve route it left at https://${dnsName}:${chosen} failed: Could not configure Tailscale Serve.\n`,
    ],
  });
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(marker);
});

test("stop leaves a chosen-port marker's route alone when only 443 holds the target", async () => {
  const f = await ownedFake(route(), ownershipOn(chosen, 3636, markerPid()));
  const result = await removeStaleTailscaleServe(f.stateDir, f.env);
  expect(result).toEqual({ removed: false });
  expect((await f.args()).filter((args) => args.includes("off"))).toEqual([]);
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("the marker accepts the three-key and the four-key shape and nothing else", async () => {
  const valid = [ownership(), ownershipOn(chosen), ownershipOn(1), ownershipOn(65535)];
  for (const marker of valid) {
    const f = await ownedFake({}, marker);
    const read = await readTailscaleMarker(f.stateDir);
    expect(read).toMatchObject({ kind: "valid", route: marker });
  }
  const invalid = [
    ownershipOn(443),
    ownershipOn(0),
    ownershipOn(65536),
    ownershipOn(1.5),
    { ...ownership(), httpsPort: "13636" },
    { ...ownership(), httpsPort: null },
    { ...ownership(), other: chosen },
    { ...ownershipOn(chosen), extra: true },
  ];
  for (const marker of invalid) {
    const f = await ownedFake({}, marker);
    expect(await readTailscaleMarker(f.stateDir)).toEqual({ kind: "invalid" });
  }
});

test("the marker removal and the writer compare and write the port", async () => {
  const f = await ownedFake({}, ownershipOn(chosen));
  await markers.removeTailscaleMarker(f.stateDir, ownership());
  expect(await readTailscaleMarker(f.stateDir)).toMatchObject({ kind: "valid" });
  await markers.removeTailscaleMarker(f.stateDir, ownershipOn(443));
  expect(await readTailscaleMarker(f.stateDir)).toMatchObject({ kind: "valid" });
  markers.writeTailscaleMarker(f.stateDir, { ...ownership(), httpsPort: 443 });
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(ownership());
  markers.writeTailscaleMarker(f.stateDir, ownershipOn(chosen));
  await markers.removeTailscaleMarker(f.stateDir, ownershipOn(chosen));
  await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});
