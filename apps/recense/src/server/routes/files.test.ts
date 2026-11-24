import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { files } from "../../db/schema.ts";
import { headersForPath } from "../http/headers.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
async function seed(overrides: Partial<typeof files.$inferInsert> = {}) {
  const id = randomUUID();
  await f.db.query((q) =>
    q.insert(files).values({
      id,
      ownerId: f.ownerId,
      revisionId: f.revisionId,
      path: `${id}.txt`,
      role: "diff",
      ord: 0,
      mediaType: "text/html",
      ...overrides,
    }),
  );
  return id;
}
test("diff sides preserve hostile bytes and exact app headers for GET and HEAD", async () => {
  const bytes = Buffer.from(
    "\ufeff<script>alert(1)</script>\r\n<img src=x onerror=alert(1)>\njavascript:alert(1)\n</span><b>\n",
  );
  const blob = await f.deps.blobs.put(f.ownerId, bytes, "text/html");
  const id = await seed({ oldBlob: blob, newBlob: blob });
  for (const side of ["old", "new"])
    for (const method of ["GET", "HEAD"]) {
      const path = `/files/${id}/${side}`;
      const response = await f.request(path, method);
      expect(response.status).toBe(200);
      for (const [name, value] of Object.entries({
        ...headersForPath(`/api/v1${path}`),
        "Content-Type": "text/plain; charset=utf-8",
        "Cross-Origin-Resource-Policy": "same-origin",
      }))
        expect(response.headers.get(name)).toBe(value);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        method === "HEAD" ? new Uint8Array() : new Uint8Array(bytes),
      );
    }
});
test("unknown, foreign, missing side/blob, flags, docs and assets are not_found", async () => {
  const blob = await f.deps.blobs.put(f.ownerId, Buffer.from("synthetic"), "text/plain");
  const id = await seed({ newBlob: blob });
  await error(await f.request(`/files/${id}/new`, "GET", undefined, "foreign"), 404, "not_found");
  await error(await f.request(`/files/${id}/new`, "GET", undefined, "agent"), 403, "forbidden");
  await error(await f.request(`/files/${id}/old`, "GET"), 404, "not_found");
  await error(await f.request(`/files/${randomUUID()}/new`, "GET"), 404, "not_found");
  for (const overrides of [
    {},
    { flag: "binary" as const, newBlob: blob },
    { flag: "oversized" as const, newBlob: blob },
    { role: "doc" as const, newBlob: blob },
    { role: "asset" as const, newBlob: blob },
  ]) {
    const missing = await seed(overrides);
    await error(await f.request(`/files/${missing}/new`, "GET"), 404, "not_found");
    const head = await f.request(`/files/${missing}/new`, "HEAD");
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
  }
  vi.spyOn(f.deps.blobs, "get").mockResolvedValue(null);
  await error(await f.request(`/files/${id}/new`, "GET"), 404, "not_found");
});
test("side lookup uses two owner-filtered selects independent of revision size", async () => {
  const blob = await f.deps.blobs.put(f.ownerId, Buffer.from("synthetic"), "text/plain");
  const id = await seed({ newBlob: blob });
  const selects: string[] = [];
  const read = f.db.read.bind(f.db);
  vi.spyOn(f.db, "read").mockImplementation((fn) =>
    read((q) =>
      fn(
        new Proxy(q, {
          get(target, property, receiver) {
            if (property === "select")
              return (...args: Parameters<typeof q.select>) => {
                const query = q.select(...args);
                selects.push("select");
                return query;
              };
            return Reflect.get(target, property, receiver);
          },
        }),
      ),
    ),
  );
  // Authentication also reads; compare against the same authenticated request with an unknown id.
  await f.request(`/files/${randomUUID()}/new`, "GET");
  const missingCount = selects.length;
  selects.length = 0;
  expect((await f.request(`/files/${id}/new`, "GET")).status).toBe(200);
  const count = selects.length;
  expect(count).toBe(missingCount + 1);
  for (let i = 0; i < 20; i++) await seed({ newBlob: blob });
  selects.length = 0;
  expect((await f.request(`/files/${id}/new`, "GET")).status).toBe(200);
  expect(selects).toHaveLength(count);
});
