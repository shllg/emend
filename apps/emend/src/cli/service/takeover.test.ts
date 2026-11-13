import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS, SERVER_CHALLENGE_HEADER, SERVER_PROOF_HEADER } from "@emend/contract";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb } from "../../db/test-support.ts";
import { serverProof } from "../../server/auth/server-proof.ts";
import { startServer } from "../../server/serve.ts";
import { StateDirModeError } from "../../state/files.ts";
import { CliError } from "../http.ts";
import * as publishRead from "../publish/read.ts";
import { discover } from "../server-client.ts";
import { stopLocalServer, waitForServer } from "./takeover.ts";

beforeEach(() => {
  const kill = process.kill;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal !== 0) throw new Error("Only process existence probes are allowed.");
    return kill(pid, signal);
  });
});
afterEach(() => {
  try {
    expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  } finally {
    vi.restoreAllMocks();
  }
});

function spyOnFetchWithoutSignal() {
  const fetch = globalThis.fetch;
  const calls: {
    url: string;
    headers: Headers;
    outcome?: { status: number } | { error: unknown };
  }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call: (typeof calls)[number] = { url: String(input), headers: new Headers(init?.headers) };
    calls.push(call);
    // Injected clocks govern retries; real probe timers must not govern network responses.
    const { signal: _signal, ...options } = init ?? {};
    try {
      const response = await fetch(input, options);
      call.outcome = { status: response.status };
      return response;
    } catch (error) {
      call.outcome = { error };
      throw error;
    }
  });
  return calls;
}

async function withSyntheticServer(mode: string, run: (stateDir: string, url: string) => Promise<void>) {
  const stateDir = await mkdtemp(join(process.env.EMEND_HOME as string, "server-client-"));
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  try {
    const entry = join(stateDir, "entry.mjs");
    await writeFile(
      entry,
      `import { createServer } from 'node:http';
import { randomBytes, createHmac } from 'node:crypto';
import { writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.argv[2];
const key = randomBytes(32).toString('base64url');
const token = 'em_' + randomBytes(32).toString('base64url');
const path = join(process.env.EMEND_HOME, 'server.json');
writeFileSync(join(process.env.EMEND_HOME, 'admin.token'), token, { mode: 0o600 });
const server = createServer((req, res) => {
  appendFileSync(join(process.env.EMEND_HOME, 'requests.jsonl'), JSON.stringify({ path: req.url, credential: !!req.headers.authorization }) + '\\n');
  if (mode === 'unanswered') return;
  if (req.url === '/api/v1/server/stop') {
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end(); return; }
    if (mode !== 'never-stop') res.once('finish', () => { server.closeAllConnections(); server.close(() => { unlinkSync(path); process.exit(0); }); });
    res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ stopping: true })); return;
  }
  const challenge = req.headers['x-emend-challenge'];
  if (typeof challenge === 'string') res.setHeader('X-Emend-Proof', mode === 'wrong-proof' ? randomBytes(32).toString('base64url') : createHmac('sha256', Buffer.from(key, 'base64url')).update(challenge).digest('base64url'));
  res.setHeader('Content-Type', 'application/json');
  if (mode === 'non-ok') { res.writeHead(503); res.end(); return; }
  if (mode === 'invalid-json') { res.end('{'); return; }
  if (mode === 'large-length') { res.setHeader('Content-Length', '65537'); res.flushHeaders(); return; }
  if (mode === 'large-stream') { res.write(' '.repeat(32768)); res.write(' '.repeat(32768)); res.write(' '); return; }
  res.end(JSON.stringify({ api: 1, version: '0.1.0', features: mode === 'older' ? [] : ['server-stop'] }));
});
server.listen(0, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + server.address().port;
  writeFileSync(path, JSON.stringify({ key, pid: process.pid, url }), { mode: 0o600 }); process.send(url);
});
setTimeout(() => process.exit(0), 10000);
`,
    );
    child = spawn(process.execPath, [entry, mode], {
      cwd: stateDir,
      env: { PATH: process.env.PATH, HOME: stateDir, EMEND_HOME: stateDir, LC_ALL: "C" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    exited = new Promise((resolve) => {
      child?.once("exit", () => resolve());
      child?.once("error", () => resolve());
    });
    const url = await new Promise<string>((resolve, reject) => {
      child?.once("message", (message) => resolve(String(message)));
      child?.once("error", reject);
      child?.once("exit", () => reject(new Error("Synthetic server exited before readiness.")));
    });
    await run(stateDir, url);
  } finally {
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(stateDir, { recursive: true, force: true });
  }
}

describe("server takeover by request", () => {
  test("an unsafe state folder fails with the chmod hint before discovery", async () => {
    const stateDir = await mkdtemp(join(process.env.EMEND_HOME as string, "takeover-mode-"));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    try {
      await writeFile(
        join(stateDir, "server.json"),
        JSON.stringify({ pid: process.pid, url: "http://127.0.0.1:3636", key: randomBytes(32).toString("base64url") }),
      );
      await chmod(stateDir, 0o770);
      const attempt = stopLocalServer(stateDir);
      await expect(attempt).rejects.toBeInstanceOf(StateDirModeError);
      await expect(attempt).rejects.toThrow(`chmod 700 '${stateDir}'`);
      expect(process.kill).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("missing and malformed records never send a request", async () => {
    const stateDir = await mkdtemp(join(process.env.EMEND_HOME as string, "no-server-"));
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      expect(await stopLocalServer(stateDir)).toBeUndefined();
      for (const content of ["{", "{}", "null"]) {
        await writeFile(join(stateDir, "server.json"), content);
        expect(await stopLocalServer(stateDir)).toBeUndefined();
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("stops a real in-process server through its handler and returns its URL", async () => {
    const fixture = await testDb();
    const stateDir = join(fixture.dir, "stopping");
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let closing: Promise<void> | undefined;
    try {
      server = await startServer({
        stateDir,
        port: 0,
        onStopRequest: () => {
          closing = server?.close();
        },
      });
      expect(await stopLocalServer(stateDir)).toBe(server.url);
      await closing;
      await expect(readFile(join(stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server?.close();
      await fixture.cleanup();
    }
  });

  test("uses the original verified record even when the file changes", async () => {
    await withSyntheticServer("verified", async (stateDir, url) => {
      const fetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
        const response = await fetch(...args);
        await writeFile(join(stateDir, "server.json"), "{}");
        return response;
      });
      expect(await stopLocalServer(stateDir)).toBe(url);
    });
  });

  test("a wrong first proof sends no credential or stop request", async () => {
    await withSyntheticServer("wrong-proof", async (stateDir) => {
      expect(await stopLocalServer(stateDir, { timeoutMs: 500 })).toBeUndefined();
      expect(await discover(stateDir, 500)).toBeNull();
      const requests = (await readFile(join(stateDir, "requests.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.every((request) => request.path === "/api/v1/capabilities" && !request.credential)).toBe(true);
    });
  });

  test.each(["non-ok", "invalid-json", "large-length", "large-stream"])(
    "verified %s capabilities retry until the deadline without sending a credential",
    async (mode) => {
      await withSyntheticServer(mode, async (stateDir, url) => {
        const calls = spyOnFetchWithoutSignal();
        let elapsed = 0;
        await expect(
          stopLocalServer(stateDir, {
            timeoutMs: 250,
            now: () => elapsed,
            sleep: async (ms) => {
              elapsed += ms;
            },
          }),
        ).rejects.toEqual(
          new CliError(`the emend server at ${url} did not answer; stop it, then run emend service install again.`),
        );
        expect(calls).toHaveLength(3);
        for (const call of calls) {
          expect(call.url).toBe(`${url}/api/v1/capabilities`);
          expect(call.headers.has("Authorization")).toBe(false);
          expect(call.outcome).toEqual({ status: mode === "non-ok" ? 503 : 200 });
        }
        expect(elapsed).toBe(250);
        const requests = (await readFile(join(stateDir, "requests.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(requests).toHaveLength(3);
        expect(requests.every((request) => request.path === "/api/v1/capabilities" && !request.credential)).toBe(true);
      });
    },
  );

  test.each(["wrong-proof", "connection-refused", "dead-pid", "timeout"])(
    "a %s on the second proof sends no credential",
    async (mode) => {
      const stateDir = await mkdtemp(join(process.env.EMEND_HOME as string, "second-proof-"));
      const url = "http://127.0.0.1:3636";
      const key = randomBytes(32).toString("base64url");
      let probes = 0;
      let elapsed = 0;
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (String(input).endsWith("/server/stop")) return Response.json({ stopping: true }, { status: 202 });
        probes++;
        if (probes > 1) {
          if (mode === "timeout") throw new DOMException("Synthetic timeout", "TimeoutError");
          if (mode !== "wrong-proof")
            throw new TypeError("Synthetic refused connection", { cause: { code: "ECONNREFUSED" } });
        }
        if (mode === "dead-pid")
          vi.mocked(process.kill).mockImplementation(() => {
            throw Object.assign(new Error("Synthetic dead pid"), { code: "ESRCH" });
          });
        const challenge = new Headers(init?.headers).get(SERVER_CHALLENGE_HEADER) as string;
        return Response.json(
          { api: 1, version: "0.1.0", features: ["server-stop"] },
          {
            headers: {
              [SERVER_PROOF_HEADER]: serverProof(probes === 1 ? key : randomBytes(32).toString("base64url"), challenge),
            },
          },
        );
      });
      try {
        await writeFile(join(stateDir, "server.json"), JSON.stringify({ pid: process.pid, url, key }));
        await writeFile(join(stateDir, "admin.token"), `em_${randomBytes(32).toString("base64url")}`, { mode: 0o600 });
        const attempt = stopLocalServer(stateDir, {
          timeoutMs: 250,
          now: () => elapsed,
          sleep: async (ms) => {
            elapsed += ms;
          },
        });
        if (mode === "wrong-proof")
          await expect(attempt).rejects.toEqual(
            new CliError(
              `the emend server at ${url} changed while emend asked it to stop; run emend service install again.`,
            ),
          );
        else if (mode === "timeout")
          await expect(attempt).rejects.toEqual(
            new CliError(`the emend server at ${url} did not answer; stop it, then run emend service install again.`),
          );
        else await expect(attempt).resolves.toBeUndefined();
        expect(probes).toBe(mode === "dead-pid" ? 1 : mode === "timeout" ? 4 : 2);
        expect(elapsed).toBe(mode === "timeout" ? 250 : 0);
        expect(fetch.mock.calls.every(([, init]) => !new Headers(init?.headers).has("Authorization"))).toBe(true);
        expect(fetch.mock.calls.every(([input]) => String(input) === `${url}/api/v1/capabilities`)).toBe(true);
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ["older", "is from an older emend and cannot be asked to stop"],
    ["unanswered", "did not answer"],
    ["never-stop", "did not stop"],
  ])("%s refuses takeover with the prescribed message", async (mode, reason) => {
    await withSyntheticServer(mode, async (stateDir, url) => {
      await expect(stopLocalServer(stateDir, { timeoutMs: 350 })).rejects.toEqual(
        new CliError(`the emend server at ${url} ${reason}; stop it, then run emend service install again.`),
      );
    });
  });

  test("a busy server is retried instead of being treated as absent", async () => {
    await withSyntheticServer("verified", async (stateDir, url) => {
      const fetch = globalThis.fetch;
      const spy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("busy", "TimeoutError"));
      spy.mockImplementation(fetch);
      expect(await stopLocalServer(stateDir)).toBe(url);
      expect(spy.mock.calls.length).toBeGreaterThan(3);
    });
  });

  test("a refused connection and a dead pid mean no server", async () => {
    await withSyntheticServer("verified", async (stateDir, url) => {
      expect(await stopLocalServer(stateDir)).toBe(url);
      for (const pid of [process.pid, 2147483647, 0, -1]) {
        await writeFile(
          join(stateDir, "server.json"),
          JSON.stringify({ pid, url, key: randomBytes(32).toString("base64url") }),
        );
        expect(await stopLocalServer(stateDir)).toBeUndefined();
      }
    });
  });

  test("waitForServer follows the manager's current pid and waits for public origin readiness", async () => {
    await withSyntheticServer("verified", async (stateDir, url) => {
      const calls = spyOnFetchWithoutSignal();
      const { pid } = JSON.parse(await readFile(join(stateDir, "server.json"), "utf8"));
      let elapsed = 0;
      const mainPid = vi.fn(async () => (elapsed === 0 ? pid + 1 : pid));
      const sleep = vi.fn(async (ms: number) => {
        elapsed += ms;
        await writeFile(
          join(stateDir, "server-url.json"),
          JSON.stringify({ baseUrl: elapsed < 400 ? url : "https://review.example.test" }),
        );
      });
      expect(await waitForServer(stateDir, { mainPid, publicOrigin: true, now: () => elapsed, sleep })).toEqual({
        url,
        pid,
      });
      expect(elapsed).toBe(400);
      expect(sleep.mock.calls).toEqual([[200], [200]]);
      expect(mainPid).toHaveBeenCalledTimes(3);
      expect(calls.map((call) => call.outcome)).toEqual([{ status: 200 }, { status: 200 }]);
    });
  });

  test.each([0, 2147483647])("waitForServer refuses a verified server when the main pid is %s", async (mainPid) => {
    await withSyntheticServer("verified", async (stateDir) => {
      const calls = spyOnFetchWithoutSignal();
      let elapsed = 0;
      const queryPid = vi.fn(async () => mainPid);
      const sleep = vi.fn(async (ms: number) => {
        elapsed += ms;
      });
      expect(
        await waitForServer(stateDir, {
          mainPid: queryPid,
          timeoutMs: 120,
          now: () => elapsed,
          sleep,
        }),
      ).toBeNull();
      expect(elapsed).toBe(120);
      expect(sleep.mock.calls).toEqual([[120]]);
      expect(queryPid).toHaveBeenCalledOnce();
      expect(calls).toHaveLength(0);
    });
  });

  test("waitForServer keeps its 15 second deadline with one manager query every 200 ms", async () => {
    const stateDir = await mkdtemp(join(process.env.EMEND_HOME as string, "readiness-polls-"));
    let elapsed = 0;
    const mainPid = vi.fn(async () => 0);
    const sleep = vi.fn(async (ms: number) => {
      elapsed += ms;
    });
    try {
      expect(await waitForServer(stateDir, { mainPid, now: () => elapsed, sleep })).toBeNull();
      expect(elapsed).toBe(15000);
      expect(mainPid).toHaveBeenCalledTimes(75);
      expect(sleep.mock.calls).toEqual(Array.from({ length: 75 }, () => [200]));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test.each(["symlink", "oversized", "http", "credentials"])(
    "readiness refuses an unsafe %s public origin record",
    async (kind) => {
      await withSyntheticServer("verified", async (stateDir) => {
        const calls = spyOnFetchWithoutSignal();
        const read = vi.spyOn(publishRead, "readRegular");
        const path = join(stateDir, "server-url.json");
        const valid = JSON.stringify({ baseUrl: "https://review.example.test" });
        if (kind === "symlink") {
          await writeFile(join(stateDir, "target.json"), valid);
          await symlink(join(stateDir, "target.json"), path);
        } else
          await writeFile(
            path,
            kind === "oversized"
              ? `${valid}${" ".repeat(4096)}`
              : JSON.stringify({
                  baseUrl: kind === "http" ? "http://127.0.0.1:3636" : "https://user:password@review.example.test",
                }),
          );
        let elapsed = 0;
        expect(
          await waitForServer(stateDir, {
            publicOrigin: true,
            timeoutMs: 100,
            now: () => elapsed,
            sleep: async (ms) => {
              elapsed += ms;
            },
          }),
        ).toBeNull();
        expect(calls.map((call) => call.outcome)).toEqual([{ status: 200 }]);
        expect(read.mock.calls).toEqual([[path, LIMITS.publicJsonBytes]]);
      });
    },
  );
});
