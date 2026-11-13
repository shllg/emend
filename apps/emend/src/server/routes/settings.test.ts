import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  InboxList,
  LIMITS,
  ReviewView,
  type SettingsUpdate,
  SettingsView,
  SHORTCUT_DEFAULTS,
  type ShortcutCommand,
} from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Queries } from "../../db/client.ts";
import { devices, reviews, settings } from "../../db/schema.ts";
import * as configReader from "../../state/read-config.ts";
import { createToken, SESSION_MS } from "../auth/tokens.ts";
import { publishReview } from "../mailbox/lifecycle-support.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";
import * as settingsReader from "../settings.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
let file: string;
beforeEach(async () => {
  f = await mailboxFixture();
  file = join(f.dir, "config.json");
  f.deps.configFile = file;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
const config = (value: unknown) => writeFile(file, JSON.stringify(value));
async function view() {
  const response = await f.request("/settings", "GET");
  expect(response.status).toBe(200);
  return SettingsView.parse(await response.json()).approvedActiveHours;
}
async function limitView() {
  const response = await f.request("/settings", "GET");
  expect(response.status).toBe(200);
  return SettingsView.parse(await response.json()).approvedActiveLimit;
}
async function updateLimit(value: number | null, who: "reviewer" | "foreign" = "reviewer") {
  const response = await f.request("/settings", "PATCH", { approvedActiveLimit: value }, who);
  expect(response.status).toBe(200);
  return SettingsView.parse(await response.json()).approvedActiveLimit;
}
async function keyView() {
  const response = await f.request("/settings", "GET");
  expect(response.status).toBe(200);
  return SettingsView.parse(await response.json()).keys;
}
async function updateKeys(keys: NonNullable<SettingsUpdate["keys"]>, who: "reviewer" | "foreign" = "reviewer") {
  const response = await f.request("/settings", "PATCH", { keys }, who);
  expect(response.status).toBe(200);
  return SettingsView.parse(await response.json());
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

test("GET and PATCH answer with the server clock, which matches the inbox clock", async () => {
  const get = SettingsView.parse(await (await f.request("/settings", "GET")).json());
  expect(get.serverTime).toBe(new Date(f.deps.now()).toISOString());
  f.advance(90_000);
  const patch = SettingsView.parse(await (await f.request("/settings", "PATCH", { approvedActiveHours: 3 })).json());
  expect(patch.serverTime).toBe(new Date(f.deps.now()).toISOString());
  expect(Date.parse(patch.serverTime) - Date.parse(get.serverTime)).toBe(90_000);
  expect((await inbox()).serverTime).toBe(patch.serverTime);
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
    expect(await limitView()).toMatchObject({ value: 5, fileError: true });
    expect((await keyView()).fileError).toBe(true);
    expect((await inbox()).approvedActiveHours).toBe(12);
  },
);
test("nonregular, dangling and unreadable files fall back; safe links are read without writes", async () => {
  const target = join(f.dir, "target.json");
  await symlink(target, file);
  expect(await view()).toMatchObject({ fileError: true });
  expect(await limitView()).toMatchObject({ fileError: true });
  await mkdir(target);
  expect(await view()).toMatchObject({ fileError: true });
  expect(await limitView()).toMatchObject({ fileError: true });
  const regular = join(f.dir, "regular.json");
  await writeFile(regular, '{"approvedActiveHours":24,"docRoots":"ignored"}');
  f.deps.configFile = regular;
  await chmod(regular, 0);
  try {
    expect(await view()).toMatchObject({ fileError: true });
    expect(await limitView()).toMatchObject({ fileError: true });
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
test.each([721, -1, 1.5, "3"])("invalid PATCH %j is rejected", async (value) => {
  await error(await f.request("/settings", "PATCH", { approvedActiveHours: value }), 400, "invalid_request");
});

test("shortcut defaults include every command with absent file and override fields", async () => {
  const keys = await keyView();
  expect(keys.fileError).toBe(false);
  expect(Object.keys(keys.commands)).toEqual(Object.keys(SHORTCUT_DEFAULTS));
  for (const [command, key] of Object.entries(SHORTCUT_DEFAULTS))
    expect(keys.commands[command as ShortcutCommand]).toEqual({
      value: key,
      source: "default",
      default: key,
      fileError: false,
      clashWith: null,
    });
  await config({});
  expect(await keyView()).toEqual(keys);
  delete f.deps.configFile;
  expect(await keyView()).toEqual(keys);
});

test("palette mod keys persist in overrides and normalize only in the config file", async () => {
  await config({ keys: { "palette.open": "Mod+Shift+K" } });
  expect((await keyView()).commands["palette.open"]).toMatchObject({
    value: "mod+shift+k",
    file: "mod+shift+k",
    source: "file",
    fileError: false,
  });
  expect((await updateKeys({ "palette.open": { key: "mod+k" } })).keys.commands["palette.open"]).toMatchObject({
    value: "mod+k",
    override: "mod+k",
    source: "override",
  });
  expect((await keyView()).commands["palette.open"].value).toBe("mod+k");
  await error(
    await f.request("/settings", "PATCH", { keys: { "palette.open": { key: "Mod+K" } } }),
    400,
    "invalid_request",
  );
  await config({ keys: { "palette.open": "ctrl+k" } });
  expect((await keyView()).commands["palette.open"]).toMatchObject({ value: "mod+k", fileError: true });
  await updateKeys({ "palette.open": null });
  expect((await keyView()).commands["palette.open"]).toMatchObject({
    value: "mod+shift+p",
    source: "default",
    fileError: true,
  });
});

test("file shortcuts normalize keys, support off and report unusable entries separately", async () => {
  await config({
    approvedActiveHours: 24,
    keys: {
      "inbox.next": "x",
      "inbox.previous": null,
      "inbox.filter": "B",
      "inbox.search": "sHiFt+C",
      "inbox.back": "ctrl+k",
    },
  });
  const keys = await keyView();
  expect(keys.fileError).toBe(false);
  expect(keys.commands["inbox.next"]).toMatchObject({ value: "x", file: "x", source: "file", fileError: false });
  expect(keys.commands["inbox.previous"]).toMatchObject({ value: null, file: null, source: "file", fileError: false });
  expect(keys.commands["inbox.filter"]).toMatchObject({ value: "shift+b", file: "shift+b", source: "file" });
  expect(keys.commands["inbox.search"]).toMatchObject({ value: "shift+c", file: "shift+c", source: "file" });
  expect(keys.commands["inbox.back"]).toEqual({
    value: "u",
    source: "default",
    default: "u",
    fileError: true,
    clashWith: null,
  });
  expect(await view()).toMatchObject({ value: 24, fileError: false });
});

test("unknown file commands flag keys without discarding usable commands", async () => {
  await config({ keys: { unknown: "j", constructor: null, "inbox.next": "x" } });
  const keys = await keyView();
  expect(keys.fileError).toBe(true);
  expect(keys.commands["inbox.next"]).toMatchObject({ value: "x", fileError: false });
  expect(Object.keys(keys.commands)).toEqual(Object.keys(SHORTCUT_DEFAULTS));
  expect(await view()).toMatchObject({ value: 12, fileError: false });
});

test.each([null, [], "x", 12, true])("non-object file keys %j flag only keys", async (keys) => {
  await config({ approvedActiveHours: 24, keys });
  expect(await keyView()).toMatchObject({
    fileError: true,
    commands: { "inbox.next": { value: "j", fileError: false } },
  });
  expect(await view()).toMatchObject({ value: 24, fileError: false });
});

test.each(["{", "[]", "null", "12", '"text"', " ".repeat(LIMITS.publicJsonBytes + 1)])(
  "unusable config document %# flags keys without command entries",
  async (data) => {
    await writeFile(file, data);
    const keys = await keyView();
    expect(keys.fileError).toBe(true);
    expect(keys.commands["inbox.next"]).toEqual({
      value: "j",
      default: "j",
      source: "default",
      fileError: false,
      clashWith: null,
    });
  },
);

test("dangling, nonregular and unreadable shortcut config files are errors; safe links work", async () => {
  const target = join(f.dir, "keys.json");
  await symlink(target, file);
  expect((await keyView()).fileError).toBe(true);
  await mkdir(target);
  expect((await keyView()).fileError).toBe(true);
  const regular = join(f.dir, "regular-keys.json");
  await writeFile(regular, '{"keys":{"inbox.next":"x"}}');
  f.deps.configFile = regular;
  await chmod(regular, 0);
  try {
    expect((await keyView()).fileError).toBe(true);
  } finally {
    await chmod(regular, 0o600);
  }
  const link = join(f.dir, "linked-keys.json");
  await symlink(regular, link);
  f.deps.configFile = link;
  expect(await keyView()).toMatchObject({
    fileError: false,
    commands: { "inbox.next": { value: "x", source: "file" } },
  });
  await updateKeys({ "inbox.next": { key: "y" } });
  expect(await readFile(regular, "utf8")).toBe('{"keys":{"inbox.next":"x"}}');
});

test("PATCH merges shortcut set, off and reset and deletes an empty stored row", async () => {
  await config({ keys: { "inbox.next": "x" } });
  const stored = () =>
    f.db.read((q) =>
      q
        .select()
        .from(settings)
        .where(and(eq(settings.ownerId, f.ownerId), eq(settings.key, "keys")))
        .get(),
    );
  let keys = (await updateKeys({ "inbox.next": { key: "y" } })).keys;
  expect(keys.commands["inbox.next"]).toMatchObject({ value: "y", source: "override", file: "x", override: "y" });
  keys = (await updateKeys({ "inbox.previous": { key: null } })).keys;
  expect(keys.commands["inbox.next"].override).toBe("y");
  expect(keys.commands["inbox.previous"]).toMatchObject({ value: null, source: "override", override: null });
  expect(JSON.parse((await stored())?.value ?? "null")).toEqual({ "inbox.next": "y", "inbox.previous": null });
  keys = (await updateKeys({ "inbox.next": null })).keys;
  expect(keys.commands["inbox.next"]).toEqual({
    value: "x",
    source: "file",
    default: "j",
    file: "x",
    fileError: false,
    clashWith: null,
  });
  expect(keys.commands["inbox.previous"].override).toBeNull();
  await updateKeys({ "inbox.previous": null });
  expect(await stored()).toBeUndefined();
});

test("partial and empty PATCH requests preserve settings that are omitted", async () => {
  await update(48);
  expect((await updateKeys({ "inbox.next": { key: "x" } })).approvedActiveHours).toMatchObject({
    value: 48,
    override: 48,
  });
  const response = await f.request("/settings", "PATCH", {});
  expect(response.status).toBe(200);
  expect(SettingsView.parse(await response.json())).toMatchObject({
    approvedActiveHours: { value: 48, override: 48 },
    keys: { commands: { "inbox.next": { override: "x" } } },
  });
  await update(null);
  expect((await keyView()).commands["inbox.next"].override).toBe("x");
  const both = await f.request("/settings", "PATCH", { approvedActiveHours: 2, keys: { "inbox.next": null } });
  expect(both.status).toBe(200);
  expect(SettingsView.parse(await both.json())).toMatchObject({
    approvedActiveHours: { value: 2 },
    keys: { commands: { "inbox.next": { value: "j", source: "default" } } },
  });
});

test.each([
  { unknown: { key: "j" } },
  { "inbox.next": { key: "A" } },
  { "inbox.next": { key: "SHIFT+a" } },
  { "inbox.next": { key: "ctrl+k" } },
  { "inbox.next": { key: "shift+1" } },
  { "inbox.next": { key: "Escape" } },
  { "inbox.next": { key: "j", extra: true } },
  { "inbox.next": {} },
  { "inbox.next": "j" },
])("invalid shortcut PATCH %j is rejected without writing hours", async (keys) => {
  await error(await f.request("/settings", "PATCH", { approvedActiveHours: 48, keys }), 400, "invalid_request");
  expect(await view()).toMatchObject({ value: 12, source: "default" });
});

test("shortcut overrides and resets are isolated by owner", async () => {
  await updateKeys({ "inbox.next": { key: "x" } }, "foreign");
  expect((await keyView()).commands["inbox.next"].value).toBe("j");
  await updateKeys({ "inbox.next": { key: "y" } });
  await updateKeys({ "inbox.previous": { key: null } }, "foreign");
  expect((await keyView()).commands["inbox.previous"].value).toBe("k");
  await updateKeys({ "inbox.next": null });
  expect((await updateKeys({}, "foreign")).keys.commands["inbox.next"].value).toBe("x");
  await updateKeys({ "inbox.next": null, "inbox.previous": null }, "foreign");
  expect((await keyView()).commands["inbox.next"].value).toBe("j");
});

test.each(["{", "null", "[]", "12", '"j"'])("corrupt stored keys %s are ignored", async (value) => {
  await config({ keys: { "inbox.next": "x" } });
  await f.db.query((q) => q.insert(settings).values({ ownerId: f.ownerId, key: "keys", value }));
  expect((await keyView()).commands["inbox.next"]).toEqual({
    value: "x",
    source: "file",
    default: "j",
    file: "x",
    fileError: false,
    clashWith: null,
  });
  expect((await updateKeys({ "inbox.previous": { key: null } })).keys.commands["inbox.previous"].value).toBeNull();
});

test("invalid stored entries are ignored while normalized keys and off remain usable", async () => {
  await f.db.query((q) =>
    q.insert(settings).values({
      ownerId: f.ownerId,
      key: "keys",
      value: JSON.stringify({
        "inbox.next": "A",
        "inbox.previous": "shift+B",
        "inbox.filter": "x",
        "inbox.search": null,
        unknown: "j",
      }),
    }),
  );
  const keys = await keyView();
  expect(keys.fileError).toBe(false);
  expect(keys.commands["inbox.next"].value).toBe("j");
  expect(keys.commands["inbox.next"]).not.toHaveProperty("override");
  expect(keys.commands["inbox.previous"].value).toBe("k");
  expect(keys.commands["inbox.filter"]).toMatchObject({ value: "x", override: "x", source: "override" });
  expect(keys.commands["inbox.search"]).toMatchObject({ value: null, override: null, source: "override" });
});

test("settings expose shortcut clashes", async () => {
  await config({ keys: { "inbox.next": "k" } });
  const keys = await keyView();
  expect(keys.commands["inbox.next"]).toMatchObject({ value: "k", source: "file", clashWith: null });
  expect(keys.commands["inbox.previous"]).toMatchObject({ value: null, source: "default", clashWith: "inbox.next" });
});

test("a non-reviewer bearer cannot PATCH shortcut overrides", async () => {
  await error(
    await f.request("/settings", "PATCH", { keys: { "inbox.next": { key: "x" } } }, "agent"),
    403,
    "forbidden",
  );
  expect((await keyView()).commands["inbox.next"].value).toBe("j");
});

test("review reads do not load shortcut settings", async () => {
  const readKeys = vi.spyOn(settingsReader, "readKeySettings");
  await inbox();
  expect((await f.request(`/reviews/${f.reviewId}`, "GET")).status).toBe(200);
  expect(readKeys).not.toHaveBeenCalled();
  await keyView();
  expect(readKeys).toHaveBeenCalledOnce();
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

test("settings and review routes read config outside database callbacks", async () => {
  await config({ approvedActiveHours: 24 });
  let inside = 0;
  const fileReads: number[] = [];
  const read = f.db.read.bind(f.db),
    transaction = f.db.transaction.bind(f.db);
  const wrap =
    <T>(callback: (q: Queries) => Promise<T>) =>
    async (q: Queries) => {
      inside++;
      try {
        return await callback(q);
      } finally {
        inside--;
      }
    };
  vi.spyOn(f.db, "read").mockImplementation((callback) => read(wrap(callback)));
  vi.spyOn(f.db, "transaction").mockImplementation((callback, options) => transaction(wrap(callback), options));
  const readJson = configReader.readConfigJson;
  vi.spyOn(configReader, "readConfigJson").mockImplementation(async (...args) => {
    fileReads.push(inside);
    return readJson(...args);
  });
  expect(await view()).toMatchObject({ value: 24, fileError: false });
  expect(await update(2)).toMatchObject({ value: 2, file: 24 });
  expect((await inbox()).approvedActiveHours).toBe(2);
  const single = await f.request(`/reviews/${f.reviewId}`, "GET");
  expect(single.status).toBe(200);
  expect(fileReads).toEqual([0, 0, 0, 0]);
});

test("the approval cap uses the default, file and owner override, and reset falls back", async () => {
  expect(await limitView()).toEqual({
    value: 5,
    source: "default",
    default: 5,
    file: null,
    override: null,
    fileError: false,
  });
  expect((await inbox()).approvedActiveLimit).toBe(5);
  await config({ approvedActiveLimit: 10 });
  expect(await limitView()).toMatchObject({ value: 10, source: "file", file: 10, fileError: false });
  expect((await inbox()).approvedActiveLimit).toBe(10);
  expect(await updateLimit(2)).toMatchObject({ value: 2, source: "override", file: 10, override: 2 });
  expect((await inbox()).approvedActiveLimit).toBe(2);
  expect(await updateLimit(0)).toMatchObject({ value: 0, source: "override" });
  expect((await inbox()).approvedActiveLimit).toBe(0);
  expect(await updateLimit(null)).toMatchObject({ value: 10, source: "file", override: null });
  expect((await inbox()).approvedActiveLimit).toBe(10);
  await config({});
  expect(await limitView()).toMatchObject({ value: 5, source: "default", fileError: false });
  delete f.deps.configFile;
  expect(await limitView()).toMatchObject({ value: 5, source: "default", fileError: false });
});

test.each([-1, 1.5, 201, "5", null])("invalid file cap %j flags only the cap", async (approvedActiveLimit) => {
  await config({ approvedActiveHours: 24, approvedActiveLimit, keys: { "inbox.next": "x" } });
  expect(await limitView()).toMatchObject({ value: 5, source: "default", file: null, fileError: true });
  expect(await view()).toMatchObject({ value: 24, source: "file", fileError: false });
  expect(await keyView()).toMatchObject({
    fileError: false,
    commands: { "inbox.next": { value: "x", fileError: false } },
  });
  expect((await inbox()).approvedActiveLimit).toBe(5);
  expect(await updateLimit(3)).toMatchObject({ value: 3, source: "override", fileError: true });
});

test("invalid file hours do not affect a usable cap", async () => {
  await config({ approvedActiveHours: -1, approvedActiveLimit: 10 });
  expect(await view()).toMatchObject({ value: 12, fileError: true });
  expect(await limitView()).toMatchObject({ value: 10, fileError: false });
});

test.each([-1, 1.5, 201, "5"])("invalid cap PATCH %j leaves hours and cap unchanged", async (approvedActiveLimit) => {
  await error(
    await f.request("/settings", "PATCH", { approvedActiveHours: 24, approvedActiveLimit }),
    400,
    "invalid_request",
  );
  expect(await view()).toMatchObject({ value: 12, source: "default" });
  expect(await limitView()).toMatchObject({ value: 5, source: "default" });
});

test("cap updates reject extra keys and require a reviewer", async () => {
  await error(await f.request("/settings", "PATCH", { approvedActiveLimit: 3, extra: true }), 400, "invalid_request");
  await error(await f.request("/settings", "PATCH", { approvedActiveLimit: 3 }, "agent"), 403, "forbidden");
  expect(await limitView()).toMatchObject({ value: 5, source: "default" });
});

test("numeric settings can be updated together or independently without losing the other override", async () => {
  const response = await f.request("/settings", "PATCH", {
    approvedActiveHours: 24,
    approvedActiveLimit: 10,
    keys: { "inbox.next": { key: "x" } },
  });
  expect(response.status).toBe(200);
  expect(SettingsView.parse(await response.json())).toMatchObject({
    approvedActiveHours: { value: 24, override: 24 },
    approvedActiveLimit: { value: 10, override: 10 },
    keys: { commands: { "inbox.next": { value: "x" } } },
  });
  await updateLimit(0);
  expect(await view()).toMatchObject({ value: 24, override: 24 });
  await update(2);
  expect(await limitView()).toMatchObject({ value: 0, override: 0 });
  await updateLimit(null);
  expect(await view()).toMatchObject({ value: 2, override: 2 });
  expect((await keyView()).commands["inbox.next"].value).toBe("x");
  await update(null);
  expect(await limitView()).toMatchObject({ value: 5, source: "default" });
});

test("cap overrides and resets are isolated by owner", async () => {
  await config({ approvedActiveLimit: 10 });
  await updateLimit(2);
  await updateLimit(20, "foreign");
  expect(await limitView()).toMatchObject({ value: 2, override: 2 });
  await updateLimit(null, "foreign");
  expect(await limitView()).toMatchObject({ value: 2, override: 2 });
  await updateLimit(null);
  expect(await limitView()).toMatchObject({ value: 10, source: "file" });
});

test.each(['"5"', "201", "-1", "1.5", "{"])("unusable stored cap %s is ignored", async (value) => {
  await config({ approvedActiveHours: 24, approvedActiveLimit: 10 });
  await f.db.query((q) => q.insert(settings).values({ ownerId: f.ownerId, key: "approvedActiveLimit", value }));
  expect(await limitView()).toMatchObject({ value: 10, source: "file", override: null });
  expect(await view()).toMatchObject({ value: 24, fileError: false });
});

test("an empty inbox still reports the effective approval cap", async () => {
  await updateLimit(10);
  expect((await f.request(`/reviews/${f.reviewId}`, "DELETE")).status).toBe(204);
  expect(await inbox()).toMatchObject({ items: [], approvedActiveLimit: 10 });
});
