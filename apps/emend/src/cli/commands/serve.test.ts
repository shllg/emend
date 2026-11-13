import * as childProcesses from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { run } from "../../main.ts";
import { startServer } from "../../server/serve.ts";
import { writeSecretFile } from "../../state/files.ts";
import * as executables from "../executable.ts";
import { stopLocalServer } from "../service/takeover.ts";
import { parseServeArgs, UsageError } from "./serve.ts";

vi.mock("../../server/serve.ts", () => ({ startServer: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
}));
// Keep fixture-only lookup active after API spies are restored, including the macOS fallback.
const executableDirs = new Set<string>();
vi.mock("../executable.ts", async (original) => {
  const actual = await original<typeof import("../executable.ts")>();
  return {
    async findExecutable(...args: Parameters<typeof actual.findExecutable>) {
      const searchPath = args[1];
      if (
        searchPath === undefined ||
        searchPath
          .split(delimiter)
          .filter(Boolean)
          .some((entry) => ![...executableDirs].some((dir) => entry === dir || entry.startsWith(`${dir}${sep}`)))
      )
        throw new Error("executable lookup outside the test fixtures");
      return actual.findExecutable(...args);
    },
  };
});
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  // Finished hooks run in reverse registration order, after afterEach: restore spies last.
  onTestFinished(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const dir = await mkdtemp(join(tmpdir(), "emend-serve-test-"));
  executableDirs.add(dir);
  onTestFinished(async () => {
    executableDirs.delete(dir);
    await rm(dir, { recursive: true, force: true });
  });
  const bin = join(dir, "bin");
  await mkdir(bin);
  env = {
    EMEND_HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"),
    HOME: dir,
    PATH: bin,
    NODE_OPTIONS: "--this-must-not-be-inherited",
  };
});

test.each(["owned", "unowned", "failed-off"])("serve recovers a route left by a crash (%s)", async (kind) => {
  const root = env.EMEND_HOME as string;
  const stateDir = root;
  const bin = env.PATH as string;
  const path = join(stateDir, "tailscale-serve.json");
  const dnsName = "hub.example.ts.net";
  const target = "http://127.0.0.1:3636";
  if (kind !== "unowned") writeSecretFile(path, JSON.stringify({ target, dnsName, pid: process.pid }));
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      TCP: { "443": { HTTPS: true } },
      Web: {
        [`${dnsName}:443`]: { Handlers: { "/": { Proxy: target } } },
      },
    }),
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const log = join(root, "calls.jsonl");
  await writeFile(
    join(bin, "tailscale"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(log)}
if [ "$2" = status ]; then /bin/cat ${quote(config)}
elif [ "$3" = off ]; then ${kind === "failed-off" ? "exit 1" : `printf '{}' > ${quote(config)}`}
else exit 1
fi
`,
    { mode: 0o700 },
  );
  const tailscale = await import("../tailscale.ts");
  vi.spyOn(tailscale, "tailscaleSelf").mockResolvedValue({ dnsName });
  let stop: (() => void) | undefined;
  const close = vi.fn(async () => {});
  vi.mocked(startServer).mockImplementation(async (options) => {
    stop = options.onStopRequest;
    return { url: target, port: 3636, setPublicOriginReady: vi.fn(), close };
  });
  const stdout = vi.fn(() => stop?.());
  const stderr = vi.fn();
  const result = run(["serve", "--tailscale"], { env, stdout, stderr });
  onTestFinished(async () => {
    stop?.();
    await result;
  });
  try {
    expect(await result).toBe(0);
    expect(startServer).toHaveBeenCalledWith(
      expect.objectContaining({ configFile: join(env.XDG_CONFIG_HOME as string, "emend", "config.json") }),
    );
    expect(stdout).toHaveBeenCalledExactlyOnceWith(`emend: serving https://${dnsName}\n`);
    expect(close).toHaveBeenCalledOnce();
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    expect(calls).toEqual(
      kind === "unowned"
        ? ["serve status --json"]
        : ["serve status --json", "serve status --json", "serve --https=443 off"],
    );
    if (kind === "failed-off") {
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ target, dnsName, pid: process.pid });
      expect(stderr).toHaveBeenCalledExactlyOnceWith("emend: Could not configure Tailscale Serve.\n");
    } else {
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(stderr).not.toHaveBeenCalled();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["permission", "timeout"])("a %s setup failure cleans up only possible ownership", async (kind) => {
  const stateDir = env.EMEND_HOME as string;
  const path = join(stateDir, "tailscale-serve.json");
  const dnsName = "hub.example.ts.net";
  const target = "http://127.0.0.1:3636";
  const marker = { target, dnsName, pid: process.pid };
  let config: unknown = {};
  const matching = {
    TCP: { "443": { HTTPS: true } },
    Web: { [`${dnsName}:443`]: { Handlers: { "/": { Proxy: target } } } },
  };
  const calls: string[][] = [];
  const started = Promise.withResolvers<void>();
  let bg: (EventEmitter & { stdout: PassThrough; stderr: PassThrough }) | undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(executables, "findExecutable").mockResolvedValue({
    file: join(env.PATH as string, "tailscale"),
    path: env.PATH as string,
  });
  vi.spyOn(childProcesses, "spawn").mockImplementation((_file, args) => {
    if (!Array.isArray(args)) throw new Error("expected helper arguments");
    calls.push(args);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    if (args[1] === "--bg") {
      bg = child;
      // A timeout may apply the route; a denied user may see a root-owned route.
      config = matching;
      if (kind === "timeout") child.stdout.once("close", () => child.emit("close", 1, null));
      started.resolve();
    } else
      queueMicrotask(() => {
        if (args[1] === "status") child.stdout.write(JSON.stringify(config));
        else if (args[2] === "off") config = {};
        child.emit("close", 0, null);
      });
    return child as unknown as childProcesses.ChildProcess;
  });
  const tailscale = await import("../tailscale.ts");
  vi.spyOn(tailscale, "tailscaleSelf").mockResolvedValue({ dnsName });
  const remove = tailscale.removeTailscaleServe;
  let markerAtCleanup: unknown;
  const cleanup = vi.spyOn(tailscale, "removeTailscaleServe").mockImplementation(async (...args) => {
    markerAtCleanup = JSON.parse(await readFile(path, "utf8"));
    return remove(...args);
  });
  const close = vi.fn(async () => {});
  vi.mocked(startServer).mockResolvedValue({ url: target, port: 3636, setPublicOriginReady: vi.fn(), close });
  const stdout = vi.fn();
  const stderr = vi.fn();
  const result = run(["serve", "--tailscale"], { env, stdout, stderr });
  onTestFinished(async () => {
    bg?.emit("close", 1, null);
    await result;
    vi.useRealTimers();
  });
  try {
    await started.promise;
    const stored = JSON.parse(await readFile(path, "utf8"));
    expect(stored).toMatchObject({ target, dnsName });
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(10_000);
    else {
      bg?.stderr.write("Access denied: operator required");
      bg?.emit("close", 1, null);
    }
    expect(await result).toBe(1);
    expect(cleanup).toHaveBeenCalledTimes(kind === "timeout" ? 1 : 0);
    expect(stored).toEqual(marker);
    if (kind === "timeout") expect(markerAtCleanup).toEqual(marker);
    expect(calls).toEqual([
      ["serve", "status", "--json"],
      ["serve", "--bg", "--https=443", target],
      ...(kind === "timeout"
        ? [
            ["serve", "status", "--json"],
            ["serve", "--https=443", "off"],
          ]
        : []),
    ]);
    expect(config).toEqual(kind === "timeout" ? {} : matching);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(close).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      kind === "timeout"
        ? "emend: tailscale did not answer within 10 seconds.\n"
        : `emend: Could not configure Tailscale Serve. Run \`sudo tailscale serve --bg --https=443 ${target}\` once as root, then try again. emend uses that route and never removes it.\n`,
    );
  } finally {
    bg?.emit("close", 1, null);
    await result;
    vi.useRealTimers();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test.each([
  { name: "loopback only", tailscale: false, created: false },
  { name: "new Serve route", tailscale: true, created: true },
  { name: "existing Serve route", tailscale: true, created: false },
])("a stop request cleans up only its own route: $name", async ({ tailscale, created }) => {
  const stateDir = env.EMEND_HOME as string;
  const actual = await vi.importActual<typeof import("../../server/serve.ts")>("../../server/serve.ts");
  const proxy = await import("../tailscale.ts");
  vi.spyOn(proxy, "tailscaleSelf").mockResolvedValue({ dnsName: "review.example.ts.net" });
  vi.spyOn(proxy, "ensureTailscaleServe").mockResolvedValue({ created, otherHttpsPorts: false });
  const remove = vi.spyOn(proxy, "removeTailscaleServe").mockResolvedValue(undefined);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let stop: (() => void) | undefined;
  vi.mocked(startServer).mockImplementation(async (options) => {
    stop = options.onStopRequest;
    server = await actual.startServer(options);
    return server;
  });
  const printed = Promise.withResolvers<void>();
  const stdout = vi.fn(() => printed.resolve());
  const stderr = vi.fn();
  const result = run(["serve", "--port", "0", ...(tailscale ? ["--tailscale"] : [])], {
    env,
    stdout,
    stderr,
  });
  // A server that never prints leaves `printed` pending. The test timeout then ends the test without
  // unwinding this function, so a `finally` would not run; onTestFinished also runs after a timeout.
  onTestFinished(async () => {
    stop?.();
    await result;
    await server?.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  await printed.promise;
  expect(stdout).toHaveBeenCalledOnce();
  expect(await stopLocalServer(stateDir)).toBe(server?.url);
  expect(await result).toBe(0);
  await expect(readFile(join(stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(remove).toHaveBeenCalledTimes(tailscale && created ? 1 : 0);
  expect(stderr).not.toHaveBeenCalled();
});
test("serve defaults to loopback, allows explicit host and port zero, and rejects bad flags", async () => {
  expect(parseServeArgs([])).toEqual({ host: "127.0.0.1", port: 3636 });
  expect(parseServeArgs(["--host", "192.0.2.1", "--port", "0"])).toEqual({ host: "192.0.2.1", port: 0 });
  for (const args of [
    ["--bad"],
    ["--port"],
    ["--port", "-1"],
    ["--port", "65536"],
    ["--port", "1.5"],
    ["--host"],
    ["--host", "--port"],
    ["--host", "http://evil.example"],
    ["--port", "1", "--port", "2"],
  ]) {
    const stderr: string[] = [];
    const stdout: string[] = [];
    expect(await run(["serve", ...args], { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s), env })).toBe(
      2,
    );
    expect(stderr).toHaveLength(1);
    expect(stderr[0]?.split("\n")).toHaveLength(2);
    expect(stdout).toEqual([]);
  }
});

test.each(["SIGINT", "SIGTERM"] as const)("serve prints once and closes cleanly on %s", async (signal) => {
  const close = vi.fn().mockResolvedValue({ otherHttpsPorts: false });
  vi.mocked(startServer).mockResolvedValue({
    url: "http://127.0.0.1:3636",
    port: 3636,
    setPublicOriginReady: vi.fn(),
    close,
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const printed = Promise.withResolvers<void>();
  const result = run(["serve"], {
    stdout: (s) => {
      stdout.push(s);
      printed.resolve();
    },
    stderr: (s) => stderr.push(s),
    env,
  });
  onTestFinished(async () => {
    process.emit("SIGTERM");
    await result;
  });
  await printed.promise;
  expect(stdout).toEqual(["emend is serving http://127.0.0.1:3636\n"]);
  process.emit(signal);
  expect(await result).toBe(0);
  expect(close).toHaveBeenCalledTimes(1);
  expect(stderr).toEqual([]);
});

test.each([
  ["https://emend.example.com", "https://emend.example.com"],
  ["https://emend.example.com/", "https://emend.example.com"],
  ["https://Emend.Example.COM", "https://emend.example.com"],
  ["https://emend.example.com:443", "https://emend.example.com"],
  ["https://emend.example.com:8443", "https://emend.example.com:8443"],
  ["https://192.0.2.10", "https://192.0.2.10"],
  ["https://[2001:db8::1]:8443", "https://[2001:db8::1]:8443"],
])("public-url normalizes %s without widening the bind", (value, publicUrl) => {
  expect(parseServeArgs(["--public-url", value])).toEqual({ host: "127.0.0.1", port: 3636, publicUrl });
  expect(parseServeArgs(["--public-url", value, "--host", "192.0.2.1", "--port", "4000"])).toEqual({
    host: "192.0.2.1",
    port: 4000,
    publicUrl,
  });
});

test.each([
  "http://emend.example.com",
  "https://emend.example.com/emend",
  "https://emend.example.com?query=1",
  "https://emend.example.com#fragment",
  "https://u:p@emend.example.com",
  "https://emend.example.com ",
  "https://emend.\texample.com",
  "https://emend.\nexample.com",
  "https://emend.example.com\n",
  "https://emend.example.com\r",
  "https://emend.example.com\u0000",
  "https://",
  "https://emend.example.com:70000",
  `https://${"a".repeat(290)}.com`,
  "https://emend.example.com//",
  "https://emend_example.com",
  "https://emend..example.com",
  "https://emend.example.com:",
  "https://emend.example.com\\",
  "https://[invalid]",
  "https://[2001:::1]",
])("public-url refuses %j before URL parsing can hide unsafe characters", (value) => {
  expect(() => parseServeArgs(["--public-url", value])).toThrow(
    new UsageError("--public-url must be an https origin such as https://emend.example.com, with no path."),
  );
});

test("public-url is unique, needs a value, and cannot combine with tailscale", () => {
  const flag = ["--public-url", "https://emend.example.com"];
  for (const args of [
    [...flag, "--tailscale"],
    ["--tailscale", "--tailscale-port", "13636", ...flag],
  ])
    expect(() => parseServeArgs(args)).toThrow(new UsageError("--public-url cannot be combined with --tailscale."));
  for (const args of [["--public-url"], [...flag, ...flag]])
    expect(() => parseServeArgs(args)).toThrow(new UsageError("Invalid serve options."));
});

test("public-url advertises the origin and accepts its Host without contacting it or Tailscale", async () => {
  const stateDir = env.EMEND_HOME as string;
  const actual = await vi.importActual<typeof import("../../server/serve.ts")>("../../server/serve.ts");
  const tailscale = await import("../tailscale.ts");
  const self = vi.spyOn(tailscale, "tailscaleSelf").mockResolvedValue(null);
  const setup = vi.spyOn(tailscale, "ensureTailscaleServe");
  const remove = vi.spyOn(tailscale, "removeTailscaleServe");
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outgoing request."));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let stop: (() => void) | undefined;
  vi.mocked(startServer).mockImplementation(async (options) => {
    expect(options).toMatchObject({ host: "127.0.0.1", port: 0, publicOrigin: "https://emend.example.com" });
    stop = options.onStopRequest;
    server = await actual.startServer(options);
    return server;
  });
  const printed = Promise.withResolvers<void>();
  const stdout = vi.fn(() => printed.resolve());
  const stderr = vi.fn();
  const result = run(["serve", "--port", "0", "--public-url", "https://emend.example.com"], { env, stdout, stderr });
  onTestFinished(async () => {
    stop?.();
    await result;
    await server?.close();
  });
  await Promise.race([
    printed.promise,
    result.then(() => {
      throw new Error(`Server exited before serving: ${stderr.mock.calls.flat().join("")}`);
    }),
  ]);
  expect(stdout).toHaveBeenCalledExactlyOnceWith("emend: serving https://emend.example.com\n");
  expect(JSON.parse(await readFile(join(stateDir, "server-url.json"), "utf8"))).toEqual({
    baseUrl: "https://emend.example.com",
  });
  for (const [host, status] of [
    ["emend.example.com", 200],
    ["other.example.com", 403],
  ] as const) {
    const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const request = httpRequest(
        { hostname: "127.0.0.1", port: server?.port, path: "/api/v1/capabilities", headers: { Host: host } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve({ status: response.statusCode, body }));
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(response.status).toBe(status);
    if (status === 403) expect(JSON.parse(response.body).error.code).toBe("bad_host");
  }
  stop?.();
  expect(await result).toBe(0);
  for (const helper of [self, setup, remove, fetch]) expect(helper).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
});

test("public-url becomes ready before printing and closes on a stop request", async () => {
  const ready = vi.fn();
  const close = vi.fn(async () => {});
  let stop: (() => void) | undefined;
  vi.mocked(startServer).mockImplementation(async (options) => {
    expect(options).toMatchObject({ host: "127.0.0.1", port: 3636, publicOrigin: "https://emend.example.com" });
    stop = options.onStopRequest;
    return { url: "http://127.0.0.1:3636", port: 3636, setPublicOriginReady: ready, close };
  });
  const stdout = vi.fn(() => stop?.());
  const stderr = vi.fn();
  expect(await run(["serve", "--public-url", "https://Emend.Example.COM:443/"], { env, stdout, stderr })).toBe(0);
  expect(ready).toHaveBeenCalledExactlyOnceWith(true);
  expect(ready).toHaveBeenCalledBefore(stdout);
  expect(stdout).toHaveBeenCalledExactlyOnceWith("emend: serving https://emend.example.com\n");
  expect(close).toHaveBeenCalledOnce();
  expect(stderr).not.toHaveBeenCalled();
});

test("tailscale flag is boolean, unique, and binds only loopback", () => {
  expect(parseServeArgs(["--tailscale"])).toEqual({ host: "127.0.0.1", port: 3636, tailscale: true });
  expect(parseServeArgs(["--tailscale", "--port", "4000", "--host", "127.0.0.1"])).toEqual({
    host: "127.0.0.1",
    port: 4000,
    tailscale: true,
  });
  for (const args of [
    ["--tailscale", "--tailscale"],
    ["--host", "0.0.0.0", "--tailscale"],
    ["--tailscale", "--host", "localhost"],
  ])
    expect(() => parseServeArgs(args)).toThrow();
});

test("tailscale setup follows startup, uses the bound port, and prints only the HTTPS address", async () => {
  const calls: string[] = [];
  const close = vi.fn(async () => {});
  const tailscale = await import("../tailscale.ts");
  vi.spyOn(tailscale, "removeTailscaleServe").mockResolvedValue(undefined);
  vi.spyOn(tailscale, "tailscaleSelf").mockImplementation(async () => {
    calls.push("self");
    return { dnsName: "hub.example.ts.net" };
  });
  vi.mocked(startServer).mockImplementation(async (options) => {
    calls.push("start");
    expect(options).toMatchObject({ host: "127.0.0.1", port: 0, publicOrigin: "https://hub.example.ts.net" });
    return { url: "http://127.0.0.1:4000", port: 4000, setPublicOriginReady: vi.fn(), close };
  });
  vi.spyOn(tailscale, "ensureTailscaleServe").mockImplementation(async (port) => {
    calls.push("serve");
    expect(port).toBe(4000);
    return { created: true, otherHttpsPorts: false };
  });
  const stdout: string[] = [];
  const printed = Promise.withResolvers<void>();
  const result = run(["serve", "--port", "0", "--tailscale"], {
    env,
    stdout: (s) => {
      stdout.push(s);
      printed.resolve();
    },
    stderr: () => {},
  });
  onTestFinished(async () => {
    process.emit("SIGTERM");
    await result;
  });
  await printed.promise;
  expect(stdout).toEqual(["emend: serving https://hub.example.ts.net\n"]);
  expect(calls).toEqual(["self", "start", "serve"]);
  process.emit("SIGTERM");
  expect(await result).toBe(0);
  expect(close).toHaveBeenCalledTimes(1);
});
test("tailscale setup failure closes the started server and exits one", async () => {
  const tailscale = await import("../tailscale.ts");
  vi.spyOn(tailscale, "removeTailscaleServe").mockResolvedValue(undefined);
  const { CliError } = await import("../http.ts");
  vi.spyOn(tailscale, "tailscaleSelf").mockResolvedValue({ dnsName: "hub.example.ts.net" });
  vi.spyOn(tailscale, "ensureTailscaleServe").mockRejectedValue(
    new CliError(
      "port 443 of Tailscale Serve already has a setup emend did not make or cannot read; inspect it with `tailscale serve status`.",
    ),
  );
  const close = vi.fn(async () => {});
  vi.mocked(startServer).mockResolvedValue({
    url: "http://127.0.0.1:3636",
    port: 3636,
    setPublicOriginReady: vi.fn(),
    close,
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  expect(
    await run(["serve", "--tailscale"], {
      env,
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
    }),
  ).toBe(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    "emend: port 443 of Tailscale Serve already has a setup emend did not make or cannot read; inspect it with `tailscale serve status`.\n",
  ]);
});

test("teardown stops a serving command before restoring its Tailscale spies", async () => {
  const tailscale = await import("../tailscale.ts");
  vi.spyOn(tailscale, "tailscaleSelf").mockResolvedValue({ dnsName: "hub.example.ts.net" });
  vi.spyOn(tailscale, "ensureTailscaleServe").mockResolvedValue({ created: true, otherHttpsPorts: false });
  const remove = vi.spyOn(tailscale, "removeTailscaleServe").mockResolvedValue(undefined);
  const close = vi.fn(async () => {});
  vi.mocked(startServer).mockResolvedValue({
    url: "http://127.0.0.1:41999",
    port: 41999,
    setPublicOriginReady: vi.fn(),
    close,
  });
  onTestFinished(() => {
    expect(remove).toHaveBeenCalledExactlyOnceWith(41999, env, "hub.example.ts.net", env.EMEND_HOME);
    expect(close).toHaveBeenCalledOnce();
    expect(vi.isMockFunction(tailscale.removeTailscaleServe)).toBe(true);
  });
  const printed = Promise.withResolvers<void>();
  const result = run(["serve", "--tailscale", "--port", "0"], {
    env,
    stdout: () => printed.resolve(),
    stderr: () => {},
  });
  onTestFinished(async () => {
    process.emit("SIGTERM");
    expect(await result).toBe(0);
  });
  await printed.promise;
  expect(remove).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

test("a setup attempt that throws still removes its route during shutdown", async () => {
  const tailscale = await import("../tailscale.ts");
  const { CliError } = await import("../http.ts");
  vi.spyOn(tailscale, "tailscaleSelf").mockResolvedValue({ dnsName: "hub.example.ts.net" });
  vi.spyOn(tailscale, "ensureTailscaleServe").mockImplementation(async (_port, _env, _name, onOwnershipChange) => {
    onOwnershipChange?.(true);
    throw new CliError("synthetic setup failure");
  });
  const remove = vi.spyOn(tailscale, "removeTailscaleServe").mockResolvedValue(undefined);
  const close = vi.fn(async () => {});
  vi.mocked(startServer).mockResolvedValue({
    url: "http://127.0.0.1:41999",
    port: 41999,
    setPublicOriginReady: vi.fn(),
    close,
  });
  const stdout = vi.fn();
  const stderr = vi.fn();
  expect(await run(["serve", "--tailscale", "--port", "0"], { env, stdout, stderr })).toBe(1);
  expect(remove).toHaveBeenCalledExactlyOnceWith(41999, env, "hub.example.ts.net", env.EMEND_HOME);
  expect(close).toHaveBeenCalledOnce();
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledExactlyOnceWith("emend: synthetic setup failure\n");
});

test.each([{ flags: ["--tailscale"] }, { flags: ["--public-url", "https://emend.example.com"] }])(
  "a stop after startServer resolves skips public setup and closes normally ($flags)",
  async ({ flags }) => {
    const tailscale = await import("../tailscale.ts");
    vi.spyOn(tailscale, "tailscaleSelf").mockResolvedValue({ dnsName: "hub.example.ts.net" });
    const setup = vi
      .spyOn(tailscale, "ensureTailscaleServe")
      .mockResolvedValue({ created: true, otherHttpsPorts: false });
    const remove = vi.spyOn(tailscale, "removeTailscaleServe").mockResolvedValue(undefined);
    const close = vi.fn(async () => {});
    const advertise = vi.fn();
    vi.mocked(startServer).mockImplementation(() => {
      const started = Promise.resolve({
        url: "http://127.0.0.1:41999",
        port: 41999,
        setPublicOriginReady: advertise,
        close,
      });
      // Deliver the stop between the resolved start promise and serve's continuation.
      void started.then(() => queueMicrotask(() => process.emit("SIGTERM")));
      return started;
    });
    const stdout = vi.fn();
    const stderr = vi.fn();
    expect(await run(["serve", ...flags], { env, stdout, stderr })).toBe(0);
    expect(setup).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(advertise).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  },
);

test.each([
  ["SIGINT", 130, false],
  ["SIGTERM", 143, false],
  ["SIGHUP", 129, false],
  ["SIGTERM", 143, true],
] as const)("%s during startup exits %s after the losing start settles (fails: %s)", async (signal, code, fails) => {
  const tailscale = await import("../tailscale.ts");
  vi.spyOn(tailscale, "tailscaleSelf").mockResolvedValue({ dnsName: "hub.example.ts.net" });
  const setup = vi.spyOn(tailscale, "ensureTailscaleServe");
  const remove = vi.spyOn(tailscale, "removeTailscaleServe");
  const starting = Promise.withResolvers<Awaited<ReturnType<typeof startServer>>>();
  const entered = Promise.withResolvers<void>();
  vi.mocked(startServer).mockImplementation(() => {
    entered.resolve();
    return starting.promise;
  });
  const close = vi.fn(async () => {});
  const advertise = vi.fn();
  const stdout = vi.fn();
  const stderr = vi.fn();
  let returned = false;
  const result = run(["serve", "--tailscale"], { env, stdout, stderr }).then((code) => {
    returned = true;
    return code;
  });
  onTestFinished(async () => {
    process.emit("SIGTERM");
    starting.resolve({ url: "http://127.0.0.1:41999", port: 41999, setPublicOriginReady: advertise, close });
    await result;
  });
  await entered.promise;
  process.emit(signal);
  // Let the signal win the race before startup settles.
  await new Promise(setImmediate);
  const returnedBeforeStart = returned;
  if (fails) starting.reject(new Error("synthetic start failure"));
  else starting.resolve({ url: "http://127.0.0.1:41999", port: 41999, setPublicOriginReady: advertise, close });
  expect(await result).toBe(code);
  expect(close).toHaveBeenCalledTimes(fails ? 0 : 1);
  expect(returnedBeforeStart).toBe(false);
  expect(setup).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(advertise).not.toHaveBeenCalled();
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
});

test.each([
  [80, 80, "http://127.0.0.1"],
  [0, 41327, "http://127.0.0.1:41327"],
] as const)("Tailscale requested port %s uses the returned bound port %s", async (requested, bound, url) => {
  const tailscale = await import("../tailscale.ts");
  vi.spyOn(tailscale, "removeTailscaleServe").mockResolvedValue(undefined);
  vi.spyOn(tailscale, "tailscaleSelf").mockResolvedValue({ dnsName: "hub.example.ts.net" });
  const setup = vi
    .spyOn(tailscale, "ensureTailscaleServe")
    .mockResolvedValue({ created: true, otherHttpsPorts: false });
  vi.mocked(startServer).mockResolvedValue({
    url,
    port: bound,
    setPublicOriginReady: vi.fn(),
    close: vi.fn(async () => {}),
  });
  const stdout: string[] = [];
  const printed = Promise.withResolvers<void>();
  const result = run(["serve", "--tailscale", "--port", String(requested)], {
    env,
    stdout: (line) => {
      stdout.push(line);
      printed.resolve();
    },
    stderr: () => {},
  });
  onTestFinished(async () => {
    process.emit("SIGTERM");
    await result;
  });
  try {
    await printed.promise;
    expect(stdout).toHaveLength(1);
    expect(setup.mock.calls[0]?.[0]).toBe(bound);
    expect(setup.mock.calls[0]?.[4]).toEqual({ fixedPort: requested !== 0, stateDir: env.EMEND_HOME });
  } finally {
    process.emit("SIGTERM");
    await result;
  }
});

test("tailscale-port needs tailscale, is digits only and within 1..65535", async () => {
  expect(parseServeArgs(["--tailscale", "--tailscale-port", "13636"])).toEqual({
    host: "127.0.0.1",
    port: 3636,
    tailscale: true,
    tailscalePort: 13636,
  });
  expect(parseServeArgs(["--tailscale-port", "65535", "--tailscale"])).toMatchObject({ tailscalePort: 65535 });
  expect(parseServeArgs(["--tailscale", "--tailscale-port", "443"])).toMatchObject({ tailscalePort: 443 });
  // Existing inputs keep their exact shape.
  expect(parseServeArgs(["--tailscale"])).toEqual({ host: "127.0.0.1", port: 3636, tailscale: true });
  for (const value of ["0", "65536", "-1", "1.5", "0443", "1e3", "+443", "abc", "443 ", "123456"])
    expect(() => parseServeArgs(["--tailscale", "--tailscale-port", value])).toThrow(/--tailscale-port must be/);
  for (const args of [
    ["--tailscale", "--tailscale-port"],
    ["--tailscale", "--tailscale-port", "1", "--tailscale-port", "2"],
  ])
    expect(() => parseServeArgs(args)).toThrow();
  expect(() => parseServeArgs(["--tailscale-port", "13636"])).toThrow("--tailscale-port requires --tailscale.");
  expect(() => parseServeArgs(["--tailscale-port", "13636", "--port", "4000"])).toThrow(
    "--tailscale-port requires --tailscale.",
  );
  const stderr: string[] = [];
  expect(
    await run(["serve", "--tailscale-port", "13636"], { env, stdout: () => {}, stderr: (s) => stderr.push(s) }),
  ).toBe(2);
  expect(stderr[0]).toContain("--tailscale-port requires --tailscale.");
});

test.each([
  { args: ["--tailscale-port", "13636"], origin: "https://hub.example.ts.net:13636", https: 13636 },
  { args: ["--tailscale-port", "443"], origin: "https://hub.example.ts.net", https: 443 },
  { args: [], origin: "https://hub.example.ts.net", https: 443 },
])("serve with tailscale $args uses $origin and HTTPS port $https", async ({ args, origin, https }) => {
  const tailscale = await import("../tailscale.ts");
  vi.spyOn(tailscale, "tailscaleSelf").mockResolvedValue({ dnsName: "hub.example.ts.net" });
  const ensure = vi
    .spyOn(tailscale, "ensureTailscaleServe")
    .mockResolvedValue({ created: true, otherHttpsPorts: false });
  const remove = vi.spyOn(tailscale, "removeTailscaleServe").mockResolvedValue(undefined);
  const ready = vi.fn();
  vi.mocked(startServer).mockImplementation(async (options) => {
    // The listener never follows the Tailscale port.
    expect(options).toMatchObject({ host: "127.0.0.1", port: 0, publicOrigin: origin });
    return { url: "http://127.0.0.1:4000", port: 4000, setPublicOriginReady: ready, close: async () => {} };
  });
  const stdout: string[] = [];
  const printed = Promise.withResolvers<void>();
  const result = run(["serve", "--port", "0", "--tailscale", ...args], {
    env,
    stdout: (s) => {
      stdout.push(s);
      printed.resolve();
    },
    stderr: () => {},
  });
  onTestFinished(async () => {
    process.emit("SIGTERM");
    await result;
  });
  await printed.promise;
  expect(stdout).toEqual([`emend: serving ${origin}\n`]);
  expect(ensure).toHaveBeenCalledOnce();
  const options = ensure.mock.calls[0]?.[4];
  if (https === 443) expect(options).toEqual({ fixedPort: false, stateDir: env.EMEND_HOME });
  else expect(options).toEqual({ fixedPort: false, stateDir: env.EMEND_HOME, httpsPort: https });
  expect(ready).toHaveBeenCalledWith(true);
  process.emit("SIGTERM");
  expect(await result).toBe(0);
  if (https === 443) expect(remove).toHaveBeenCalledExactlyOnceWith(4000, env, "hub.example.ts.net", env.EMEND_HOME);
  else
    expect(remove).toHaveBeenCalledExactlyOnceWith(
      4000,
      env,
      "hub.example.ts.net",
      env.EMEND_HOME,
      process.pid,
      undefined,
      https,
    );
});
