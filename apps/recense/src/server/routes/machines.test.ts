import { randomUUID } from "node:crypto";
import { DeviceList, MachineRegistered, PairingCreated } from "@recense/contract";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { instances, tokens } from "../../db/schema.ts";
import { createToken, verifyBearer } from "../auth/tokens.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  await f.cleanup();
});
async function pairing(purpose = "machine") {
  const response = await f.request("/pairings", "POST", { purpose });
  const value = PairingCreated.parse(await response.json());
  return { secret: new URL(value.url).hash.slice(1), code: value.code };
}
function request(path: string, method: string, body?: unknown, token?: string) {
  return f.app.request(`http://127.0.0.1:3636/api/v1${path}`, {
    method,
    headers: {
      Host: "127.0.0.1:3636",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const instance = () => ({ id: randomUUID(), name: "Synthetic laptop" });
test.each(["secret", "code"] as const)("registers a machine using %s and detaches every bound token", async (key) => {
  const p = await pairing();
  const machine = instance();
  const registered = await request("/machines", "POST", {
    [key]: key === "code" ? p[key].toLowerCase() : p[key],
    instance: machine,
  });
  expect(registered.status).toBe(201);
  const body = MachineRegistered.parse(await registered.json());
  expect(body.hub).toEqual({ ...f.deps.instance, url: f.deps.config.baseUrl });
  const principal = await verifyBearer(f.db, `Bearer ${body.token}`, f.deps.now());
  expect(principal).toMatchObject({ kind: "agent", instanceId: machine.id, ownerId: f.ownerId });
  const list = DeviceList.parse(await (await f.request("/devices", "GET")).json());
  expect(list.items).toContainEqual(expect.objectContaining({ kind: "machine", name: machine.name }));
  const row = await f.db.read((q) =>
    q
      .select()
      .from(tokens)
      .where(and(eq(tokens.ownerId, f.ownerId), eq(tokens.id, principal?.tokenId ?? "")))
      .get(),
  );
  const extra = await createToken(f.db, f.ownerId, "agent", { instanceId: machine.id, deviceId: row?.deviceId ?? "" });
  expect((await request("/machines/self", "DELETE", undefined, body.token)).status).toBe(204);
  expect((await request("/machines/self", "DELETE", undefined, body.token)).status).toBe(401);
  expect(await verifyBearer(f.db, `Bearer ${extra.secret}`, f.deps.now())).toBeNull();
  expect((await request("/machines", "POST", { secret: (await pairing()).secret, instance: machine })).status).toBe(
    201,
  );
});
test("wrong-purpose, used, expired and unknown pairings give identical unauthorized responses", async () => {
  const used = await pairing();
  expect((await request("/machines", "POST", { secret: used.secret, instance: instance() })).status).toBe(201);
  const expired = await pairing();
  f.advance(600_001);
  const device = await pairing("device");
  const bodies: unknown[] = [];
  for (const secret of [used.secret, expired.secret, device.secret, `emp_${"A".repeat(43)}`]) {
    const response = await request("/machines", "POST", { secret, instance: instance() });
    expect(response.status).toBe(401);
    bodies.push(await response.json());
  }
  expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
});
test("self ids and live attachments refuse without consuming the pairing", async () => {
  const p = await pairing();
  const previous = randomUUID();
  await f.db.query((q) =>
    q.insert(instances).values({ id: previous, name: "Earlier self", isSelf: false, wasSelf: true }),
  );
  for (const id of [f.instanceId, previous])
    await error(
      await request("/machines", "POST", { secret: p.secret, instance: { id, name: "Self" } }),
      400,
      "wrong_origin",
    );
  const machine = instance();
  expect((await request("/machines", "POST", { secret: p.secret, instance: machine })).status).toBe(201);
  const next = await pairing();
  const refused = await request("/machines", "POST", { secret: next.secret, instance: machine });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    error: {
      code: "instance_attached",
      message: "This machine is already attached. Revoke it in the hub's devices, or run recense detach on it.",
    },
  });
  expect((await request("/machines", "POST", { secret: next.secret, instance: instance() })).status).toBe(201);
});
test("session and machine codes share their serialized lockout; secret remains usable", async () => {
  for (let i = 0; i < 5; i++) {
    const response =
      i % 2
        ? await request("/session", "POST", { code: "0000-0000" })
        : await request("/machines", "POST", { code: "0000-0000", instance: instance() });
    expect(response.status).toBe(i === 4 ? 429 : 401);
  }
  const p = await pairing();
  await error(await request("/machines", "POST", { code: p.code, instance: instance() }), 429, "rate_limited");
  expect((await request("/machines", "POST", { secret: p.secret, instance: instance() })).status).toBe(201);
});
test("local agent cannot detach and machine names are bounded", async () => {
  await error(await f.request("/machines/self", "DELETE", undefined, "agent"), 404, "not_found");
  await error(
    await request("/machines", "POST", {
      secret: (await pairing()).secret,
      instance: { ...instance(), name: "x".repeat(201) },
    }),
    400,
    "invalid_request",
  );
});

test("concurrent registration never grants one origin to two live devices", async () => {
  const machine = instance();
  const one = await pairing();
  const two = await pairing();
  const responses = await Promise.all(
    [one, two].map((p) => request("/machines", "POST", { secret: p.secret, instance: machine })),
  );
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  const unused = responses[0]?.status === 409 ? one : two;
  expect((await request("/machines", "POST", { secret: unused.secret, instance: instance() })).status).toBe(201);
});
