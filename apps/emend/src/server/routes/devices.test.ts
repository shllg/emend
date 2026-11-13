import { randomUUID } from "node:crypto";
import { DeviceList, PairingCreated } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { devices, tokens } from "../../db/schema.ts";
import { createApp } from "../app.ts";
import { createToken, SESSION_MS } from "../auth/tokens.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";
import { serverConfig } from "../serve.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  await f.cleanup();
});
async function list() {
  const r = await f.request("/devices", "GET");
  expect(r.status).toBe(200);
  return DeviceList.parse(await r.json()).items;
}
test("lists only live owned devices newest first, current session and nullable last seen", async () => {
  const id = randomUUID();
  await f.db.query((q) =>
    q.insert(devices).values({
      id,
      ownerId: f.ownerId,
      kind: "machine",
      name: "Synthetic machine",
      createdAt: f.deps.now() + 1000,
      lastSeenAt: f.deps.now(),
    }),
  );
  const items = await list();
  expect(items).toHaveLength(2);
  expect(items[0]).toEqual({
    id,
    kind: "machine",
    name: "Synthetic machine",
    createdAt: new Date(f.deps.now() + 1000).toISOString(),
    lastSeenAt: new Date(f.deps.now()).toISOString(),
    current: false,
  });
  expect(items[1]).toMatchObject({ kind: "browser", current: true, lastSeenAt: null });
  const admin = await createToken(f.db, f.ownerId, "admin");
  const response = await f.app.request("http://127.0.0.1:3636/api/v1/devices", {
    headers: { Host: "127.0.0.1:3636", Authorization: `Bearer ${admin.secret}` },
  });
  expect(DeviceList.parse(await response.json()).items.every((item) => !item.current)).toBe(true);
});
test("revokes a device and all bound tokens atomically; current session immediately loses access", async () => {
  const current = (await list()).find((item) => item.current);
  expect(current).toBeDefined();
  const id = current?.id ?? "";
  await createToken(f.db, f.ownerId, "reviewer", { deviceId: id, expiresAt: f.deps.now() + SESSION_MS });
  expect((await f.request(`/devices/${id}`, "DELETE")).status).toBe(204);
  expect((await f.request("/devices", "GET")).status).toBe(401);
  const rows = await f.db.read((q) =>
    q
      .select()
      .from(tokens)
      .where(and(eq(tokens.ownerId, f.ownerId), eq(tokens.deviceId, id))),
  );
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.revokedAt === f.deps.now())).toBe(true);
  const device = await f.db.read((q) =>
    q
      .select()
      .from(devices)
      .where(and(eq(devices.ownerId, f.ownerId), eq(devices.id, id)))
      .get(),
  );
  expect(device?.revokedAt).toBe(f.deps.now());
});
test("foreign, absent and already revoked devices are 404; agent scope is 403", async () => {
  const foreign = await f.db.read((q) => q.select().from(devices).where(eq(devices.ownerId, f.otherOwnerId)).get());
  const revoked = randomUUID();
  await f.db.query((q) =>
    q
      .insert(devices)
      .values({ id: revoked, ownerId: f.ownerId, name: "Old", kind: "browser", revokedAt: f.deps.now() }),
  );
  for (const id of [foreign?.id, randomUUID(), revoked])
    expect((await f.request(`/devices/${id}`, "DELETE")).status).toBe(404);
  expect(await list()).toHaveLength(1);
  for (const [path, method] of [
    ["/devices", "GET"],
    [`/devices/${revoked}`, "DELETE"],
  ])
    expect((await f.request(path ?? "", method, undefined, "agent")).status).toBe(403);
});
test("Tailscale host is opt-in, links are HTTPS fragments, and cookies follow each request on creation, renewal and logout", async () => {
  const tailnet = "hub.example.ts.net";
  const admin = await createToken(f.db, f.ownerId, "admin");
  const request = (
    app: ReturnType<typeof createApp>,
    host: string,
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
  ) =>
    app.request(`http://${host}/api/v1${path}`, {
      method,
      headers: {
        Host: host,
        Origin: host === tailnet ? `https://${host}` : `http://${host}`,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : { Authorization: `Bearer ${admin.secret}` }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect((await request(f.app, tailnet, "/capabilities")).status).toBe(403);
  const config = serverConfig("127.0.0.1", 3636, f.dir, `https://${tailnet}`);
  const app = createApp({ ...f.deps, config });
  expect(config.allowedHosts).toContain(tailnet);
  expect(config.appOrigins).toContain(`https://${tailnet}`);
  for (const host of [tailnet, "127.0.0.1:3636"]) {
    const pairing = PairingCreated.parse(
      await (await request(app, "127.0.0.1:3636", "/pairings", "POST", { purpose: "device" })).json(),
    );
    expect(pairing.url).toMatch(/^https:\/\/hub\.example\.ts\.net\/pair#emp_/);
    expect(new URL(pairing.url).search).toBe("");
    expect(pairing.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const session = await request(app, host, "/session", "POST", { secret: new URL(pairing.url).hash.slice(1) });
    expect(session.status).toBe(204);
    const cookie = session.headers.get("set-cookie") ?? "";
    expect(cookie.includes("Secure")).toBe(host === tailnet);
    f.advance(86_400_000);
    const renew = await request(app, host, "/devices", "GET", undefined, cookie.split(";")[0]);
    expect(renew.status).toBe(200);
    if (host === tailnet) expect(renew.headers.get("set-cookie")).toContain("Secure");
    else expect(renew.headers.has("set-cookie")).toBe(false);
    const logout = await request(app, host, "/session", "DELETE", undefined, cookie.split(";")[0]);
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")?.includes("Secure")).toBe(host === tailnet);
  }
});

test("revoking a device preserves timestamps of previously revoked tokens", async () => {
  const id = (await list()).find((item) => item.current)?.id ?? "";
  const token = await createToken(f.db, f.ownerId, "reviewer", { deviceId: id, expiresAt: f.deps.now() + SESSION_MS });
  const earlier = f.deps.now() - 1000;
  await f.db.query((q) =>
    q
      .update(tokens)
      .set({ revokedAt: earlier })
      .where(and(eq(tokens.ownerId, f.ownerId), eq(tokens.id, token.id))),
  );
  expect((await f.request(`/devices/${id}`, "DELETE")).status).toBe(204);
  const rows = await f.db.read((q) =>
    q
      .select()
      .from(tokens)
      .where(and(eq(tokens.ownerId, f.ownerId), eq(tokens.deviceId, id))),
  );
  expect(rows.find((row) => row.id === token.id)?.revokedAt).toBe(earlier);
  expect(rows.filter((row) => row.id !== token.id).every((row) => row.revokedAt === f.deps.now())).toBe(true);
});
