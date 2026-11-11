import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InboxList, LIMITS, ReviewView, SettingsView } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { devices, reviews, settings } from "../../db/schema.ts";
import { createToken, SESSION_MS } from "../auth/tokens.ts";
import { publishReview } from "../mailbox/lifecycle-support.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
let file: string;
beforeEach(async () => {
  f = await mailboxFixture();
  file = join(f.dir, "config.json");
  f.deps.configFile = file;
});
afterEach(async () => {
  await f.cleanup();
});
const config = (value: unknown) => writeFile(file, JSON.stringify(value));
async function view() {
  const response = await f.request("/settings", "GET");
  expect(response.status).toBe(200);
  return SettingsView.parse(await response.json()).approvedActiveHours;
}
async function update(value: number | null, who: "reviewer" | "foreign" = "reviewer") {
  const response = await f.request("/settings", "PATCH", { approvedActiveHours: value }, who);
  expect(response.status).toBe(200);
  return SettingsView.parse(await response.json()).approvedActiveHours;
}
async function inbox() {
  const response = await f.request("/reviews", "GET");
  expect(response.status).toBe(200);
  return InboxList.parse(await response.json());
}
async function approved(hoursAgo: number) {
  const { reviewId } = await publishReview(f, { key: hoursAgo.toString(16) });
  await f.db.query((q) =>
    q
      .update(reviews)
      .set({ state: "approved", approvedAt: f.deps.now() - hoursAgo * 3_600_000 })
      .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, reviewId))),
  );
  return reviewId;
}
async function expectList(id: string, list: "active" | "done", window: number) {
  const result = await inbox();
  expect(result.approvedActiveHours).toBe(window);
  const item = result.items.find((item) => item.id === id);
  expect(item?.list).toBe(list);
  const response = await f.request(`/reviews/${id}`, "GET");
  expect(response.status).toBe(200);
  expect(ReviewView.parse(await response.json())).toMatchObject({ list, activeUntil: item?.activeUntil });
}

test("default, file and owner override determine both inbox and single-review reads", async () => {
  expect(await view()).toEqual({
    value: 12,
    source: "default",
    default: 12,
    file: null,
    override: null,
    fileError: false,
  });
  const older = await approved(13),
    recent = await approved(11),
    justApproved = await approved(0);
  await expectList(older, "done", 12);
  await expectList(recent, "active", 12);
  await config({ approvedActiveHours: 24 });
  expect(await view()).toMatchObject({ value: 24, source: "file", file: 24 });
  await expectList(older, "active", 24);
  expect(await update(2)).toMatchObject({ value: 2, source: "override", override: 2, file: 24 });
  await expectList(recent, "done", 2);
  await expectList(justApproved, "active", 2);
  expect(await update(0)).toMatchObject({ value: 0, source: "override" });
  await expectList(justApproved, "done", 0);
  expect(await update(null)).toMatchObject({ value: 24, source: "file", override: null });
  await expectList(older, "active", 24);
  await config({ approvedActiveHours: 1 });
  await expectList(recent, "done", 1);
  expect(await view()).toMatchObject({ value: 1, source: "file" });
  await config({});
  expect(await view()).toMatchObject({ value: 12, source: "default", fileError: false });
  delete f.deps.configFile;
  expect(await view()).toMatchObject({ source: "default", fileError: false });
});

test.each([25.5, -1, 721, "12", null])("invalid file hours %j cannot break inbox reads", async (value) => {
  await config({ approvedActiveHours: value });
  expect(await view()).toMatchObject({ value: 12, source: "default", file: null, fileError: true });
  expect((await inbox()).approvedActiveHours).toBe(12);
  expect(await update(3)).toMatchObject({ value: 3, source: "override", fileError: true });
  expect((await inbox()).approvedActiveHours).toBe(3);
});
test.each(["{", "[]", "null", "12", '"text"', " ".repeat(LIMITS.publicJsonBytes + 1)])(
  "unusable JSON file %# falls back",
  async (data) => {
    await writeFile(file, data);
    expect(await view()).toMatchObject({ value: 12, fileError: true });
    expect((await inbox()).approvedActiveHours).toBe(12);
  },
);
test("nonregular, dangling and unreadable files fall back; safe links are read without writes", async () => {
  const target = join(f.dir, "target.json");
  await symlink(target, file);
  expect(await view()).toMatchObject({ fileError: true });
  await mkdir(target);
  expect(await view()).toMatchObject({ fileError: true });
  const regular = join(f.dir, "regular.json");
  await writeFile(regular, '{"approvedActiveHours":24,"docRoots":"ignored"}');
  f.deps.configFile = regular;
  await chmod(regular, 0);
  try {
    expect(await view()).toMatchObject({ fileError: true });
  } finally {
    await chmod(regular, 0o600);
  }
  const link = join(f.dir, "link.json");
  await symlink(regular, link);
  f.deps.configFile = link;
  expect(await view()).toMatchObject({ value: 24, source: "file", fileError: false });
  await update(2);
  await update(null);
  expect(await readFile(regular, "utf8")).toBe('{"approvedActiveHours":24,"docRoots":"ignored"}');
});
test.each([721, -1, 1.5, "3", undefined])("invalid PATCH %j is rejected", async (value) => {
  await error(await f.request("/settings", "PATCH", { approvedActiveHours: value }), 400, "invalid_request");
});
test("extra keys are refused and writes require a same-origin reviewer session", async () => {
  await error(await f.request("/settings", "PATCH", { approvedActiveHours: 3, extra: true }), 400, "invalid_request");
  const admin = (await createToken(f.db, f.ownerId, "admin")).secret;
  for (const method of ["GET", "PATCH"]) {
    await error(
      await f.request("/settings", method, method === "PATCH" ? { approvedActiveHours: 3 } : undefined, "agent"),
      403,
      "forbidden",
    );
    const base = { Host: "127.0.0.1:3636", "Content-Type": "application/json" };
    const init = { method, ...(method === "PATCH" ? { body: '{"approvedActiveHours":3}' } : {}) };
    for (const [headers, status, code] of [
      [{ ...base, Authorization: `Bearer ${admin}` }, 403, "forbidden"],
      [base, 401, "unauthorized"],
    ] as const)
      await error(await f.app.request("http://127.0.0.1:3636/api/v1/settings", { ...init, headers }), status, code);
  }
});
test("overrides are isolated by owner, including resets", async () => {
  await config({ approvedActiveHours: 24 });
  await update(2);
  await update(48, "foreign");
  expect(await view()).toMatchObject({ value: 2, override: 2 });
  await update(null, "foreign");
  expect(await view()).toMatchObject({ value: 2 });
  await update(null);
  expect(await view()).toMatchObject({ value: 24 });
});
test.each(['"12"', "721", "-1", "1.5", "{"])("unusable stored override %s is ignored", async (value) => {
  await config({ approvedActiveHours: 24 });
  await f.db.query((q) => q.insert(settings).values({ ownerId: f.ownerId, key: "approvedActiveHours", value }));
  expect(await view()).toMatchObject({ value: 24, source: "file", override: null });
});

test("settings reject bearer reviewer credentials, bad origins and oversized bodies", async () => {
  const now = f.deps.now();
  const device = await f.db.query((q) =>
    q.insert(devices).values({ ownerId: f.ownerId, kind: "browser", name: "Synthetic" }).returning().get(),
  );
  if (!device) throw new Error("Missing device");
  const session = (
    await createToken(f.db, f.ownerId, "reviewer", { deviceId: device.id, now, expiresAt: now + SESSION_MS })
  ).secret;
  const url = "http://127.0.0.1:3636/api/v1/settings";
  const base = { Host: "127.0.0.1:3636", "Content-Type": "application/json" };
  for (const method of ["GET", "PATCH"]) {
    await error(
      await f.app.request(url, {
        method,
        headers: { ...base, Authorization: `Bearer ${session}` },
        ...(method === "PATCH" ? { body: '{"approvedActiveHours":3}' } : {}),
      }),
      401,
      "unauthorized",
    );
  }
  for (const origin of [undefined, "https://other.example"]) {
    await error(
      await f.app.request(url, {
        method: "PATCH",
        headers: { ...base, Cookie: `emend_session=${session}`, ...(origin ? { Origin: origin } : {}) },
        body: '{"approvedActiveHours":3}',
      }),
      403,
      "bad_origin",
    );
  }
  await error(
    await f.app.request(url, {
      method: "PATCH",
      headers: { ...base, Cookie: `emend_session=${session}`, Origin: "http://127.0.0.1:3636" },
      body: " ".repeat(LIMITS.requestJsonBytes + 1),
    }),
    413,
    "too_large",
  );
  expect(await view()).toMatchObject({ value: 12, source: "default" });
});
