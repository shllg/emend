import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { run } from "../main.ts";
import { ensureTailscaleServe, tailscaleSelf } from "./tailscale.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  vi.stubEnv("PATH", `.:relative:${dir}`);
  vi.stubEnv("NODE_OPTIONS", "--this-must-not-be-inherited");
  return {
    dir,
    calls: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => ({ args: line.split(" ") })),
    env: async () =>
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
  expect(await tailscaleSelf()).toEqual({ dnsName: "hub.example.ts.net" });
  const [call] = await f.calls();
  expect(call?.args).toEqual(["status", "--json"]);
  expect(await f.env()).toEqual({ PATH: f.dir, HOME: process.env.HOME, LC_ALL: "C" });
});
test.each([true, false])(
  "darwin runs the app with the caller's filtered PATH (absolute entries: %s)",
  async (absolute) => {
    const app = await fakeApp();
    const searchPath = absolute ? `${join(app.dir, "first")}:${join(app.dir, "second")}` : "";
    const env = {
      PATH: `.:relative:${searchPath}:`,
      HOME: join(app.dir, "home"),
      LC_ALL: "fr_FR.UTF-8",
      NODE_OPTIONS: "--this-must-not-be-inherited",
    };
    expect(await tailscaleSelf(env, undefined, { platform: "darwin", appPath: app.appPath })).toEqual({
      dnsName: "hub.example.ts.net",
    });
    expect(await app.calls()).toEqual([{ args: ["status", "--json"] }]);
    expect(await app.env()).toEqual({
      PATH: absolute ? searchPath : "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: env.HOME,
      LC_ALL: "C",
    });
  },
);
test.each([undefined, ""])("darwin uses a fixed spawn PATH when the caller's PATH is %j", async (path) => {
  const app = await fakeApp();
  const env = { PATH: path, HOME: join(app.dir, "home") };
  expect(await tailscaleSelf(env, undefined, { platform: "darwin", appPath: app.appPath })).toEqual({
    dnsName: "hub.example.ts.net",
  });
  expect(await app.calls()).toEqual([{ args: ["status", "--json"] }]);
  expect(await app.env()).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: env.HOME, LC_ALL: "C" });
});
test("darwin prefers tailscale on PATH over the app", async () => {
  const app = await fakeApp();
  const path = await fake(running);
  expect(await tailscaleSelf(process.env, undefined, { platform: "darwin", appPath: app.appPath })).toEqual({
    dnsName: "hub.example.ts.net",
  });
  expect(await path.calls()).toEqual([{ args: ["status", "--json"] }]);
  expect(await path.env()).toEqual({ PATH: path.dir, HOME: process.env.HOME, LC_ALL: "C" });
  await expect(app.calls()).rejects.toMatchObject({ code: "ENOENT" });
});
test("linux never uses the app even when it is executable", async () => {
  const app = await fakeApp();
  await expect(tailscaleSelf(process.env, undefined, { platform: "linux", appPath: app.appPath })).rejects.toThrow(
    "tailscale is not installed or not on PATH.",
  );
  await expect(app.calls()).rejects.toMatchObject({ code: "ENOENT" });
});
test.each(["missing", "non-executable", "directory"])("darwin rejects a %s app binary", async (kind) => {
  const app = await fakeApp();
  if (kind === "non-executable") await chmod(app.appPath, 0o600);
  else {
    await rm(app.appPath);
    if (kind === "directory") await mkdir(app.appPath);
  }
  await expect(tailscaleSelf(process.env, undefined, { platform: "darwin", appPath: app.appPath })).rejects.toThrow(
    "tailscale is not installed or not on PATH.",
  );
  await expect(app.calls()).rejects.toMatchObject({ code: "ENOENT" });
});
test.each(["NeedsLogin", "Stopped"])("%s returns null and the CLI prints the required line", async (state) => {
  await fake({ BackendState: state });
  expect(await tailscaleSelf()).toBeNull();
  const stderr: string[] = [];
  const stdout: string[] = [];
  expect(
    await run(["serve", "--tailscale"], {
      env: process.env,
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
  await fake({ BackendState: "Running", Self: { DNSName: name } });
  expect(await tailscaleSelf()).toBeNull();
});
test("missing binary prints only the fixed error", async () => {
  const app = await fakeApp();
  await rm(app.appPath);
  const tailscale = await import("./tailscale.ts");
  const self = tailscale.tailscaleSelf;
  vi.spyOn(tailscale, "tailscaleSelf").mockImplementation((env, signal) =>
    self(env, signal, { platform: "darwin", appPath: app.appPath }),
  );
  vi.stubEnv("PATH", ".:relative");
  const stderr: string[] = [];
  expect(
    await run(["serve", "--tailscale"], {
      env: process.env,
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
test("empty config configures exact Serve argv", async () => {
  const f = await fake(running);
  const onSetup = vi.fn();
  expect(await ensureTailscaleServe(3636, process.env, undefined, onSetup)).toEqual({
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
  expect(await ensureTailscaleServe(3636, process.env, undefined, onSetup)).toEqual({
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
  await expect(ensureTailscaleServe(3636)).rejects.toThrow(
    "port 443 of Tailscale Serve already has a setup emend did not make or cannot read; inspect it with `tailscale serve status`.",
  );
  expect(await f.calls()).toHaveLength(1);
});
test.each([3636, 41234])("permission error offers only root's route on fixed port %s", async (port) => {
  await fake(running, {}, true);
  await expect(ensureTailscaleServe(port)).rejects.toMatchObject({
    message: `Could not configure Tailscale Serve. Run \`sudo tailscale serve --bg --https=443 http://127.0.0.1:${port}\` once as root, then try again. emend uses that route and never removes it.`,
  });
});
test("permission error for an ephemeral port asks for a fixed --port and a literal placeholder", async () => {
  await fake(running, {}, true);
  await expect(
    ensureTailscaleServe(41999, process.env, undefined, undefined, { fixedPort: false }),
  ).rejects.toMatchObject({
    message:
      "Could not configure Tailscale Serve. Use a fixed --port, run `sudo tailscale serve --bg --https=443 http://127.0.0.1:<port>` once as root with that port, then try again.",
  });
});
test.each(["status", "off"] as const)("Serve %s permission errors keep the operator-only hint", async (command) => {
  const f = await fake(running, proxy, command === "status" ? "status" : true);
  const { removeTailscaleServe } = await import("./tailscale.ts");
  await expect(command === "status" ? ensureTailscaleServe(3636) : removeTailscaleServe(3636)).rejects.toMatchObject({
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
  await ensureTailscaleServe(3636);
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
  await expect(ensureTailscaleServe(3636)).rejects.toThrow(
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
  await ensureTailscaleServe(3636, process.env, "hub.example.ts.net");
  expect(await f.calls()).toHaveLength(1);
});
test("unreadable/foreign Serve setup uses the exact revised wording", async () => {
  await fake(running, { TCP: { "443": { TCPForward: "127.0.0.1:9999" } } });
  await expect(ensureTailscaleServe(3636)).rejects.toThrow(
    "port 443 of Tailscale Serve already has a setup emend did not make or cannot read; inspect it with `tailscale serve status`.",
  );
});
test("malformed status JSON prints the specific failure line", async () => {
  const f = await fake(running);
  await writeFile(join(f.dir, "tailscale"), "#!/bin/sh\nprintf '{not-json'\n", { mode: 0o700 });
  const stderr: string[] = [];
  expect(
    await run(["serve", "--tailscale"], { env: process.env, stdout: () => {}, stderr: (line) => stderr.push(line) }),
  ).toBe(1);
  expect(stderr).toEqual(["emend: could not read the output of tailscale status.\n"]);
});
test("a timed-out call prints the failure line for its internal deadline", async () => {
  const f = await fake(running);
  await writeFile(join(f.dir, "tailscale"), `#!/bin/sh\nwhile [ -d ${quote(f.dir)} ]; do :; done\n`, { mode: 0o700 });
  const tailscale = await import("./tailscale.ts");
  const self = tailscale.tailscaleSelf;
  vi.spyOn(tailscale, "tailscaleSelf").mockImplementation((env, signal) => self(env, signal, { deadlineMs: 1_000 }));
  const stderr: string[] = [];
  expect(
    await run(["serve", "--tailscale"], { env: process.env, stdout: () => {}, stderr: (line) => stderr.push(line) }),
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
    await expect(tailscaleSelf()).rejects.toThrow("could not read the output of tailscale status.");
  },
);
test("another HTTPS port on this SNI name is reported, unlike another name or plain HTTP", async () => {
  for (const [host, https, warning] of [
    ["hub.example.ts.net", true, true],
    ["other.example.ts.net", true, false],
    ["hub.example.ts.net", false, false],
  ] as const) {
    await fake(running, {
      ...proxy,
      TCP: { ...proxy.TCP, "8443": https ? { HTTPS: true } : { HTTP: true } },
      Web: { ...proxy.Web, [`${host}:8443`]: { Handlers: { "/": { Text: "synthetic" } } } },
    });
    expect(await ensureTailscaleServe(3636, process.env, "hub.example.ts.net")).toEqual({
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
  await fake(running, {
    TCP: { "8443": { TCPForward: "127.0.0.1:8080", ...(terminateTLS ? { TerminateTLS: terminateTLS } : {}) } },
  });
  expect(await ensureTailscaleServe(3636, process.env, "hub.example.ts.net")).toEqual({
    created: true,
    otherHttpsPorts: warning,
  });
});
test("stop removes only an exactly matching handler with the exact off argv", async () => {
  const f = await fake(running, proxy);
  const { removeTailscaleServe } = await import("./tailscale.ts");
  await removeTailscaleServe(3636, process.env, "hub.example.ts.net");
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
  await removeTailscaleServe(3636, process.env, "hub.example.ts.net");
  expect(await f.calls()).toHaveLength(1);
});
