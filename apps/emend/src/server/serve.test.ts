import { chmod, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Capabilities } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { ensureServer } from "../cli/server-client.ts";
import { openDb } from "../db/client.ts";
import { instances, tokens } from "../db/schema.ts";
import { testDb } from "../db/test-support.ts";
import { writeSecretFile } from "../state/files.ts";
import { createApp } from "./app.ts";
import { createToken, hashSecret, rotateLocalToken, verifyBearer } from "./auth/tokens.ts";
import { APP_CSP } from "./http/headers.ts";
import { initializeServerState, removeDiscovery, serverConfig, startServer } from "./serve.ts";

test("bootstrap repairs missing, unknown, expired and revoked token files without changing valid tokens", async () => {
  const fixture = await testDb();
  const stateDir = join(fixture.dir, "server");
  let initialized = await initializeServerState(stateDir);
  try {
    const adminPath = join(stateDir, "admin.token");
    const agentPath = join(stateDir, "agent.token");
    const admin = await readFile(adminPath, "utf8");
    const agent = await readFile(agentPath, "utf8");
    expect(admin).toMatch(/^em_[A-Za-z0-9_-]{43}$/);
    const principal = await verifyBearer(initialized.db, `Bearer ${agent}`, Date.now());
    expect(principal?.instanceId).toBe(initialized.instance.id);
    expect((await stat(adminPath)).mode & 0o777).toBe(0o600);
    const self = await initialized.db.query((q) =>
      q.select().from(instances).where(eq(instances.id, initialized.instance.id)).get(),
    );
    expect(self?.isSelf).toBe(true);
    await initialized.db.close();
    initialized = await initializeServerState(stateDir);
    expect(await readFile(adminPath, "utf8")).toBe(admin);
    expect(await readFile(agentPath, "utf8")).toBe(agent);
    const ownerId = principal?.ownerId ?? "";
    await initialized.db.query((q) =>
      q
        .update(tokens)
        .set({ revokedAt: Date.now() })
        .where(and(eq(tokens.ownerId, ownerId), eq(tokens.secretHash, hashSecret(admin)))),
    );
    await initialized.db.query((q) =>
      q
        .update(tokens)
        .set({ expiresAt: 1 })
        .where(and(eq(tokens.ownerId, ownerId), eq(tokens.secretHash, hashSecret(agent)))),
    );
    await initialized.db.close();
    initialized = await initializeServerState(stateDir);
    expect(await readFile(adminPath, "utf8")).not.toBe(admin);
    expect(await readFile(agentPath, "utf8")).not.toBe(agent);
    await writeFile(adminPath, `em_${"a".repeat(43)}`);
    await initialized.db.close();
    initialized = await initializeServerState(stateDir);
    expect(await readFile(adminPath, "utf8")).not.toBe(`em_${"a".repeat(43)}`);
  } finally {
    await initialized.db.close();
    await fixture.cleanup();
  }
});

test("config allows the bound loopbacks and concrete host and enables Secure only for HTTPS base URLs", () => {
  const config = serverConfig("0.0.0.0", 1234, "/synthetic/web", "https://reviewer.example");
  expect(config.allowedHosts).toEqual(["127.0.0.1:1234", "localhost:1234", "[::1]:1234", "reviewer.example"]);
  expect(config.appOrigins).toEqual([
    "http://127.0.0.1:1234",
    "http://localhost:1234",
    "http://[::1]:1234",
    "https://reviewer.example",
  ]);
  expect(config.baseUrl).toBe("https://reviewer.example");
  expect(config.secureCookieHost).toBe("reviewer.example");
  expect(serverConfig("192.0.2.1", 3636, "/synthetic/web").allowedHosts).toContain("192.0.2.1:3636");
  expect(serverConfig("::", 3636, "/synthetic/web").allowedHosts).not.toContain("[::]:3636");
});

test("startServer listens on a free loopback port and writes private discovery state; close removes it", async () => {
  const fixture = await testDb();
  const stateDir = join(fixture.dir, "server");
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ stateDir, port: 0 });
    const path = join(stateDir, "server.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    expect(record).toMatchObject({ url: server.url, pid: process.pid });
    expect(record.port).toBeGreaterThan(0);
    expect(record.startedAt).toMatch(/Z$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const response = await fetch(`${server.url}/api/v1/capabilities`);
    expect(response.status).toBe(200);
    expect(Capabilities.parse(await response.json()).api).toBe(1);
    await server.close();
    await server.close();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await server?.close();
    await fixture.cleanup();
  }
});

test("close preserves discovery state replaced by another pid", async () => {
  const fixture = await testDb();
  const stateDir = join(fixture.dir, "server");
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ stateDir, port: 0 });
    const path = join(stateDir, "server.json");
    await writeFile(path, JSON.stringify({ pid: 2147483647 }));
    await server.close();
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(2147483647);
  } finally {
    await server?.close();
    await fixture.cleanup();
  }
});

test.each(["admin", "agent"] as const)(
  "deleting %s.token rotates and revokes local tokens but preserves another instance",
  async (kind) => {
    const fixture = await testDb();
    const stateDir = join(fixture.dir, "rotation");
    let state = await initializeServerState(stateDir);
    try {
      const path = join(stateDir, `${kind}.token`);
      const old = await readFile(path, "utf8");
      const principal = await verifyBearer(state.db, `Bearer ${old}`, Date.now());
      expect(principal?.instanceId).toBe(state.instance.id);
      const otherId = "11111111-1111-4111-8111-111111111111";
      await state.db.query((q) => q.insert(instances).values({ id: otherId, name: "Synthetic second instance" }));
      const other = await createToken(state.db, principal?.ownerId ?? "", "agent", { instanceId: otherId });
      await rm(path);
      await state.db.close();
      state = await initializeServerState(stateDir);
      const fresh = await readFile(path, "utf8");
      expect(fresh).not.toBe(old);
      expect(await verifyBearer(state.db, `Bearer ${old}`, Date.now())).toBeNull();
      expect(await verifyBearer(state.db, `Bearer ${fresh}`, Date.now())).not.toBeNull();
      expect(await verifyBearer(state.db, `Bearer ${other.secret}`, Date.now())).not.toBeNull();
    } finally {
      await state.db.close();
      await fixture.cleanup();
    }
  },
);

test("deleting instance.json and admin.token retires earlier self credentials but preserves attached agents", async () => {
  const fixture = await testDb();
  const stateDir = join(fixture.dir, "regenerated-instance");
  let state = await initializeServerState(stateDir);
  try {
    const oldInstanceId = state.instance.id;
    const oldAdmin = await readFile(join(stateDir, "admin.token"), "utf8");
    const oldAgent = await readFile(join(stateDir, "agent.token"), "utf8");
    const principal = await verifyBearer(state.db, `Bearer ${oldAdmin}`, Date.now());
    const ownerId = principal?.ownerId ?? "";
    const earlierId = "11111111-1111-4111-8111-111111111111";
    const attachedId = "22222222-2222-4222-8222-222222222222";
    await state.db.query((q) =>
      q.insert(instances).values([
        { id: earlierId, name: "Synthetic earlier self", isSelf: true },
        { id: attachedId, name: "Synthetic attached instance", isSelf: false },
      ]),
    );
    const earlierAdmin = await createToken(state.db, ownerId, "admin", { instanceId: earlierId });
    const earlierAgent = await createToken(state.db, ownerId, "agent", { instanceId: earlierId });
    const attached = await createToken(state.db, ownerId, "agent", { instanceId: attachedId });
    await state.db.close();
    await rm(join(stateDir, "instance.json"));
    await rm(join(stateDir, "admin.token"));
    state = await initializeServerState(stateDir);
    expect(state.instance.id).not.toBe(oldInstanceId);
    const app = createApp({
      ...state,
      now: Date.now,
      config: serverConfig("127.0.0.1", 3636, join(fixture.dir, "synthetic-web")),
    });
    const pair = (secret: string) =>
      app.request("http://127.0.0.1:3636/api/v1/pairings", {
        method: "POST",
        headers: { Host: "127.0.0.1:3636", Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: "{}",
      });
    const refused = await pair(oldAdmin);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: { code: "unauthorized", message: "Authentication is required." } });
    for (const secret of [oldAdmin, oldAgent, earlierAdmin.secret, earlierAgent.secret]) {
      expect(await verifyBearer(state.db, `Bearer ${secret}`, Date.now())).toBeNull();
    }
    expect(await verifyBearer(state.db, `Bearer ${attached.secret}`, Date.now())).toMatchObject({
      ownerId,
      kind: "agent",
      instanceId: attachedId,
    });
    for (const kind of ["admin", "agent"] as const) {
      const fresh = await readFile(join(stateDir, `${kind}.token`), "utf8");
      expect(await verifyBearer(state.db, `Bearer ${fresh}`, Date.now())).toMatchObject({
        ownerId,
        kind,
        instanceId: state.instance.id,
      });
      if (kind === "admin") expect((await pair(fresh)).status).toBe(201);
    }
    const rows = await state.db.query((q) => q.select().from(instances));
    expect(rows.filter((row) => row.isSelf).map((row) => row.id)).toEqual([state.instance.id]);
    for (const id of [oldInstanceId, earlierId, attachedId]) {
      expect(rows.find((row) => row.id === id)?.isSelf).toBe(false);
    }
  } finally {
    await state.db.close();
    await fixture.cleanup();
  }
});

test("failed regenerated-instance repair rolls back retirement and both local token rotations", async () => {
  const fixture = await testDb();
  const stateDir = join(fixture.dir, "failed-regeneration");
  let state = await initializeServerState(stateDir);
  try {
    const oldInstanceId = state.instance.id;
    const oldAdmin = await readFile(join(stateDir, "admin.token"), "utf8");
    const oldAgent = await readFile(join(stateDir, "agent.token"), "utf8");
    const principal = await verifyBearer(state.db, `Bearer ${oldAdmin}`, Date.now());
    const ownerId = principal?.ownerId ?? "";
    await state.db.query((q) =>
      q.exec(
        "CREATE TRIGGER synthetic_repair_failure BEFORE INSERT ON tokens WHEN NEW.kind = 'agent' BEGIN SELECT RAISE(ABORT, 'synthetic repair failure'); END",
      ),
    );
    await state.db.close();
    await rm(join(stateDir, "instance.json"));
    await rm(join(stateDir, "admin.token"));
    await expect(initializeServerState(stateDir)).rejects.toThrow();
    const db = openDb(join(stateDir, "emend.db"));
    try {
      for (const secret of [oldAdmin, oldAgent]) {
        expect(await verifyBearer(db, `Bearer ${secret}`, Date.now())).not.toBeNull();
      }
      const rows = await db.query((q) => q.select().from(instances));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: oldInstanceId, isSelf: true });
      const credentials = await db.query((q) => q.select().from(tokens).where(eq(tokens.ownerId, ownerId)));
      expect(credentials).toHaveLength(2);
      await db.query((q) => q.exec("DROP TRIGGER synthetic_repair_failure"));
    } finally {
      await db.close();
    }
    state = await initializeServerState(stateDir);
    for (const secret of [oldAdmin, oldAgent]) {
      expect(await verifyBearer(state.db, `Bearer ${secret}`, Date.now())).toBeNull();
    }
  } finally {
    await state.db.close();
    await fixture.cleanup();
  }
});

test("server token files tolerate trailing newlines and refuse symlinks without touching their target", async () => {
  const fixture = await testDb();
  const stateDir = join(fixture.dir, "token-files");
  let state = await initializeServerState(stateDir);
  try {
    const path = join(stateDir, "admin.token");
    const secret = await readFile(path, "utf8");
    await writeFile(path, `${secret}\r\n`);
    await state.db.close();
    state = await initializeServerState(stateDir);
    expect(await readFile(path, "utf8")).toBe(`${secret}\r\n`);
    const target = join(fixture.dir, "synthetic-target");
    await writeFile(target, secret, { mode: 0o644 });
    await chmod(target, 0o644);
    await rm(path);
    await symlink(target, path);
    await state.db.close();
    await expect(initializeServerState(stateDir)).rejects.toThrow("Token file must be a regular file.");
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    expect(await readFile(target, "utf8")).toBe(secret);
  } finally {
    await state.db.close();
    await fixture.cleanup();
  }
});

test.each([
  ["127.0.0.1", "http://127.0.0.1:3636"],
  ["::1", "http://[::1]:3636"],
  ["0.0.0.0", "http://127.0.0.1:3636"],
  ["::", "http://[::1]:3636"],
])("bound address %s determines the numeric local URL", (address, url) => {
  expect(serverConfig(address ?? "", 3636, "/synthetic/web").baseUrl).toBe(url);
});

test("discovery cleanup requires pid, timestamp and key to match this server generation", async () => {
  const fixture = await testDb();
  try {
    const path = join(fixture.dir, "server.json");
    const identity = { pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", key: "A".repeat(43) };
    for (const patch of [
      { pid: process.pid + 1 },
      { startedAt: "2026-01-01T00:00:01.000Z" },
      { key: Buffer.alloc(32, 1).toString("base64url") },
    ]) {
      const replacement = { ...identity, ...patch };
      writeSecretFile(path, JSON.stringify(replacement));
      await removeDiscovery(path, identity);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
    }
    writeSecretFile(path, JSON.stringify(identity));
    await removeDiscovery(path, identity);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fixture.cleanup();
  }
});

test.each(["::1", "0.0.0.0"])("listening on %s publishes a reachable numeric URL and proves its key", async (host) => {
  const fixture = await testDb();
  const stateDir = join(fixture.dir, "bound-server");
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ stateDir, host, port: 0 });
    expect(new URL(server.url).hostname).toBe(host === "::1" ? "[::1]" : "127.0.0.1");
    expect(await ensureServer(stateDir)).toEqual({ url: server.url });
    const record = JSON.parse(await readFile(join(stateDir, "server.json"), "utf8"));
    expect(record.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const secret = (await readFile(join(stateDir, "admin.token"), "utf8")).trim();
    const response = await fetch(`${server.url}/api/v1/pairings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const pairing = (await response.json()) as { url: string };
    expect(new URL(pairing.url).origin).toBe(server.url);
  } finally {
    await server?.close();
    await fixture.cleanup();
  }
});

test("raw HTTP malformed Host and invalid URL receive JSON errors with app headers", async () => {
  const fixture = await testDb();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ stateDir: join(fixture.dir, "raw-server"), port: 0 });
    const url = new URL(server.url);
    for (const [host, path, status, code] of [
      ["[broken", "/api/v1/capabilities", 403, "bad_host"],
      [url.host, "http://[broken", 400, "invalid_request"],
    ] as const) {
      const response = await new Promise<{
        status: number | undefined;
        headers: Record<string, unknown>;
        body: string;
      }>((resolve, reject) => {
        const request = httpRequest(
          { hostname: url.hostname, port: url.port, path, headers: { Host: host } },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
          },
        );
        request.on("error", reject);
        request.end();
      });
      expect(response.status).toBe(status);
      expect(JSON.parse(response.body).error.code).toBe(code);
      expect(response.headers["content-security-policy"]).toBe(APP_CSP);
      expect(response.headers["x-frame-options"]).toBe("DENY");
    }
  } finally {
    await server?.close();
    await fixture.cleanup();
  }
});

test("raw HTTP/1.1 without Host receives 403 bad_host JSON and app headers", async () => {
  const fixture = await testDb();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ stateDir: join(fixture.dir, "missing-host"), port: 0 });
    const url = new URL(server.url);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: url.hostname, port: Number(url.port) });
      let raw = "";
      socket.setEncoding("utf8");
      socket.setTimeout(2000, () => socket.destroy(new Error("Synthetic raw HTTP request timed out.")));
      socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nConnection: close\r\n\r\n"));
      socket.on("data", (chunk) => {
        raw += chunk;
      });
      socket.on("end", () => resolve(raw));
      socket.on("error", reject);
    });
    expect(response).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    const [headers, body] = response.split("\r\n\r\n");
    expect(body).toContain('{"error":{"code":"bad_host","message":"The host is not allowed."}}');
    for (const [name, value] of Object.entries({
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "content-security-policy": APP_CSP,
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin",
    })) {
      expect(headers).toContain(`\r\n${name}: ${value}`);
    }
  } finally {
    await server?.close();
    await fixture.cleanup();
  }
});

test("legacy unbound admin tokens are adopted before repair and a failed rotation rolls back revocation", async () => {
  const fixture = await testDb();
  const stateDir = join(fixture.dir, "legacy-server");
  let state = await initializeServerState(stateDir);
  try {
    const path = join(stateDir, "admin.token");
    const old = await readFile(path, "utf8");
    const principal = await verifyBearer(state.db, `Bearer ${old}`, Date.now());
    const ownerId = principal?.ownerId ?? "";
    await state.db.query((q) =>
      q
        .update(tokens)
        .set({ instanceId: null })
        .where(and(eq(tokens.ownerId, ownerId), eq(tokens.secretHash, hashSecret(old)))),
    );
    await rm(path);
    await state.db.close();
    state = await initializeServerState(stateDir);
    expect(await verifyBearer(state.db, `Bearer ${old}`, Date.now())).toBeNull();
    const current = await readFile(path, "utf8");
    await state.db.query((q) =>
      q.exec(
        "CREATE TRIGGER synthetic_rotation_failure BEFORE INSERT ON tokens WHEN NEW.kind = 'admin' BEGIN SELECT RAISE(ABORT, 'synthetic rotation failure'); END",
      ),
    );
    await expect(
      state.db.transaction((q) => rotateLocalToken(q, ownerId, "admin", state.instance.id, Date.now())),
    ).rejects.toThrow();
    expect(await verifyBearer(state.db, `Bearer ${current}`, Date.now())).not.toBeNull();
  } finally {
    await state.db.close();
    await fixture.cleanup();
  }
});

test("config with a public origin that has a port allows exactly that host and uses it everywhere", () => {
  const config = serverConfig("127.0.0.1", 1234, "/synthetic/web", "https://reviewer.example:13636");
  expect(config.allowedHosts).toEqual(["127.0.0.1:1234", "localhost:1234", "[::1]:1234", "reviewer.example:13636"]);
  expect(config.appOrigins).toContain("https://reviewer.example:13636");
  expect(config.appOrigins).not.toContain("https://reviewer.example");
  expect(config.baseUrl).toBe("https://reviewer.example:13636");
  expect(config.secureCookieHost).toBe("reviewer.example:13636");
  // The default HTTPS port is written without the port, as the browser sends it.
  expect(serverConfig("127.0.0.1", 1234, "/synthetic/web", "https://reviewer.example:443").allowedHosts).toContain(
    "reviewer.example",
  );
});

test("a public origin with a port guards the host, pairs and sets Secure cookies only for that host", async () => {
  const fixture = await testDb();
  const stateDir = join(fixture.dir, "port-server");
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ stateDir, port: 0, publicOrigin: "https://reviewer.example:13636" });
    const target = new URL(server.url);
    const send = (host: string, method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
      new Promise<{ status: number | undefined; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
        const request = httpRequest(
          { hostname: target.hostname, port: target.port, path, method, headers: { Host: host, ...headers } },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              text += chunk;
            });
            response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
          },
        );
        request.on("error", reject);
        request.end(body);
      });
    for (const host of ["reviewer.example", "reviewer.example:443", "reviewer.example:13637"]) {
      const refused = await send(host, "GET", "/api/v1/capabilities");
      expect(refused.status).toBe(403);
      expect(JSON.parse(refused.body).error.code).toBe("bad_host");
    }
    // Before the public origin is ready the saved address stays the loopback one.
    expect(JSON.parse(await readFile(join(stateDir, "server-url.json"), "utf8"))).toEqual({ baseUrl: server.url });
    server.setPublicOriginReady(true);
    expect(JSON.parse(await readFile(join(stateDir, "server-url.json"), "utf8"))).toEqual({
      baseUrl: "https://reviewer.example:13636",
    });
    const secret = (await readFile(join(stateDir, "admin.token"), "utf8")).trim();
    const json = { "Content-Type": "application/json" };
    const created = await send(
      "reviewer.example:13636",
      "POST",
      "/api/v1/pairings",
      { ...json, Authorization: `Bearer ${secret}` },
      JSON.stringify({ purpose: "device" }),
    );
    expect(created.status).toBe(201);
    const pairing = JSON.parse(created.body) as { url: string };
    expect(new URL(pairing.url).origin).toBe("https://reviewer.example:13636");
    const body = JSON.stringify({ secret: new URL(pairing.url).hash.slice(1) });
    const session = await send("reviewer.example:13636", "POST", "/api/v1/session", json, body);
    expect(session.status).toBe(204);
    expect(String(session.headers["set-cookie"])).toContain("Secure");
    const sameOrigin = await send(
      "reviewer.example:13636",
      "POST",
      "/api/v1/pairings",
      { ...json, Authorization: `Bearer ${secret}`, Origin: "https://reviewer.example:13636" },
      JSON.stringify({ purpose: "device" }),
    );
    expect(sameOrigin.status).toBe(201);
    const bareOrigin = await send(
      "reviewer.example:13636",
      "POST",
      "/api/v1/pairings",
      { ...json, Authorization: `Bearer ${secret}`, Origin: "https://reviewer.example" },
      JSON.stringify({ purpose: "device" }),
    );
    expect(bareOrigin.status).toBe(403);
  } finally {
    await server?.close();
    await fixture.cleanup();
  }
});
