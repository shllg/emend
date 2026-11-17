import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { publishReview } from "../mailbox/lifecycle-support.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
let dir: string;
let path: string;
beforeEach(async () => {
  f = await mailboxFixture();
  vi.stubEnv("XDG_CONFIG_HOME", join(f.dir, "config"));
  vi.stubEnv("EMEND_HOME", join(f.dir, "state"));
  dir = join(f.dir, "config", "emend", "themes");
  await mkdir(dir, { recursive: true });
  f.deps.themesDir = dir;
  const { reviewId } = await publishReview(f);
  path = `/reviews/${reviewId}/revisions/1/download`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await f.cleanup();
});

test("a named theme supplies the download colours, and HEAD validates it too", async () => {
  await mkdir(join(dir, "mine"));
  await writeFile(
    join(dir, "mine", "theme.json"),
    JSON.stringify({ version: 1, base: "dark", tokens: { "bg-reading": "#000000", "border-1": "#123456" } }),
  );
  const response = await f.request(`${path}?theme=mine`, "GET");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('<meta name="color-scheme" content="dark">');
  expect(html).toContain(":root{--bg:#000000;");
  expect(html).toContain("--border:#123456;");
  const head = await f.request(`${path}?theme=mine`, "HEAD");
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe(response.headers.get("content-type"));
  expect(await head.text()).toBe("");
});

test("missing, refused and invalid names fail before a busy slot, for GET and HEAD", async () => {
  for (const name of ["faint", "broken", "empty"]) await mkdir(join(dir, name));
  await writeFile(
    join(dir, "faint", "theme.json"),
    JSON.stringify({ version: 1, base: "dark", tokens: { "fg-1": "#111" } }),
  );
  await writeFile(join(dir, "broken", "theme.json"), "{");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const get = f.deps.blobs.get.bind(f.deps.blobs);
  const reads = vi.spyOn(f.deps.blobs, "get").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return get(...args);
  });
  const building = Promise.resolve(f.request(path, "GET"));
  try {
    await entered.promise;
    for (const name of ["missing", "empty", "faint", "broken", "../escape", "Bad Name", "system"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await f.request(`${path}?theme=${encodeURIComponent(name)}`, method);
        expect(response.status).toBe(400);
        if (method === "GET") expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      }
    }
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    expect((await building).status).toBe(200);
  }
});

test("an unconfigured themes folder refuses custom names on GET and HEAD", async () => {
  f.deps.themesDir = undefined;
  for (const method of ["GET", "HEAD"]) expect((await f.request(`${path}?theme=mine`, method)).status).toBe(400);
});

test.each(["dark", "light"])("built-in %s keeps its bytes when a themes folder is configured", async (theme) => {
  f.deps.themesDir = undefined;
  const original = await f.request(`${path}?theme=${theme}`, "GET");
  f.deps.themesDir = dir;
  const current = await f.request(`${path}?theme=${theme}`, "GET");
  expect(current.status).toBe(200);
  expect(await current.text()).toBe(await original.text());
});
