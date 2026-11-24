import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SampleView } from "@recense/contract";
import * as core from "@recense/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { files, revisions } from "../../db/schema.ts";
import { HTML_DOC_CSP } from "../http/headers.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
const request = (path: string, method = "GET") =>
  f.app.request(`http://127.0.0.1:3636${path}`, {
    method,
    headers: { Host: "127.0.0.1:3636", Cookie: "recense_session=invalid" },
  });
function counts() {
  const db = new DatabaseSync(f.file, { readOnly: true });
  try {
    return Object.fromEntries(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map(({ name }) => [
          name,
          db.prepare(`SELECT count(*) AS n FROM "${String(name).replaceAll('"', '""')}"`).get()?.n,
        ]),
    );
  } finally {
    db.close();
  }
}

test("sample needs a session, retries failed rendering, memoizes success, and leaves stored data unchanged", async () => {
  expect((await request("/api/v1/sample")).status).toBe(401);
  const render = vi.spyOn(core, "buildSampleView").mockRejectedValueOnce(new Error("Synthetic render failure"));
  const inbox = await (await f.request("/reviews", "GET")).json();
  const before = counts();
  const failed = await f.request("/sample", "GET");
  expect(failed.status).toBe(500);
  expect(await failed.json()).toMatchObject({ error: { code: "internal" } });
  const [first, second] = await Promise.all([f.request("/sample", "GET"), f.request("/sample", "GET")]);
  expect(first.status).toBe(200);
  const view = SampleView.parse(await first.json());
  expect(await second.json()).toEqual(view);
  expect(render).toHaveBeenCalledTimes(2);
  expect(counts()).toEqual(before);
  expect(await (await f.request("/reviews", "GET")).json()).toEqual(inbox);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    expect((await f.request("/sample", method)).status).toBe(404);
});

test("sample HTML uses the stored doc path's headers, bridge and theme handling without a cookie", async () => {
  const contentKey = "A".repeat(43);
  const docId = randomUUID();
  const sha = await f.deps.blobs.put(f.ownerId, Buffer.from(core.SAMPLE_HTML), "text/html");
  await f.db.query(async (q) => {
    await q.update(revisions).set({ contentKey }).where(eq(revisions.id, f.revisionId));
    await q.insert(files).values({
      id: docId,
      ownerId: f.ownerId,
      revisionId: f.revisionId,
      path: core.SAMPLE_HTML_PATH,
      role: "doc",
      ord: 0,
      mediaType: "text/html",
      newBlob: sha,
      look: "recense",
    });
  });
  const real = `/content/${contentKey}${docId.replaceAll("-", "")}/${core.SAMPLE_HTML_PATH}`;
  for (const theme of ["dark", "light", "invalid"]) {
    const response = await request(`/content/sample/${core.SAMPLE_HTML_PATH}?theme=${theme}`);
    const stored = await request(`${real}?theme=${theme}`);
    expect(response.status).toBe(200);
    for (const header of [
      "Content-Type",
      "Content-Security-Policy",
      "Cache-Control",
      "Cross-Origin-Resource-Policy",
      "X-Content-Type-Options",
      "Referrer-Policy",
    ])
      expect(response.headers.get(header), header).toBe(stored.headers.get(header));
    expect(response.headers.get("Content-Security-Policy")).toBe(HTML_DOC_CSP);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.text()).toBe(await stored.text());
  }
  for (const path of ["other.html", "sample.html/extra", "sample%2ehtml", "%2fsample.html"])
    expect((await request(`/content/sample/${path}`)).status, path).toBe(404);
});

test("sample media grants the synthetic image exception only to the fixed SVG", async () => {
  const sha = core.SAMPLE_IMAGE_HASH;
  const before = counts();
  for (const method of ["GET", "HEAD"]) {
    const response = await f.request(`/media/${sha}`, method);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe(method === "GET" ? core.SAMPLE_SVG : "");
  }
  expect((await f.request(`/media/${"0".repeat(64)}`, "GET")).status).toBe(404);
  expect(counts()).toEqual(before);
});

test("stored media still uses the owner-filtered lookup", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
  const sha = await f.deps.blobs.put(f.ownerId, png, "image/png");
  await f.db.query((q) =>
    q.insert(files).values({
      id: randomUUID(),
      ownerId: f.ownerId,
      revisionId: f.revisionId,
      path: "parcel.png",
      role: "asset",
      ord: 0,
      mediaType: "image/png",
      newBlob: sha,
    }),
  );
  for (const method of ["GET", "HEAD"]) {
    const response = await f.request(`/media/${sha}`, method);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Length")).toBe(String(png.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(method === "GET" ? png : Buffer.alloc(0));
    expect((await f.request(`/media/${sha}`, method, undefined, "foreign")).status).toBe(404);
  }
});

test("hard-loading the sample address returns the app shell", async () => {
  await writeFile(join(f.dir, "index.html"), "<!doctype html><title>Synthetic app</title>");
  const response = await request("/settings/sample");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Synthetic app");
});
