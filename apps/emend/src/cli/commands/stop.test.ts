import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Io, run } from "../../main.ts";
import { startServer } from "../../server/serve.ts";
import { writeSecretFile } from "../../state/files.ts";
import { CliError } from "../http.ts";
import { probeServer, serverRecord } from "../server-client.ts";
import type { ServiceRunner } from "../service/common.ts";
import * as markers from "../tailscale-marker.ts";
import { provenTestServer } from "../test-support.ts";

// A missing fixture helper must never fall back to the host Tailscale app.
const executableDirs = new Set<string>();
vi.mock("../executable.ts", async (original) => {
  const actual = await original<typeof import("../executable.ts")>();
  return {
    async findExecutable(...args: Parameters<typeof actual.findExecutable>) {
      const [name, searchPath] = args;
      if (
        searchPath === undefined ||
        searchPath
          .split(delimiter)
          .filter(Boolean)
          .some((entry) => ![...executableDirs].some((dir) => entry === dir || entry.startsWith(`${dir}${sep}`)))
      )
        throw new CliError(`${name} was not found on PATH`);
      return actual.findExecutable(...args);
    },
  };
});

const killProcess = process.kill;
const url = "http://127.0.0.1:3636";
const noServer = "emend: no emend server is running.\n";
let root: string;
let state: string;
let home: string;
let bin: string;
let io: Io;
let stdout: string[];
let stderr: string[];
let elapsed: number;
let runner: ReturnType<typeof vi.fn<ServiceRunner>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "emend-stop-"));
  executableDirs.add(root);
  state = join(root, "state");
  home = join(root, "home");
  bin = join(root, "bin");
  await mkdir(home);
  await mkdir(bin);
  for (const name of ["systemctl", "launchctl"])
    await writeFile(join(bin, name), "synthetic executable\n", { mode: 0o755 });
  stdout = [];
  stderr = [];
  elapsed = 0;
  runner = vi.fn(async () => ({ code: 1, stdout: "", stderr: "synthetic failure" }));
  io = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    env: { HOME: home, EMEND_HOME: state, PATH: bin, NODE_OPTIONS: "--this-must-not-be-inherited" },
    service: {
      platform: "linux",
      home,
      uid: 501,
      runner,
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    },
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  executableDirs.delete(root);
  await rm(root, { recursive: true, force: true });
});

async function installService(platform: string, content?: string) {
  if (io.service) io.service.platform = platform;
  const path =
    platform === "linux"
      ? join(io.env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd/user/emend.service")
      : join(home, "Library/LaunchAgents/dev.emend.server.plist");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    content ??
      (platform === "linux"
        ? "# written by emend\n"
        : '<?xml version="1.0" encoding="UTF-8"?>\n<!-- written by emend -->\n'),
  );
  return path;
}

function reportPid(platform: string, pid: number) {
  runner.mockResolvedValue({
    code: 0,
    stdout: platform === "linux" ? `${pid}\n` : `target = {\n nested = {\n pid = 42\n }\n pid = ${pid}\n}\n`,
    stderr: "",
  });
}

async function syntheticServer(mode = "stops") {
  await mkdir(state, { mode: 0o700 });
  writeSecretFile(join(state, "admin.token"), `em_${"a".repeat(43)}`);
  const proof = provenTestServer(state);
  let stopped = false;
  const kill = killProcess;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (
      pid === process.pid &&
      signal === 0 &&
      stopped &&
      mode !== "never-exit" &&
      (mode !== "delayed-exit" || elapsed >= 500)
    )
      throw Object.assign(new Error("synthetic exited server"), { code: "ESRCH" });
    return kill(pid, signal);
  });
  let probes = 0;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (stopped) throw new TypeError("refused", { cause: { code: "ECONNREFUSED" } });
    if (String(input).endsWith("/server/stop")) {
      stopped = mode !== "never-stop";
      return Response.json({ stopping: true }, { status: 202 });
    }
    probes++;
    if (mode === "unanswered") throw new DOMException("synthetic timeout", "TimeoutError");
    if (mode === "unverified") {
      await rm(join(state, "server.json"));
      return Response.json({});
    }
    if (mode === "changed" && probes > 1) return Response.json({});
    const response = proof(String(input), init);
    if (!response) throw new Error("Unexpected request");
    return Response.json(
      { api: 1, version: "0.1.0", features: mode === "older" ? [] : ["server-stop"] },
      { headers: response.headers },
    );
  });
  return fetcher;
}

test("no state folder reports no server without creating it", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  expect(await run(["stop"], io)).toBe(0);
  expect(stdout).toEqual([noServer]);
  expect(stderr).toEqual([]);
  await expect(stat(state)).rejects.toMatchObject({ code: "ENOENT" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(runner).not.toHaveBeenCalled();
});

test("missing server.json leaves the existing state folder empty", async () => {
  await mkdir(state, { mode: 0o700 });
  expect(await run(["stop"], io)).toBe(0);
  expect(stdout).toEqual([noServer]);
  expect(stderr).toEqual([]);
  expect(await readdir(state)).toEqual([]);
});

test("stop refuses a loose state folder with a stale route and no recorded server", async () => {
  const marker = { target: "http://127.0.0.1:3636", dnsName: "hub.example.ts.net", pid: 2_000_000_000 };
  await mkdir(state, { mode: 0o700 });
  const path = join(state, "tailscale-serve.json");
  const contents = JSON.stringify(marker);
  writeSecretFile(path, contents);
  await chmod(state, 0o770);
  vi.spyOn(markers, "loopbackState").mockResolvedValue("refused");
  const kill = killProcess;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== marker.pid) return kill(pid, signal);
    throw Object.assign(new Error("synthetic dead process"), { code: "ESRCH" });
  });
  const fetcher = vi.spyOn(globalThis, "fetch");
  expect(await run(["stop"], io)).toBe(1);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([
    `State directory ${state} has group or other permissions; fix it with chmod 700 '${state}'\n`,
  ]);
  expect(await readFile(path, "utf8")).toBe(contents);
  expect(await readdir(state)).toEqual(["tailscale-serve.json"]);
  await expect(stat(join(state, "tailscale-serve.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(runner).not.toHaveBeenCalled();
});

test("a dead recorded pid reports no server and leaves files unchanged", async () => {
  await mkdir(state, { mode: 0o700 });
  const record = JSON.stringify({ url, pid: 2147483647, key: Buffer.alloc(32, 3).toString("base64url") });
  writeSecretFile(join(state, "server.json"), record);
  const fetcher = vi.spyOn(globalThis, "fetch");
  expect(await run(["stop"], io)).toBe(0);
  expect(stdout).toEqual([noServer]);
  expect(stderr).toEqual([]);
  expect(await readdir(state)).toEqual(["server.json"]);
  expect(await readFile(join(state, "server.json"), "utf8")).toBe(record);
  expect(fetcher).not.toHaveBeenCalled();
  expect(elapsed).toBe(0);
});

test("stop extra is a usage error without creating state", async () => {
  expect(await run(["stop", "extra"], io)).toBe(2);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["emend: Usage: emend stop.\n"]);
  await expect(stat(state)).rejects.toMatchObject({ code: "ENOENT" });
});

test("help lists emend stop", async () => {
  expect(await run(["--help"], io)).toBe(0);
  expect(stdout.join("")).toContain("  emend stop                     Stop the server emend started\n");
});

test("an unverified server receives no credential or stop request", async () => {
  const fetcher = await syntheticServer("unverified");
  expect(await run(["stop"], io)).toBe(0);
  expect(stdout).toEqual([noServer]);
  expect(stderr).toEqual([]);
  expect(
    fetcher.mock.calls.every(
      ([input, init]) => String(input).endsWith("/capabilities") && !new Headers(init?.headers).has("Authorization"),
    ),
  ).toBe(true);
});

test.each([
  ["unanswered", "did not answer; try again."],
  [
    "older",
    "is from an older emend and cannot be asked to stop; end its process yourself: https://github.com/shllg/emend/blob/release/docs/setup/troubleshooting.md#a-server-from-an-older-emend-cannot-be-asked-to-stop",
  ],
  ["changed", "changed while emend asked it to stop; try again."],
  ["never-stop", "did not stop; try again."],
])("a %s server reports the stop-specific error", async (mode, reason) => {
  const fetcher = await syntheticServer(mode);
  expect(await run(["stop"], io)).toBe(1);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([`emend: the emend server at ${url} ${reason}\n`]);
  if (mode !== "never-stop")
    expect(fetcher.mock.calls.every(([, init]) => !new Headers(init?.headers).has("Authorization"))).toBe(true);
});

test("a loose admin token refuses without sending a request or changing files", async () => {
  const fetcher = await syntheticServer();
  const path = join(state, "admin.token");
  await chmod(path, 0o644);
  const before = await readdir(state);
  expect(await run(["stop"], io)).toBe(1);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([`Token file ${path} has group or other permissions; fix it with chmod 600 '${path}'\n`]);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readdir(state)).toEqual(before);
  expect((await stat(path)).mode & 0o777).toBe(0o644);
  expect(await readFile(path, "utf8")).toBe(`em_${"a".repeat(43)}`);
});

test("a loose admin token still refuses when unknown service ownership finds a dead recorded pid", async () => {
  const fetcher = await syntheticServer();
  fetcher.mockRejectedValue(new TypeError("refused", { cause: { code: "ECONNREFUSED" } }));
  await installService("linux");
  const path = join(state, "admin.token");
  await chmod(path, 0o644);
  const names = await readdir(state);
  const contents = await Promise.all(names.map((name) => readFile(join(state, name))));
  let gone = false;
  runner.mockImplementation(async () => {
    gone = true;
    return { code: 1, stdout: "", stderr: "synthetic failure" };
  });
  const kill = killProcess;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (gone && pid === process.pid && signal === 0)
      throw Object.assign(new Error("synthetic dead process"), { code: "ESRCH" });
    return kill(pid, signal);
  });
  expect(await run(["stop"], io)).toBe(1);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([`Token file ${path} has group or other permissions; fix it with chmod 600 '${path}'\n`]);
  expect(runner).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readdir(state)).toEqual(names);
  expect(await Promise.all(names.map((name) => readFile(join(state, name))))).toEqual(contents);
  expect((await stat(path)).mode & 0o777).toBe(0o644);
});

test("an attached machine stops only the local server", async () => {
  const fetcher = await syntheticServer();
  writeSecretFile(join(state, "attach.json"), JSON.stringify({ hubUrl: "https://hub.example.test" }));
  writeSecretFile(join(state, "hub.token"), `em_${"b".repeat(43)}`);
  const before = await readdir(state);
  expect(await run(["stop"], io)).toBe(0);
  expect(stdout).toEqual([`emend: stopped the emend server at ${url}\n`]);
  expect(stderr).toEqual([]);
  expect(fetcher.mock.calls.every(([input]) => String(input).startsWith(`${url}/`))).toBe(true);
  expect(await readdir(state)).toEqual(before);
});

for (const platform of ["linux", "darwin"]) {
  test(`${platform} service ownership refuses before sending any request`, async () => {
    const fetcher = await syntheticServer();
    if (platform === "linux") io.env.XDG_CONFIG_HOME = join(home, "config");
    await installService(platform);
    reportPid(platform, process.pid);
    expect(await run(["stop"], io)).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      `emend: the emend server at ${url} runs as the emend service; run emend service install to restart it, or emend service uninstall to stop it.\n`,
    ]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(runner.mock.calls.map(([, args]) => args)).toEqual([
      platform === "linux"
        ? ["--user", "show", "--property=MainPID", "--value", "emend"]
        : ["print", "gui/501/dev.emend.server"],
    ]);
  });

  test.each(["other-pid", "unowned-file"])(`${platform} %s stops the server as a bare server`, async (kind) => {
    const fetcher = await syntheticServer();
    await installService(platform, kind === "unowned-file" ? "another program\n" : undefined);
    reportPid(platform, kind === "other-pid" ? process.pid + 1 : process.pid);
    expect(await run(["stop"], io)).toBe(0);
    expect(stdout).toEqual([`emend: stopped the emend server at ${url}\n`]);
    expect(stderr).toEqual([]);
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/server/stop"))).toHaveLength(1);
  });

  test.each(["failed-query", "missing-tool"])(`${platform} %s refuses unknown service ownership`, async (kind) => {
    const fetcher = await syntheticServer();
    const servicePath = await installService(platform);
    if (kind === "missing-tool") io.env.PATH = "";
    const names = await readdir(state);
    const contents = await Promise.all(names.map((name) => readFile(join(state, name))));
    const serviceFile = await readFile(servicePath);
    expect(await run(["stop"], io)).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      `emend: could not check whether the emend service runs the server at ${url}; nothing was changed. Run emend service status, then try again.\n`,
    ]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readdir(state)).toEqual(names);
    expect(await Promise.all(names.map((name) => readFile(join(state, name))))).toEqual(contents);
    expect(await readFile(servicePath)).toEqual(serviceFile);
  });

  test.each(["ESRCH", "EPERM"])(`${platform} unknown ownership checks recorded pid liveness (%s)`, async (code) => {
    const fetcher = await syntheticServer();
    await installService(platform);
    const kill = killProcess;
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== process.pid || signal !== 0) return kill(pid, signal);
      throw Object.assign(new Error("synthetic liveness"), { code });
    });
    expect(await run(["stop"], io)).toBe(code === "ESRCH" ? 0 : 1);
    expect(stdout).toEqual(code === "ESRCH" ? [noServer] : []);
    expect(stderr).toEqual(
      code === "ESRCH"
        ? []
        : [
            `emend: could not check whether the emend service runs the server at ${url}; nothing was changed. Run emend service status, then try again.\n`,
          ],
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
}

test.each([113, 1, 112])(
  "darwin launchctl print exit %s distinguishes an unloaded service from a failed query",
  async (code) => {
    const fetcher = await syntheticServer();
    await installService("darwin");
    runner.mockResolvedValue({ code, stdout: "", stderr: "synthetic launchctl failure" });
    expect(await run(["stop"], io)).toBe(code === 113 ? 0 : 1);
    expect(stdout).toEqual(code === 113 ? [`emend: stopped the emend server at ${url}\n`] : []);
    expect(stderr).toEqual(
      code === 113
        ? []
        : [
            `emend: could not check whether the emend service runs the server at ${url}; nothing was changed. Run emend service status, then try again.\n`,
          ],
    );
    if (code === 113)
      expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/server/stop"))).toHaveLength(1);
    else expect(fetcher).not.toHaveBeenCalled();
  },
);

test("other platforms skip service ownership", async () => {
  await syntheticServer();
  if (io.service) io.service.platform = "freebsd";
  expect(await run(["stop"], io)).toBe(0);
  expect(stdout).toEqual([`emend: stopped the emend server at ${url}\n`]);
  expect(stderr).toEqual([]);
  expect(runner).not.toHaveBeenCalled();
});

test("stops a real bare server through its handler", async () => {
  // This server closes in this process; its asynchronous cleanup needs the real clock.
  if (io.service) {
    io.service.now = undefined;
    io.service.sleep = undefined;
  }
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const kill = killProcess;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (closed && pid === process.pid && signal === 0)
      throw Object.assign(new Error("in-process server closed"), { code: "ESRCH" });
    return kill(pid, signal);
  });
  try {
    server = await startServer({
      stateDir: state,
      port: 0,
      onStopRequest: () => {
        closing = server?.close().then(() => {
          closed = true;
        });
      },
    });
    expect(await run(["stop"], io)).toBe(0);
    expect(stdout).toEqual([`emend: stopped the emend server at ${server.url}\n`]);
    expect(stderr).toEqual([]);
    await closing;
    await expect(readFile(join(state, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await server?.close();
  }
});

test.each(["linux", "darwin"])("%s service-owned real server still answers after refusal", async (platform) => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const onStopRequest = vi.fn();
  try {
    server = await startServer({ stateDir: state, port: 0, onStopRequest });
    await installService(platform);
    reportPid(platform, process.pid);
    expect(await run(["stop"], io)).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      `emend: the emend server at ${server.url} runs as the emend service; run emend service install to restart it, or emend service uninstall to stop it.\n`,
    ]);
    expect(onStopRequest).not.toHaveBeenCalled();
    const record = await serverRecord(state);
    expect(record).not.toBeNull();
    if (record) expect((await probeServer(record, 500)).kind).toBe("verified");
  } finally {
    await server?.close();
  }
});

test("stop keeps the marker and warns the route may still exist when Tailscale is not on PATH", async () => {
  const marker = { target: "http://127.0.0.1:3636", dnsName: "hub.example.ts.net", pid: 2_000_000_000 };
  await mkdir(state, { recursive: true, mode: 0o700 });
  writeSecretFile(join(state, "tailscale-serve.json"), JSON.stringify(marker));
  vi.spyOn(markers, "loopbackState").mockResolvedValue("refused");
  const kill = killProcess;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== marker.pid) return kill(pid, signal);
    throw Object.assign(new Error("synthetic dead process"), { code: "ESRCH" });
  });
  expect(await run(["stop"], io)).toBe(0);
  expect(stderr).toEqual([]);
  expect(stdout).toEqual([
    "emend: no emend server is running; tailscale was not found on PATH, so the Tailscale Serve route at https://hub.example.ts.net may still exist.\n",
  ]);
  expect(JSON.parse(await readFile(join(state, "tailscale-serve.json"), "utf8"))).toEqual(marker);
});

test("stop waits for the process to exit after its listener closes", async () => {
  const fetcher = await syntheticServer("delayed-exit");
  expect(await run(["stop"], io)).toBe(0);
  expect(elapsed).toBe(500);
  expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/server/stop"))).toBe(true);
  expect(stdout).toEqual([`emend: stopped the emend server at ${url}\n`]);
  expect(stderr).toEqual([]);
});

test("stop fails after 15 seconds when the listener closes but the process never exits", async () => {
  await syntheticServer("never-exit");
  expect(await run(["stop"], io)).toBe(1);
  expect(elapsed).toBe(15000);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([`emend: the emend server at ${url} did not stop; try again.\n`]);
});

test.each([false, true])("an already absent listener waits for process exit (timeout: %s)", async (timeout) => {
  const fetcher = await syntheticServer("never-exit");
  fetcher.mockRejectedValue(new TypeError("refused", { cause: { code: "ECONNREFUSED" } }));
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (!timeout && elapsed >= 500 && pid === process.pid && signal === 0)
      throw Object.assign(new Error("synthetic exit"), { code: "ESRCH" });
    return killProcess(pid, signal);
  });
  expect(await run(["stop"], io)).toBe(timeout ? 1 : 0);
  expect(elapsed).toBe(timeout ? 15000 : 500);
  expect(stdout).toEqual(timeout ? [] : [noServer]);
  expect(stderr).toEqual(timeout ? [`emend: the emend server at ${url} did not stop; try again.\n`] : []);
  expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/server/stop"))).toBe(false);
});

test.each(["removed", "new-pid", "new-key"])("a live pid stops waiting when its record is %s", async (kind) => {
  await syntheticServer("never-exit");
  if (!io.service) throw new Error("missing service fixture");
  io.service.sleep = async (ms) => {
    elapsed += ms;
    expect(stdout).toEqual([]);
    if (elapsed === 500) {
      const path = join(state, "server.json");
      if (kind === "removed") await rm(path);
      else {
        const record = JSON.parse(await readFile(path, "utf8"));
        if (kind === "new-pid") record.pid++;
        else record.key = Buffer.alloc(32, 4).toString("base64url");
        await writeFile(path, JSON.stringify(record));
      }
    }
  };
  // A zombie (or a replacement process) still answers kill(pid, 0).
  vi.spyOn(process, "kill").mockReturnValue(true);
  expect(await run(["stop"], io)).toBe(0);
  expect(elapsed).toBe(500);
  expect(stdout).toEqual([`emend: stopped the emend server at ${url}\n`]);
  expect(stderr).toEqual([]);
});
