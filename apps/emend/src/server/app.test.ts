import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Capabilities, ERROR_STATUS, ErrorBody, LIMITS, PairingCreated, SCOPES_BY_KIND } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { devices, pairings, tokens } from "../db/schema.ts";
import { testDb } from "../db/test-support.ts";
import { BlobStore } from "../store/blobs.ts";
import { createApp, ENDPOINTS } from "./app.ts";
import { createToken, hashSecret, verifyBearer } from "./auth/tokens.ts";
import { APP_CSP } from "./http/headers.ts";

let fixture: Awaited<ReturnType<typeof testDb>>;
let app: ReturnType<typeof createApp>;
let now: number;
let admin: string;
let agent: string;
let webRoot: string;
let responses: (() => void)[];
const host = "127.0.0.1:3636";
const origin = `http://${host}`;
const day = 86_400_000;
function makeApp(secureCookies = false, extraHost?: string, onStopRequest?: () => void) {
  return createApp({
    db: fixture.db,
    blobs: new BlobStore(fixture.db, join(fixture.dir, "state")),
    instance: { id: fixture.instanceId, name: "Synthetic" },
    now: () => now,
    onStopRequest,
    config: {
      serverKey: "A".repeat(43),
      allowedHosts: [host, "localhost:3636", "[::1]:3636", ...(extraHost ? [extraHost] : [])],
      appOrigins: [origin],
      baseUrl: secureCookies ? "https://example.test" : origin,
      secureCookieHost: secureCookies ? "example.test" : undefined,
      webRoot,
    },
  });
}
function request(path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown) {
  return app.request(
    `${origin}${path.startsWith("/api/") ? path : `/api/v1${path}`}`,
    {
      method,
      headers: { Host: host, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    {
      onResponseSent: (callback) => {
        responses.push(callback);
      },
    },
  );
}
const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}` });
async function issue(purpose = "device", credential: Record<string, string> = bearer(admin)) {
  const response = await request("/pairings", "POST", credential, { purpose });
  expect(response.status).toBe(201);
  return PairingCreated.parse(await response.json());
}
async function login() {
  const pairing = await issue();
  const response = await request("/session", "POST", {}, { secret: new URL(pairing.url).hash.slice(1) });
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}
async function error(response: Response, code: keyof typeof ERROR_STATUS, head = false) {
  expect(response.status).toBe(ERROR_STATUS[code]);
  if (!head) expect(ErrorBody.parse(await response.json()).error.code).toBe(code);
}
beforeEach(async () => {
  responses = [];
  fixture = await testDb();
  now = Date.UTC(2026, 0, 1);
  webRoot = join(fixture.dir, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<h1>Synthetic app</h1>");
  await writeFile(join(webRoot, "app.js"), "export const synthetic = true;");
  admin = (await createToken(fixture.db, fixture.ownerId, "admin", { now })).secret;
  agent = (await createToken(fixture.db, fixture.ownerId, "agent", { instanceId: fixture.instanceId, now })).secret;
  app = makeApp();
});

test("only an admin can request a stop, after the response is sent and only once", async () => {
  const stop = vi.fn();
  app = makeApp(false, undefined, stop);
  expect(Capabilities.parse(await (await request("/capabilities")).json()).features).toContain("server-stop");
  await error(await request("/server/stop", "POST"), "unauthorized");
  await error(await request("/server/stop", "POST", bearer(agent)), "forbidden");
  const cookie = await login();
  await error(await request("/server/stop", "POST", { Cookie: cookie, Origin: origin }), "forbidden");
  await error(await request("/server/stop", "POST", bearer(admin), { extra: true }), "invalid_request");
  expect(responses).toEqual([]);
  const first = await request("/server/stop", "POST", bearer(admin));
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ stopping: true });
  expect(stop).not.toHaveBeenCalled();
  responses.shift()?.();
  expect(stop).toHaveBeenCalledOnce();
  const second = await request("/server/stop", "POST", bearer(admin), {});
  expect(second.status).toBe(202);
  expect(await second.json()).toEqual({ stopping: true });
  responses.shift()?.();
  expect(stop).toHaveBeenCalledOnce();
});

test("without a stop handler the server advertises no feature and refuses the route", async () => {
  expect(Capabilities.parse(await (await request("/capabilities")).json()).features).not.toContain("server-stop");
  await error(await request("/server/stop", "POST", bearer(admin)), "not_found");
  expect(responses).toEqual([]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanup();
});

test("host guard runs first on API and app pages, permitting only explicit hosts", async () => {
  for (const path of ["/capabilities", "/api/v1/unknown"]) {
    await error(
      await request(path, "POST", { Host: "evil.example", Origin: "https://evil.example", "X-Emend-Client": "bad" }),
      "bad_host",
    );
  }
  expect((await app.request(`${origin}/pair`, { headers: { Host: "evil.example" } })).status).toBe(403);
  for (const allowed of [host, "localhost:3636", "[::1]:3636"])
    expect((await request("/capabilities", "GET", { Host: allowed })).status).toBe(200);
  await error(await request("/capabilities", "GET", { Host: "reviewer.example:3636" }), "bad_host");
  app = makeApp(false, "reviewer.example:3636");
  expect((await request("/capabilities", "GET", { Host: "reviewer.example:3636" })).status).toBe(200);
  expect((await request("/capabilities", "GET", { Host: "LOCALHOST:3636" })).status).toBe(200);
});

test("client and origin guards precede credentials and parsing", async () => {
  await error(
    await request("/session", "POST", { "X-Emend-Client": "cli/0.0.1", Origin: "https://evil.example" }),
    "client_outdated",
  );
  for (const version of ["cli/1.0", "other/1.2.3", "cli/01.2.3", "cli/1.2.3-dev", "cli/1.2.3\n"]) {
    if (version.includes("\n")) continue;
    await error(await request("/capabilities", "GET", { "X-Emend-Client": version }), "invalid_request");
  }
  expect((await request("/capabilities", "GET", { "X-Emend-Client": "cli/1.0.0" })).status).toBe(200);
  await error(
    await request("/pairings", "POST", { ...bearer(admin), Origin: "https://evil.example" }, {}),
    "bad_origin",
  );
  await error(await request("/session", "POST", { Cookie: "emend_session=invalid" }, {}), "bad_origin");
  expect((await request("/pairings", "POST", bearer(admin), {})).status).toBe(201);
});

test("every documented API endpoint enforces its scope even before its handler exists", async () => {
  const cookie = await login();
  for (const endpoint of ENDPOINTS) {
    const path = endpoint.path.replace(/:[^/]+/g, "missing");
    if (!path.startsWith("/api/v1")) continue;
    if (endpoint.scope === "public") {
      expect((await request(path, endpoint.method, {}, endpoint.method === "POST" ? {} : undefined)).status).not.toBe(
        401,
      );
      continue;
    }
    await error(await request(path, endpoint.method), "unauthorized", endpoint.method === "HEAD");
    for (const [kind, credential] of [
      ["admin", bearer(admin)],
      ["agent", bearer(agent)],
      ["reviewer", { Cookie: cookie, Origin: origin }],
    ] as const) {
      // Logout is tested separately, since it invalidates this matrix's session.
      if (endpoint.method === "DELETE" && path === "/api/v1/session" && kind === "reviewer") continue;
      const response = await request(
        path,
        endpoint.method,
        credential,
        path === "/api/v1/bin" && endpoint.method === "DELETE"
          ? { version: createHash("sha256").update("").digest("hex") }
          : ["POST", "PATCH", "PUT"].includes(endpoint.method)
            ? {}
            : undefined,
      );
      if (!(SCOPES_BY_KIND[kind] as readonly string[]).includes(endpoint.scope))
        await error(response, "forbidden", endpoint.method === "HEAD");
      else if (path === "/api/v1/settings") {
        if (endpoint.method === "GET") expect(response.status).toBe(200);
        else await error(response, "invalid_request");
      } else if (path === "/api/v1/pairings") expect(response.status).toBe(201);
      else if (["/api/v1/reviews", "/api/v1/devices", "/api/v1/agent/reviews"].includes(path))
        expect(response.status).toBe(200);
      else if (path === "/api/v1/bin") expect(response.status).toBe(endpoint.method === "GET" ? 200 : 204);
      else if (path === "/api/v1/events") {
        expect(response.status).toBe(200);
        await response.body?.cancel();
      } else if (
        path === "/api/v1/publish" ||
        path.startsWith("/api/v1/blobs/") ||
        (endpoint.method === "PUT" && path.endsWith("/viewed")) ||
        (endpoint.method === "POST" && /\/(threads|comments|sends|reply|snooze)$/.test(path)) ||
        (endpoint.method === "PATCH" && path.startsWith("/api/v1/comments/"))
      )
        await error(response, "invalid_request", endpoint.method === "HEAD");
      else if (
        path === "/api/v1/bin/missing" ||
        /\/reviews\/missing(?:$|\/(?:events|take|unsnooze|retire|reopen|bin|restore|revisions\/missing)$)/.test(path)
      )
        await error(response, "unknown_review");
      else await error(response, "not_found", endpoint.method === "HEAD");
    }
  }
  await error(await request("/unlisted"), "unauthorized");
  await error(await request("/unlisted", "GET", bearer(admin)), "not_found");
  const documented = await readFile(new URL("../../../../docs/api.md", import.meta.url), "utf8");
  for (const [, method, path] of documented.matchAll(/\| (GET|POST|DELETE|PATCH|PUT|HEAD) \| `([^`]+)`/g)) {
    expect(ENDPOINTS.some((entry) => entry.method === method && entry.path === path)).toBe(true);
  }
});

test("bearer kinds cannot create reviewer actions even with malformed bodies or absent rows", async () => {
  for (const secret of [admin, agent])
    for (const path of ["/reviews/missing/threads", "/threads/missing/comments", "/reviews/missing/sends"]) {
      await error(await request(path, "POST", bearer(secret)), "forbidden");
    }
  const cookie = await login();
  await error(await request("/reviews", "GET", bearer(cookie.split("=")[1] ?? "")), "unauthorized");
  // Also refuse a reviewer row whose hash happens to have bearer shape.
  const forged = `em_${"x".repeat(43)}`;
  await fixture.db.query((q) =>
    q
      .insert(tokens)
      .values({ ownerId: fixture.ownerId, kind: "reviewer", name: "Synthetic", secretHash: hashSecret(forged) }),
  );
  expect(await verifyBearer(fixture.db, `Bearer ${forged}`, now)).toBeNull();
});

test("secrets have distinct prefixes, only hashes persist and revoked bearer tokens fail", async () => {
  expect(admin).toMatch(/^em_[A-Za-z0-9_-]{43}$/);
  expect(agent).toMatch(/^em_[A-Za-z0-9_-]{43}$/);
  const created = await issue();
  const secret = new URL(created.url).hash.slice(1);
  expect(secret).toMatch(/^emp_[A-Za-z0-9_-]{43}$/);
  const row = await fixture.db.query((q) =>
    q.select().from(pairings).where(eq(pairings.ownerId, fixture.ownerId)).get(),
  );
  expect(row).toMatchObject({
    secretHash: hashSecret(secret),
    codeHash: hashSecret(created.code.replace("-", "")),
    purpose: "device",
  });
  expect(JSON.stringify(row)).not.toContain(secret);
  await fixture.db.query((q) =>
    q
      .update(tokens)
      .set({ revokedAt: now })
      .where(and(eq(tokens.ownerId, fixture.ownerId), eq(tokens.secretHash, hashSecret(admin)))),
  );
  await error(await request("/pairings", "POST", bearer(admin), {}), "unauthorized");
  for (const header of ["Bearer em_bad", `bearer ${agent}`, `Bearer ${agent}x`])
    expect(await verifyBearer(fixture.db, header, now)).toBeNull();
});

test.each([false, true])("one-time device pairing creates a private cookie (secure=%s)", async (secure) => {
  app = makeApp(secure, secure ? "example.test" : undefined);
  const created = await issue();
  const body = { secret: new URL(created.url).hash.slice(1) };
  const responses = await Promise.all([
    request(
      "/session",
      "POST",
      { "User-Agent": "Synthetic <script> Browser", ...(secure ? { Host: "example.test" } : {}) },
      body,
    ),
    request("/session", "POST", secure ? { Host: "example.test" } : {}, body),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([204, 401]);
  const cookie = responses.find((r) => r.status === 204)?.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/^emend_session=ems_[A-Za-z0-9_-]{43};/);
  for (const attribute of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=2592000"])
    expect(cookie).toContain(attribute);
  expect(cookie.includes("Secure")).toBe(secure);
  const rows = await fixture.db.query((q) => q.select().from(devices).where(eq(devices.ownerId, fixture.ownerId)));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.kind).toBe("browser");
  expect(rows[0]?.name).not.toContain("<");
  await error(await request("/session", "POST", {}, body), "unauthorized");
});

test("expired, unknown and machine pairings have the identical refusal; wrong purpose does not consume", async () => {
  const machine = await issue("machine");
  const secret = new URL(machine.url).hash.slice(1);
  const wrong = await request("/session", "POST", {}, { secret });
  const unknown = await request("/session", "POST", {}, { secret: `emp_${"z".repeat(43)}` });
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toEqual(await unknown.json());
  expect(
    (
      await fixture.db.query((q) =>
        q
          .select()
          .from(pairings)
          .where(and(eq(pairings.ownerId, fixture.ownerId), eq(pairings.secretHash, hashSecret(secret))))
          .get(),
      )
    )?.usedAt,
  ).toBeNull();
  const expired = await issue();
  now += 600_000;
  await error(await request("/session", "POST", {}, { secret: new URL(expired.url).hash.slice(1) }), "unauthorized");
});

test("codes normalize and redeem only once", async () => {
  const created = await issue();
  const code = created.code.toLowerCase().replace("-", "").replaceAll("0", "o").replaceAll("1", "l");
  expect((await request("/session", "POST", {}, { code })).status).toBe(204);
  await error(await request("/session", "POST", {}, { code }), "unauthorized");
});

test("code failures use a sliding window, malformed inputs do not count, links work during lockout", async () => {
  for (let i = 0; i < 6; i++)
    await error(await request("/session", "POST", {}, { code: "invalid!" }), "invalid_request");
  for (let i = 0; i < 4; i++) await error(await request("/session", "POST", {}, { code: "ZZZZZZZZ" }), "unauthorized");
  now += 600_001;
  for (let i = 0; i < 4; i++) await error(await request("/session", "POST", {}, { code: "ZZZZZZZZ" }), "unauthorized");
  const link = await issue();
  const codePairing = await issue();
  await error(await request("/session", "POST", {}, { code: "ZZZZZZZZ" }), "rate_limited");
  await error(await request("/session", "POST", {}, { code: codePairing.code }), "rate_limited");
  expect((await request("/session", "POST", {}, { secret: new URL(link.url).hash.slice(1) })).status).toBe(204);
  now += 599_999;
  await error(await request("/session", "POST", {}, { code: codePairing.code }), "rate_limited");
  now += 1;
  const fresh = await issue();
  expect((await request("/session", "POST", {}, { code: fresh.code })).status).toBe(204);
});

test("sessions renew only daily, session-created pairings name the token, logout revokes both rows", async () => {
  const cookie = await login();
  const secret = cookie.split("=")[1] ?? "";
  let response = await request("/reviews", "GET", { Cookie: cookie });
  expect(response.status).toBe(200);
  expect(response.headers.has("set-cookie")).toBe(false);
  const paired = await issue("device", { Cookie: cookie, Origin: origin });
  const reviewer = await fixture.db.query((q) =>
    q
      .select()
      .from(tokens)
      .where(and(eq(tokens.ownerId, fixture.ownerId), eq(tokens.secretHash, hashSecret(secret))))
      .get(),
  );
  const pairing = await fixture.db.query((q) =>
    q
      .select()
      .from(pairings)
      .where(
        and(
          eq(pairings.ownerId, fixture.ownerId),
          eq(pairings.secretHash, hashSecret(new URL(paired.url).hash.slice(1))),
        ),
      )
      .get(),
  );
  expect(pairing?.createdBy).toBe(reviewer?.id);
  now += day - 1;
  expect((await request("/reviews", "GET", { Cookie: cookie })).headers.has("set-cookie")).toBe(false);
  now += 1;
  response = await request("/reviews", "GET", { Cookie: cookie });
  expect(response.headers.get("set-cookie")).toContain("Max-Age=2592000");
  expect((await request("/reviews", "GET", { Cookie: cookie })).headers.has("set-cookie")).toBe(false);
  const renewed = await fixture.db.query((q) =>
    q
      .select()
      .from(tokens)
      .where(and(eq(tokens.ownerId, fixture.ownerId), eq(tokens.secretHash, hashSecret(secret))))
      .get(),
  );
  expect(renewed?.expiresAt).toBe(now + 30 * day);
  response = await request("/session", "DELETE", { Cookie: cookie, Origin: origin });
  expect(response.status).toBe(204);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  await error(await request("/reviews", "GET", { Cookie: cookie }), "unauthorized");
  const device = await fixture.db.query((q) =>
    q.select().from(devices).where(eq(devices.ownerId, fixture.ownerId)).get(),
  );
  expect(device?.revokedAt).toBe(now);
});

test.each(["expired", "token", "device"])("%s sessions are unauthorized", async (reason) => {
  const cookie = await login();
  if (reason === "expired") now += 30 * day;
  if (reason === "token")
    await fixture.db.query((q) =>
      q
        .update(tokens)
        .set({ revokedAt: now })
        .where(and(eq(tokens.ownerId, fixture.ownerId), eq(tokens.kind, "reviewer"))),
    );
  if (reason === "device")
    await fixture.db.query((q) =>
      q.update(devices).set({ revokedAt: now }).where(eq(devices.ownerId, fixture.ownerId)),
    );
  await error(await request("/reviews", "GET", { Cookie: cookie }), "unauthorized");
});

test("body limits run before credentials, parsing runs after scope, and JSON content type is required", async () => {
  await error(await request("/pairings", "POST", { "Content-Length": `${LIMITS.requestJsonBytes + 1}` }), "too_large");
  await error(await request("/publish", "POST", { "Content-Length": `${LIMITS.publishJsonBytes + 1}` }), "too_large");
  await error(
    await request("/publish", "POST", { ...bearer(agent), "Content-Length": `${LIMITS.requestJsonBytes + 1}` }, {}),
    "invalid_request",
  );
  await error(await request("/pairings", "POST", bearer(admin)), "invalid_request");
  await error(await request("/pairings", "POST", bearer(admin), { purpose: "wrong" }), "invalid_request");
  await error(
    await app.request(`${origin}/api/v1/pairings`, {
      method: "POST",
      headers: { Host: host, ...bearer(admin), "Content-Type": "application/json" },
      body: "{",
    }),
    "invalid_request",
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(LIMITS.requestJsonBytes));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  await error(
    await app.request(
      new Request(`${origin}/api/v1/pairings`, {
        method: "POST",
        headers: { Host: host, "Content-Type": "application/json", "Content-Length": "2", ...bearer(admin) },
        body: stream,
        duplex: "half",
      } as RequestInit),
    ),
    "too_large",
  );
});

test("app headers are exact on pages, assets and errors; API errors are never cached", async () => {
  const literal =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  expect(APP_CSP).toBe(literal);
  for (const path of ["/pair", "/app.js", "/api/v1/unknown"]) {
    const response = await app.request(`${origin}${path}`, { headers: { Host: host } });
    expect(response.headers.get("Content-Security-Policy")).toBe(literal);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    if (path.startsWith("/api/")) expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect((await request("/capabilities")).headers.get("Cache-Control")).toBe("no-store");
});

test("web files use a fixed type map, SPA fallbacks, and never escape through paths or symlinks", async () => {
  await writeFile(join(fixture.dir, "outside.txt"), "PRIVATE SYNTHETIC");
  await symlink(join(fixture.dir, "outside.txt"), join(webRoot, "escape.txt"));
  await mkdir(join(webRoot, "folder"));
  for (const path of [
    "/escape.txt",
    "/%2e%2e%2foutside.txt",
    "/%5coutside.txt",
    "/%00",
    "/%1f",
    "/%7f",
    "/folder",
    "/pair",
    "/%zz",
  ]) {
    const response = await app.request(`${origin}${path}`, { headers: { Host: host } });
    expect([200, 404]).toContain(response.status);
    expect(await response.text()).not.toContain("PRIVATE SYNTHETIC");
  }
  const asset = await app.request(`${origin}/app.js`, { headers: { Host: host } });
  expect(asset.headers.get("content-type")).toContain("javascript");
  expect(await asset.text()).toContain("synthetic");
  expect((await app.request(`${origin}/pair`, { headers: { Host: host } })).headers.get("content-type")).toContain(
    "text/html",
  );
  expect((await app.request(`${origin}/content/synthetic/file.html`, { headers: { Host: host } })).status).toBe(404);
  app = createApp({
    db: fixture.db,
    blobs: new BlobStore(fixture.db, join(fixture.dir, "state")),
    instance: { id: fixture.instanceId, name: "Synthetic" },
    now: () => now,
    config: {
      serverKey: "A".repeat(43),
      allowedHosts: [host],
      appOrigins: [origin],
      baseUrl: origin,
      secureCookieHost: undefined,
      webRoot: join(fixture.dir, "missing"),
    },
  });
  await error(await app.request(`${origin}/pair`, { headers: { Host: host } }), "not_found");
});

test("Mermaid HTML is served with only its exact frame policy while app assets keep the app policy", async () => {
  await writeFile(join(webRoot, "mermaid-frame.html"), '<!doctype html><div id="diagram"></div>');
  const frame = await app.request(`${origin}/mermaid-frame.html`, { headers: { Host: host } });
  expect(frame.status).toBe(200);
  expect(frame.headers.get("Content-Type")).toContain("text/html");
  expect(frame.headers.get("Content-Security-Policy")).toBe(
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:",
  );
  expect(frame.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  expect(frame.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(frame.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(frame.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  const appAsset = await app.request(`${origin}/app.js`, { headers: { Host: host } });
  expect(appAsset.headers.get("Content-Security-Policy")).toBe(APP_CSP);
  expect(appAsset.headers.get("X-Frame-Options")).toBe("DENY");
});

test("unexpected errors return and log fixed messages without request input or SQL", async () => {
  const logger = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(fixture.db, "query").mockRejectedValueOnce(new Error("sensitive SQL detail"));
  const response = await request("/pairings?secret=private", "POST", bearer(admin), {});
  await error(response, "internal");
  expect(logger).toHaveBeenCalledExactlyOnceWith("emend: internal server error");
});

test("concurrent wrong codes lock queued valid codes and a new app owns a fresh lock", async () => {
  const pairing = await issue();
  const results = await Promise.all([
    ...Array.from({ length: 5 }, () => request("/session", "POST", {}, { code: "ZZZZZZZZ" })),
    request("/session", "POST", {}, { code: pairing.code }),
  ]);
  expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 429, 429]);
  app = makeApp();
  expect((await request("/session", "POST", {}, { code: pairing.code })).status).toBe(204);
});

test("unknown OPTIONS paths require credentials, then remain unimplemented", async () => {
  for (const method of ["OPTIONS"]) {
    expect((await request("/capabilities", method)).status).toBe(401);
    expect((await request("/capabilities", method, bearer(admin))).status).toBe(404);
  }
});

test("cookie checks reject bearer-shaped secrets and non-reviewer rows", async () => {
  await error(await request("/reviews", "GET", { Cookie: `emend_session=${admin}` }), "unauthorized");
  const secret = `ems_${"a".repeat(43)}`;
  await fixture.db.query((q) =>
    q
      .insert(tokens)
      .values({ ownerId: fixture.ownerId, kind: "admin", name: "Synthetic", secretHash: hashSecret(secret) }),
  );
  await error(await request("/reviews", "GET", { Cookie: `emend_session=${secret}` }), "unauthorized");
});

test("pairing redemption rollback restores its one-time credential if device or token creation fails", async () => {
  const created = await issue();
  const secret = new URL(created.url).hash.slice(1);
  const logger = vi.spyOn(console, "error").mockImplementation(() => {});
  await fixture.db.query((q) =>
    q.exec(
      "CREATE TRIGGER synthetic_token_failure BEFORE INSERT ON tokens WHEN NEW.kind = 'reviewer' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    ),
  );
  await error(await request("/session", "POST", {}, { secret }), "internal");
  expect(logger).toHaveBeenCalledExactlyOnceWith("emend: internal server error");
  const row = await fixture.db.query((q) =>
    q
      .select()
      .from(pairings)
      .where(and(eq(pairings.ownerId, fixture.ownerId), eq(pairings.secretHash, hashSecret(secret))))
      .get(),
  );
  expect(row?.usedAt).toBeNull();
  expect(
    await fixture.db.query((q) => q.select().from(devices).where(eq(devices.ownerId, fixture.ownerId))),
  ).toHaveLength(0);
  await fixture.db.query((q) => q.exec("DROP TRIGGER synthetic_token_failure"));
  expect((await request("/session", "POST", {}, { secret })).status).toBe(204);
});

test("pairings and sessions retain the creating principal's owner", async () => {
  const other = await createToken(fixture.db, fixture.otherOwnerId, "admin", { now });
  const pairing = await issue("device", bearer(other.secret));
  const response = await request("/session", "POST", {}, { secret: new URL(pairing.url).hash.slice(1) });
  expect(response.status).toBe(204);
  const ownedDevices = await fixture.db.query((q) =>
    q.select().from(devices).where(eq(devices.ownerId, fixture.otherOwnerId)),
  );
  expect(ownedDevices).toHaveLength(1);
  expect(
    await fixture.db.query((q) => q.select().from(devices).where(eq(devices.ownerId, fixture.ownerId))),
  ).toHaveLength(0);
});

test("assets get server-chosen content types and external index symlinks are refused", async () => {
  const types = {
    html: "text/html",
    js: "text/javascript",
    css: "text/css",
    svg: "image/svg+xml",
    png: "image/png",
    ico: "image/x-icon",
    webmanifest: "application/manifest+json",
    woff2: "font/woff2",
    json: "application/json",
    txt: "text/plain",
    other: "application/octet-stream",
  };
  for (const [extension, expected] of Object.entries(types)) {
    await writeFile(join(webRoot, `asset.${extension}`), "synthetic");
    const response = await app.request(`${origin}/asset.${extension}`, { headers: { Host: host } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(expected);
  }
  await writeFile(join(fixture.dir, "outside.html"), "PRIVATE SYNTHETIC");
  await rm(join(webRoot, "index.html"));
  await symlink(join(fixture.dir, "outside.html"), join(webRoot, "index.html"));
  const response = await app.request(`${origin}/pair`, { headers: { Host: host } });
  await error(response, "not_found");
});

test("import refuses local agents before parsing; registration validates its public body", async () => {
  await error(await request("/import", "POST", bearer(agent)), "not_found");
  await error(await request("/machines", "POST"), "invalid_request");
});

test("an ambiguous code cannot redeem pairings belonging to different owners", async () => {
  const first = await issue();
  const other = await createToken(fixture.db, fixture.otherOwnerId, "admin", { now });
  const second = await issue("device", bearer(other.secret));
  await fixture.db.query((q) =>
    q
      .update(pairings)
      .set({ codeHash: hashSecret(first.code.replace("-", "")) })
      .where(eq(pairings.ownerId, fixture.otherOwnerId)),
  );
  await error(await request("/session", "POST", {}, { code: first.code }), "unauthorized");
  for (const pairing of [first, second]) {
    expect((await request("/session", "POST", {}, { secret: new URL(pairing.url).hash.slice(1) })).status).toBe(204);
  }
});

test.each(["emend_session =", " emend_session\t=", "\temend_session =", "emend_session= ", "emend_session=\t"])(
  "cookie spelling %s cannot bypass Origin",
  async (prefix) => {
    const cookie = await login();
    const secret = cookie.split("=")[1] ?? "";
    const header = `${prefix}${secret}`;
    await error(await request("/pairings", "POST", { Cookie: header }, {}), "bad_origin");
    expect((await request("/pairings", "POST", { Cookie: header, Origin: origin }, {})).status).toBe(201);
  },
);

test("duplicate session cookies use the same parser for Origin and authentication", async () => {
  const cookie = await login();
  for (const header of [`${cookie}; emend_session=invalid`, `emend_session=invalid; ${cookie}`]) {
    await error(await request("/pairings", "POST", { Cookie: header }, {}), "bad_origin");
    const response = await request("/pairings", "POST", { Cookie: header, Origin: origin }, {});
    expect(response.status).toBe(header.startsWith("emend_session=invalid;") ? 401 : 201);
  }
});

test("unauthorized chunked publish does not pull any of its 2 MiB body", async () => {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const raw = new Request(`${origin}/api/v1/publish`, {
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  await error(await app.request(raw), "unauthorized");
  expect(pulls).toBe(0);
  expect(raw.bodyUsed).toBe(false);
});

test("public JSON routes reject 5 KiB from Content-Length and from the stream", async () => {
  for (const path of ["/session", "/machines"]) {
    await error(await request(path, "POST", { "Content-Length": "5120" }, {}), "too_large");
    await error(await request(path, "POST", {}, { code: "a".repeat(5120) }), "too_large");
  }
});

test("a fresh session request takes no write transaction and only one concurrent renewal sets a cookie", async () => {
  const cookie = await login();
  const transaction = vi.spyOn(fixture.db, "transaction");
  await request("/reviews", "GET", { Cookie: cookie });
  expect(transaction).not.toHaveBeenCalled();
  now += day;
  const responses = await Promise.all([
    request("/reviews", "GET", { Cookie: cookie }),
    request("/reviews", "GET", { Cookie: cookie }),
  ]);
  expect(responses.filter((response) => response.headers.has("set-cookie"))).toHaveLength(1);
  expect(transaction).not.toHaveBeenCalled();
});

test("missing assets return JSON 404, extensionless paths retain SPA fallback, and content stays isolated", async () => {
  const asset = await app.request(`${origin}/assets/missing.js`, { headers: { Host: host } });
  await error(asset, "not_found");
  expect((await app.request(`${origin}/pair`, { headers: { Host: host } })).status).toBe(200);
  const content = await app.request(`${origin}/content/example/page.html`, { headers: { Host: host } });
  expect(content.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(content.headers.get("Cache-Control")).toBe("no-store");
  expect(content.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts;");
  expect(content.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
  expect(content.headers.has("X-Frame-Options")).toBe(false);
});

test("HEAD inherits GET scopes, including public capabilities", async () => {
  expect((await request("/capabilities", "HEAD")).status).toBe(200);
  expect((await request("/reviews", "HEAD")).status).toBe(401);
  expect((await request("/reviews", "HEAD", bearer(agent))).status).toBe(403);
  const cookie = await login();
  expect((await request("/reviews", "HEAD", { Cookie: cookie })).status).toBe(200);
});

test("public capabilities proves a fresh challenge and refuses malformed challenges", async () => {
  const key = "A".repeat(43);
  app = createApp({
    db: fixture.db,
    blobs: new BlobStore(fixture.db, join(fixture.dir, "state")),
    instance: { id: fixture.instanceId, name: "Synthetic" },
    now: () => now,
    config: {
      allowedHosts: [host],
      appOrigins: [origin],
      baseUrl: origin,
      secureCookieHost: undefined,
      webRoot,
      serverKey: key,
    },
  });
  const challenge = Buffer.alloc(32, 1).toString("base64url");
  const response = await request("/capabilities", "GET", { "X-Emend-Challenge": challenge });
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Emend-Proof")).toBe(
    createHmac("sha256", Buffer.from(key, "base64url")).update(challenge).digest("base64url"),
  );
  expect((await request("/capabilities")).headers.has("X-Emend-Proof")).toBe(false);
  for (const value of ["bad", "A".repeat(44), `${"A".repeat(42)}B`]) {
    await error(await request("/capabilities", "GET", { "X-Emend-Challenge": value }), "invalid_request");
  }
});

test("root service worker is JavaScript with no-cache and the unchanged app CSP", async () => {
  await writeFile(join(webRoot, "sw.js"), "self.addEventListener('fetch', () => {});");
  const response = await app.request(`${origin}/sw.js`, { headers: { Host: host } });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("javascript");
  expect(response.headers.get("Cache-Control")).toBe("no-cache");
  expect(response.headers.get("Content-Security-Policy")).toBe(APP_CSP);
});
