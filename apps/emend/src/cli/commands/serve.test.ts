import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { run } from "../../main.ts";
import { startServer } from "../../server/serve.ts";
import { stopLocalServer } from "../service/takeover.ts";
import { parseServeArgs } from "./serve.ts";

vi.mock("../../server/serve.ts", () => ({ startServer: vi.fn() }));
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  // Finished hooks run in reverse registration order, after afterEach: restore spies last.
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const dir = await mkdtemp(join(tmpdir(), "emend-serve-test-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  await mkdir(bin);
  env = { EMEND_HOME: dir, HOME: dir, PATH: bin };
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
    expect(remove).toHaveBeenCalledExactlyOnceWith(41999, env, "hub.example.ts.net");
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
  vi.spyOn(tailscale, "ensureTailscaleServe").mockImplementation(async (_port, _env, _name, onSetupAttempt) => {
    onSetupAttempt?.();
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
  expect(remove).toHaveBeenCalledExactlyOnceWith(41999, env, "hub.example.ts.net");
  expect(close).toHaveBeenCalledOnce();
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledExactlyOnceWith("emend: synthetic setup failure\n");
});

test("a stop after startServer resolves skips Tailscale setup and closes normally", async () => {
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
  expect(await run(["serve", "--tailscale"], { env, stdout, stderr })).toBe(0);
  expect(setup).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(advertise).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
});

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
    expect(setup.mock.calls[0]?.[4]).toEqual({ fixedPort: requested !== 0 });
  } finally {
    process.emit("SIGTERM");
    await result;
  }
});
