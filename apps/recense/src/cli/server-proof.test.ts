import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { testDb } from "../db/test-support.ts";
import { run } from "../main.ts";
import { writeSecretFile } from "../state/files.ts";
import { apiRequest } from "./http.ts";
import { ensureServer } from "./server-client.ts";
import { localTarget } from "./target.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const url = "http://127.0.0.1:3636";
const key = Buffer.alloc(32, 7).toString("base64url");
const capabilities = { api: 1, version: "0.1.0", features: [] };

test.each(["missing", "wrong", "malformed"])(
  "a stranger returning %s proof never receives the admin bearer",
  async (proof) => {
    const fixture = await testDb();
    try {
      writeSecretFile(join(fixture.dir, "server.json"), JSON.stringify({ url, pid: process.pid, key }));
      writeSecretFile(join(fixture.dir, "admin.token"), `em_${"a".repeat(43)}`);
      const fetcher = vi.fn(async () =>
        Response.json(capabilities, {
          headers: proof === "missing" ? {} : { "X-Recense-Proof": proof === "wrong" ? "A".repeat(43) : "bad" },
        }),
      );
      vi.stubGlobal("fetch", fetcher);
      vi.mocked(spawn).mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
        queueMicrotask(() =>
          child.emit("error", Object.assign(new Error("synthetic start failure"), { code: "EACCES" })),
        );
        return child as unknown as ReturnType<typeof spawn>;
      });
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(
        await run([], {
          stdout: (s) => stdout.push(s),
          stderr: (s) => stderr.push(s),
          env: { RECENSE_HOME: fixture.dir },
          openUrl: async () => true,
        }),
      ).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual(["recense: Could not start the recense server.\n"]);
      for (const call of fetcher.mock.calls) {
        const [target, init] = call as unknown as [string, RequestInit];
        expect(String(target)).toBe(`${url}/api/v1/capabilities`);
        expect(new Headers(init.headers).has("Authorization")).toBe(false);
      }
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        expect.any(Array),
        expect.objectContaining({ cwd: fixture.dir, detached: true, stdio: "ignore" }),
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

test("a valid proof allows discovery and the authenticated fetch re-proves with a fresh challenge", async () => {
  const fixture = await testDb();
  try {
    writeSecretFile(join(fixture.dir, "server.json"), JSON.stringify({ url, pid: process.pid, key }));
    writeSecretFile(join(fixture.dir, "admin.token"), `em_${"a".repeat(43)}`);
    const challenges: string[] = [];
    const fetcher = vi.fn(async (target: string | URL, init?: RequestInit) => {
      if (String(target).endsWith("/capabilities")) {
        const challenge = new Headers(init?.headers).get("X-Recense-Challenge") ?? "";
        challenges.push(challenge);
        expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        return Response.json(capabilities, {
          headers: {
            "X-Recense-Proof": createHmac("sha256", Buffer.from(key, "base64url"))
              .update(challenge)
              .digest("base64url"),
          },
        });
      }
      expect(new Headers(init?.headers).get("Authorization")?.startsWith("Bearer em_")).toBe(true);
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetcher);
    const discovered = await ensureServer(fixture.dir, { timeoutMs: 100 });
    expect(discovered).toEqual({ url });
    expect(
      await apiRequest(fixture.dir, await localTarget(fixture.dir, discovered.url, "admin"), "/pairings", {
        method: "POST",
        body: {},
      }),
    ).toEqual({ ok: true });
    expect(challenges).toHaveLength(2);
    expect(challenges[0]).not.toBe(challenges[1]);
  } finally {
    await fixture.cleanup();
  }
});

test("apiRequest refuses an arbitrary URL even if another server was discovered", async () => {
  const fixture = await testDb();
  try {
    writeSecretFile(join(fixture.dir, "server.json"), JSON.stringify({ url, pid: process.pid, key }));
    writeSecretFile(join(fixture.dir, "admin.token"), `em_${"a".repeat(43)}`);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      apiRequest(fixture.dir, await localTarget(fixture.dir, "http://127.0.0.1:3637", "admin"), "/pairings", {
        method: "POST",
      }),
    ).rejects.toThrow("Could not authenticate the recense server.");
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await fixture.cleanup();
  }
});

test.each([
  ["a server from before the rename, answering only X-Emend-Proof", ["X-Emend-Proof"]],
  ["a current server, answering both names", ["X-Recense-Proof", "X-Emend-Proof"]],
  ["a server answering only the new name", ["X-Recense-Proof"]],
])("discovery accepts a valid proof from %s, and sends every header under both names", async (_name, proofHeaders) => {
  const fixture = await testDb();
  try {
    writeSecretFile(join(fixture.dir, "server.json"), JSON.stringify({ url, pid: process.pid, key }));
    writeSecretFile(join(fixture.dir, "admin.token"), `em_${"a".repeat(43)}`);
    const seen: Headers[] = [];
    const fetcher = vi.fn(async (target: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push(headers);
      if (!String(target).endsWith("/capabilities")) return Response.json({ ok: true });
      const challenge = headers.get("X-Recense-Challenge") ?? "";
      const proof = createHmac("sha256", Buffer.from(key, "base64url")).update(challenge).digest("base64url");
      return Response.json(capabilities, { headers: Object.fromEntries(proofHeaders.map((name) => [name, proof])) });
    });
    vi.stubGlobal("fetch", fetcher);
    const discovered = await ensureServer(fixture.dir, { timeoutMs: 100 });
    expect(discovered).toEqual({ url });
    await apiRequest(fixture.dir, await localTarget(fixture.dir, discovered.url, "admin"), "/pairings", {
      method: "POST",
      body: {},
    });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const headers of seen) {
      expect(headers.get("X-Recense-Client")).toMatch(/^cli\/\d+\.\d+\.\d+$/);
      expect(headers.get("X-Emend-Client")).toBe(headers.get("X-Recense-Client"));
    }
    for (const headers of seen.filter((candidate) => candidate.has("X-Recense-Challenge")))
      expect(headers.get("X-Emend-Challenge")).toBe(headers.get("X-Recense-Challenge"));
  } finally {
    await fixture.cleanup();
  }
});

test("a wrong proof under the old header name is refused like any other", async () => {
  const fixture = await testDb();
  try {
    writeSecretFile(join(fixture.dir, "server.json"), JSON.stringify({ url, pid: process.pid, key }));
    writeSecretFile(join(fixture.dir, "admin.token"), `em_${"a".repeat(43)}`);
    const fetcher = vi.fn(async () => Response.json(capabilities, { headers: { "X-Emend-Proof": "A".repeat(43) } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(ensureServer(fixture.dir, { timeoutMs: 100 })).rejects.toThrow();
    for (const call of fetcher.mock.calls) {
      const [, init] = call as unknown as [string, RequestInit];
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
    }
  } finally {
    await fixture.cleanup();
  }
});
