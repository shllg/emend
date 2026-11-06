import * as childProcess from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { expect, onTestFinished, test, vi } from "vitest";
import { run } from "../../main.ts";
import * as serverModule from "../../server/serve.ts";
import { waitForTailscaleEscalations } from "../tailscale.ts";

vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()) }));
const executablePaths = new Set<string>();
vi.mock("../executable.ts", async (original) => {
  const actual = await original<typeof import("../executable.ts")>();
  return {
    // The CLI cannot pass RunOptions: refuse the real macOS app fallback, even after teardown.
    async findExecutable(...args: Parameters<typeof actual.findExecutable>) {
      const searchPath = args[1];
      if (searchPath === undefined || !executablePaths.has(searchPath))
        throw new Error("executable lookup outside the test fixtures");
      return actual.findExecutable(...args);
    },
  };
});

// Exercise real server state and CLI lifecycle without reserving a privileged TCP port.
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    listening = false;
    port = 0;
    listen(options: { port: number }, ready: () => void) {
      this.port = options.port || 41999;
      this.listening = true;
      queueMicrotask(ready);
    }
    address() {
      return { address: "127.0.0.1", port: this.port };
    }
    closeAllConnections() {}
    close(done: () => void) {
      this.listening = false;
      done();
    }
  }
  return { ...actual, createServer: vi.fn(() => new Socket()) };
});
/** Send a real HTTP request through the listening test socket's installed handler. */
async function capabilities(stateDir: string) {
  const discovery = JSON.parse(await readFile(join(stateDir, "server.json"), "utf8")) as { url: string };
  const port = Number(new URL(discovery.url).port);
  const server = vi
    .mocked(createServer)
    .mock.results.map((result) => result.value)
    .find((server) => {
      const address = server.address();
      return server.listening && address && typeof address !== "string" && address.port === port;
    });
  if (!server) throw new Error("Discovery has no listening server");
  const chunks: Buffer[] = [];
  const sink = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  const incoming = new IncomingMessage(new Socket());
  incoming.method = "GET";
  incoming.url = "/api/v1/capabilities";
  incoming.headers = { host: new URL(discovery.url).host };
  incoming.rawHeaders = ["Host", incoming.headers.host as string];
  incoming.httpVersion = "1.1";
  incoming.httpVersionMajor = 1;
  incoming.httpVersionMinor = 1;
  const outgoing = new ServerResponse(incoming);
  outgoing.assignSocket(sink as Socket);
  const finished = once(outgoing, "finish");
  try {
    expect(server.emit("request", incoming, outgoing)).toBe(true);
    await finished;
    expect(outgoing.statusCode).toBe(200);
    expect(Buffer.concat(chunks).toString("utf8")).toContain('"api":1');
  } finally {
    incoming.destroy();
    sink.destroy();
  }
}

const name = "hub.example.ts.net";
const occupied = {
  TCP: { "443": { HTTPS: true } },
  Web: { [`${name}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture(
  initial: "empty" | "same" | "occupied" | "other-port" | "tls-port" = "empty",
  failure: "setup" | "stop" | "setup-after-write" | "setup-timeout" | undefined = undefined,
) {
  // Finished hooks run in reverse order: drains and timer restoration precede mock restoration.
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.mocked(createServer).mockClear();
  });
  const dir = await mkdtemp(join(tmpdir(), "emend-serve-fix1-"));
  executablePaths.add(dir);
  onTestFinished(async () => {
    executablePaths.delete(dir);
    await rm(dir, { force: true, recursive: true });
  });
  const configPath = join(dir, "config.json");
  const callsPath = join(dir, "calls");
  const own = {
    TCP: { "443": { HTTPS: true } },
    Web: { [`${name}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:41999" } } } },
  };
  const config =
    initial === "empty"
      ? {}
      : initial === "occupied"
        ? occupied
        : initial === "same"
          ? own
          : initial === "tls-port"
            ? { TCP: { "8443": { TCPForward: "127.0.0.1:8080", TerminateTLS: name } } }
            : {
                ...own,
                TCP: { ...own.TCP, "8443": { HTTPS: true } },
                Web: { ...own.Web, [`${name}:8443`]: { Handlers: { "/": { Text: "Synthetic other page" } } } },
              };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(
    join(dir, "tailscale"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(callsPath)}
if [ "$1" = status ]; then printf '%s\\n' '${JSON.stringify({ BackendState: "Running", Self: { DNSName: name } })}'
elif [ "$2" = status ]; then /bin/cat ${quote(configPath)}
elif [ "$2" = --bg ]; then
  ${failure === "setup" ? "printf 'permission denied' >&2; exit 1" : `printf '%s' ${quote(JSON.stringify(own))} > ${quote(configPath)}`}
  ${failure === "setup-after-write" ? "printf 'synthetic configuration failed' >&2; exit 1" : failure === "setup-timeout" ? `printf 'setup-ready\\n'; while [ -d ${quote(dir)} ]; do :; done` : ":"}
elif [ "$2" = --https=443 ] && [ "$3" = off ]; then ${failure === "stop" ? "printf 'permission denied' >&2; exit 1" : `printf '{}' > ${quote(configPath)}`}
else exit 7
fi
`,
    { mode: 0o700 },
  );
  const start = vi.spyOn(serverModule, "startServer");
  const setupReady = Promise.withResolvers<void>();
  const setupExited = Promise.withResolvers<void>();
  const fakeTimers = failure === "setup-timeout";
  if (fakeTimers) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
  }
  const children = new Set<childProcess.ChildProcess>();
  const commands = new Set<Promise<number>>();
  let changed = Promise.withResolvers<void>();
  const notify = () => {
    changed.resolve();
    changed = Promise.withResolvers<void>();
  };
  let draining: Promise<void> | undefined;
  const drain = () => {
    draining ??= (async () => {
      // A command can still be starting or spawning cleanup children. Track their actual events;
      // fake deadlines and group escalations must finish before the command can remove its handlers.
      while (commands.size || children.size) {
        const progress = changed.promise;
        process.emit("SIGTERM");
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        if (fakeTimers) await vi.runAllTimersAsync();
        if (commands.size || children.size) await progress;
      }
      if (fakeTimers) await vi.runAllTimersAsync();
      await waitForTailscaleEscalations();
      for (const result of start.mock.results)
        if (result.type === "return") await result.value.then((server) => server.close());
    })();
    return draining;
  };
  onTestFinished(drain);
  const spawn = childProcess.spawn;
  vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
    const child = spawn(...args);
    children.add(child);
    notify();
    child.once("close", () => {
      children.delete(child);
      notify();
    });
    if (Array.isArray(args[1]) && args[1].includes("--bg")) {
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("setup-ready\n")) setupReady.resolve();
      });
      child.once("exit", () => setupExited.resolve());
    }
    return child;
  });
  if (fakeTimers) {
    const tailscale = await import("../tailscale.ts");
    const ensure = tailscale.ensureTailscaleServe;
    vi.spyOn(tailscale, "ensureTailscaleServe").mockImplementation((port, env, name, onSetup, options) =>
      ensure(port, env, name, onSetup, { ...options, deadlineMs: 1_000 }),
    );
  }
  const serving = Promise.withResolvers<void>();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    env: { EMEND_HOME: dir, PATH: dir, HOME: dir },
    stdout: (line: string) => {
      stdout.push(line);
      serving.resolve();
    },
    stderr: (line: string) => {
      stderr.push(line);
    },
  };
  return {
    dir,
    drain,
    setupReady: setupReady.promise,
    setupExited: setupExited.promise,
    run(args: string[]) {
      if (draining) throw new Error("fixture is already draining");
      const command = run(args, io);
      commands.add(command);
      const finished = () => {
        commands.delete(command);
        notify();
      };
      void command.then(finished, finished);
      return command;
    },
    serving: serving.promise,
    async expireSetup() {
      await setupReady.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      await setupExited.promise;
      // Finish the process-group cleanup timer after the actual child exit.
      await vi.advanceTimersByTimeAsync(1_000);
    },
    io,
    stdout,
    stderr,
    configPath,
    saved: async () => JSON.parse(await readFile(join(dir, "server-url.json"), "utf8")),
    calls: async () => (await readFile(callsPath, "utf8")).trim().split("\n"),
  };
}

test.each([80, 0])("startServer returns the actual numeric bound port for %s", async (port) => {
  const f = await fixture();
  const server = await serverModule.startServer({ stateDir: f.dir, port, publicOrigin: `https://${name}` });
  expect(server.port).toBe(port || 41999);
  expect(await f.saved()).toEqual({ baseUrl: server.url });
});
test.each(["occupied", "permission"] as const)(
  "failed setup (%s) retains only the loopback address for direct publishing",
  async (failure) => {
    const f = await fixture(
      failure === "occupied" ? "occupied" : "empty",
      failure === "permission" ? "setup" : undefined,
    );
    await writeFile(join(f.dir, "server-url.json"), JSON.stringify({ baseUrl: `https://${name}` }));
    expect(await f.run(["serve", "--tailscale", "--port", "0"])).toBe(1);
    expect(await f.saved()).toEqual({ baseUrl: "http://127.0.0.1:41999" });
    await expect(stat(join(f.dir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.calls()).not.toContain("serve --https=443 off");
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toEqual([
      failure === "permission"
        ? "emend: Could not configure Tailscale Serve. Use a fixed --port, run `sudo tailscale serve --bg --https=443 http://127.0.0.1:<port>` once as root with that port, then try again.\n"
        : "emend: port 443 of Tailscale Serve already has a setup emend did not make or cannot read; inspect it with `tailscale serve status`.\n",
    ]);
  },
);
test.each(["setup-after-write", "setup-timeout"] as const)(
  "a failed setup (%s) removes a half-applied handler and preserves the original error",
  async (failure) => {
    const f = await fixture("empty", failure);
    const result = f.run(["serve", "--tailscale", "--port", "0"]);
    if (failure === "setup-timeout") await f.expireSetup();
    expect(await result).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toEqual([
      failure === "setup-timeout"
        ? "emend: tailscale did not answer within 1 second.\n"
        : "emend: Could not configure Tailscale Serve.\n",
    ]);
    expect(await f.calls()).toEqual([
      "status --json",
      "serve status --json",
      "serve --bg --https=443 http://127.0.0.1:41999",
      "serve status --json",
      "serve --https=443 off",
    ]);
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
    expect(await f.saved()).toEqual({ baseUrl: "http://127.0.0.1:41999" });
    await expect(stat(join(f.dir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
  },
  5_000,
);
test("a denied setup leaves the config untouched and runs no cleanup", async () => {
  const f = await fixture("tls-port", "setup");
  const before = await readFile(f.configPath, "utf8");
  expect(await f.run(["serve", "--tailscale", "--port", "41999"])).toBe(1);
  expect(f.stderr).toEqual([
    "emend: Could not configure Tailscale Serve. Run `sudo tailscale serve --bg --https=443 http://127.0.0.1:41999` once as root, then try again. emend uses that route and never removes it.\n",
  ]);
  expect(await f.calls()).toEqual([
    "status --json",
    "serve status --json",
    "serve --bg --https=443 http://127.0.0.1:41999",
  ]);
  expect(await readFile(f.configPath, "utf8")).toBe(before);
  expect(await f.saved()).toEqual({ baseUrl: "http://127.0.0.1:41999" });
  await expect(stat(join(f.dir, "tailscale-serve.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
test.each(["empty", "same"] as const)(
  "a stop after %s setup removes only a Serve route created by this process",
  async (initial) => {
    const f = await fixture(initial);
    const before = await readFile(f.configPath, "utf8");
    const result = f.run(["serve", "--tailscale", "--port", "0"]);
    await f.serving;
    expect(f.stdout).toEqual([`emend: serving https://${name}\n`]);
    expect(await f.saved()).toEqual({ baseUrl: `https://${name}` });
    process.emit(initial === "empty" ? "SIGINT" : "SIGTERM");
    expect(await result).toBe(0);
    expect(await f.calls()).toEqual([
      "status --json",
      "serve status --json",
      ...(initial === "empty"
        ? ["serve --bg --https=443 http://127.0.0.1:41999", "serve status --json", "serve --https=443 off"]
        : []),
    ]);
    expect(await readFile(f.configPath, "utf8")).toBe(before);
    expect(f.stderr).toEqual([]);
    expect(await f.saved()).toEqual({ baseUrl: `https://${name}` });
    await expect(stat(join(f.dir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);
test("SIGHUP removes the matching handler and discovery file, retaining the public address", async () => {
  const f = await fixture();
  const result = f.run(["serve", "--tailscale", "--port", "0"]);
  try {
    await f.serving;
    expect(f.stdout).toHaveLength(1);
    expect((await stat(join(f.dir, "server.json"))).isFile()).toBe(true);
    process.emit("SIGHUP");
    expect(await result).toBe(0);
    expect(await f.calls()).toContain("serve --https=443 off");
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
    await expect(stat(join(f.dir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.saved()).toEqual({ baseUrl: `https://${name}` });
    expect(f.stderr).toEqual([]);
  } finally {
    process.emit("SIGTERM");
    await result;
  }
});
test("a handler replaced before shutdown is never removed", async () => {
  const f = await fixture();
  const result = f.run(["serve", "--tailscale", "--port", "0"]);
  await f.serving;
  expect(f.stdout).toHaveLength(1);
  await writeFile(f.configPath, JSON.stringify(occupied));
  process.emit("SIGTERM");
  expect(await result).toBe(0);
  expect(await f.calls()).not.toContain("serve --https=443 off");
});
test("cleanup failure prints one stderr line and keeps a successful exit code", async () => {
  const f = await fixture("empty", "stop");
  const result = f.run(["serve", "--tailscale", "--port", "0"]);
  await f.serving;
  expect(f.stdout).toHaveLength(1);
  process.emit("SIGTERM");
  expect(await result).toBe(0);
  expect(f.stderr).toHaveLength(1);
  expect(f.stderr[0]).toContain("Run `sudo tailscale set --operator=$USER` once, then try again.");
});
test("a throwing shutdown stderr writer cannot change the exit code or run before close", async () => {
  const f = await fixture("empty", "stop");
  const discoveryAtReport: boolean[] = [];
  f.io.stderr = () => {
    discoveryAtReport.push(existsSync(join(f.dir, "server.json")));
    throw Object.assign(new Error("write EIO"), { code: "EIO" });
  };
  const result = f.run(["serve", "--tailscale", "--port", "0"]);
  await f.serving;
  expect(f.stdout).toHaveLength(1);
  process.emit("SIGHUP");
  await expect(result).resolves.toBe(0);
  expect(discoveryAtReport).toEqual([false]);
  await expect(stat(join(f.dir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
test("a throwing stdout writer keeps serving until a signal cleans up", async () => {
  const f = await fixture();
  const attempted = Promise.withResolvers<void>();
  f.io.stdout = () => {
    attempted.resolve();
    throw new Error("synthetic stdout failure");
  };
  let settled = false;
  const result = f.run(["serve", "--tailscale", "--port", "0"]).then((code) => {
    settled = true;
    return code;
  });
  try {
    await attempted.promise;
    await capabilities(f.dir);
    expect(settled).toBe(false);
    expect(await f.saved()).toEqual({ baseUrl: `https://${name}` });
    expect(existsSync(join(f.dir, "server.json"))).toBe(true);
    expect(await f.calls()).not.toContain("serve --https=443 off");
  } finally {
    process.emit("SIGTERM");
    await result;
  }
  expect(await result).toBe(0);
  expect(await f.calls()).toContain("serve --https=443 off");
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
  expect(await f.saved()).toEqual({ baseUrl: `https://${name}` });
  expect(f.stderr).toEqual([]);
  await expect(stat(join(f.dir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
test.each(["other-port", "tls-port"] as const)(
  "another HTTPS port (%s) on the same name warns once and startup continues",
  async (initial) => {
    const f = await fixture(initial);
    const result = f.run(["serve", "--tailscale", "--port", "0"]);
    try {
      await f.serving;
      expect(f.stdout).toHaveLength(1);
      expect(f.stderr).toEqual([
        `emend: warning: Tailscale Serve also serves other HTTPS ports on ${name}; pages there receive emend's sign-in cookie.\n`,
      ]);
    } finally {
      process.emit("SIGTERM");
      await result;
    }
  },
);

test.each(["running", "escalating"] as const)("teardown drains a %s setup before restoring timers", async (phase) => {
  const listeners = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal));
  const f = await fixture("empty", "setup-timeout");
  const command = f.run(["serve", "--tailscale", "--port", "0"]);
  await f.setupReady;
  if (phase === "escalating") {
    await vi.advanceTimersByTimeAsync(1_000);
    await f.setupExited;
  }
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  await f.drain();
  expect(await command).toBe(1);
  await waitForTailscaleEscalations();
  expect(vi.getTimerCount()).toBe(0);
  expect(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal))).toEqual(listeners);
});
