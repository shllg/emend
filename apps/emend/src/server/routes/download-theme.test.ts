import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PublishResponse } from "@emend/contract";
import { applyHtmlLook, buildHtmlDocDownload } from "@emend/core";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { files } from "../../db/schema.ts";
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

const pubCss =
  '@layer emend-file,emend;@font-face{font-family:Example;src:url("data:font/woff2;base64,AA==")}@layer emend{body{color:CanvasText}}';
async function publishHtml(html: string) {
  await writeFile(join(f.dir, "pub-frame.css"), pubCss);
  const response = await f.request(
    "/publish",
    "POST",
    {
      reviewKey: "c".repeat(64),
      repo: null,
      branch: null,
      title: "HTML example",
      base: null,
      head: null,
      topics: [],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      files: [
        {
          path: "page.html",
          role: "doc",
          oldPath: null,
          oldBlob: null,
          flag: null,
          assets: [],
          newBlob: await f.deps.blobs.put(f.ownerId, Buffer.from(html), "text/html"),
        },
      ],
    },
    "agent",
  );
  expect(response.status).toBe(200);
  const published = PublishResponse.parse(await response.json());
  return `/reviews/${published.reviewId}/revisions/${published.revision}/download`;
}
async function seedHtmlTheme(name: string, base: "light" | "dark") {
  await mkdir(join(dir, name));
  await writeFile(
    join(dir, name, "theme.json"),
    JSON.stringify({
      version: 1,
      base,
      tokens: { "border-1": "#123456" },
      fonts: { text: "Unused Font" },
      density: "roomy",
    }),
  );
}

test.each([undefined, "dark", "light", "mine"])(
  "an HTML pub downloads with its stylesheet and selected mode: %s",
  async (selection) => {
    await seedHtmlTheme("mine", "dark");
    const path = await publishHtml(
      '<!doctype html><html lang="en"><head><title>Plan</title><style>p{margin:1px}</style></head><body><p>Seeds</p></body></html>',
    );
    const response = await f.request(`${path}${selection ? `?theme=${selection}` : ""}`, "GET");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<meta name="referrer" content="no-referrer"><style>${pubCss}</style>`);
    expect(html.indexOf(pubCss)).toBeLessThan(html.indexOf("p{margin:1px}"));
    const mode = selection === "mine" ? "dark" : selection;
    if (mode) expect(html).toContain(`data-theme="${mode}"`);
    else expect(html).not.toContain("data-theme=");
    if (selection === "mine") expect(html).toContain("@layer emend{:root:root:root{--border-1:#123456;}}");
    else expect(html).not.toContain("--border-1:#123456;");
    expect(html).not.toContain("Unused Font");
    expect(html).not.toContain("roomy");
  },
);

test.each([undefined, "dark", "light", "night", "day"])(
  "a light-only HTML pub stays light and takes only light-base theme colours: %s",
  async (selection) => {
    await seedHtmlTheme("night", "dark");
    await seedHtmlTheme("day", "light");
    const path = await publishHtml("<style>p{color:#222;background:white}</style><p>Seeds</p>");
    const response = await f.request(`${path}${selection ? `?theme=${selection}` : ""}`, "GET");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<html data-theme="light">');
    expect(html).toContain(pubCss);
    if (selection === "day") expect(html).toContain("@layer emend{:root:root:root{--border-1:#123456;}}");
    else expect(html).not.toContain("--border-1:#123456;");
  },
);

test.each(["custom", null] as const)("a %s HTML look retains the previous download bytes", async (look) => {
  const source = '<meta name="emend-look" content="custom"><style>p{color:purple}</style><p>Seeds</p>';
  const path = await publishHtml(source);
  if (look === null)
    await f.db.query((q) =>
      q
        .update(files)
        .set({ look: null })
        .where(and(eq(files.ownerId, f.ownerId), eq(files.path, "page.html"))),
    );
  await seedHtmlTheme("mine", "dark");
  const expected = (
    await buildHtmlDocDownload({
      html: source,
      docPath: "page.html",
      title: "HTML example",
      resolveAsset: async () => null,
    })
  ).replace(/^\uFEFF/, "");
  for (const selection of [undefined, "dark", "light", "mine"]) {
    const response = await f.request(`${path}${selection ? `?theme=${selection}` : ""}`, "GET");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(expected);
  }
});

test("a command-styled pub downloads with one current copy of the look", async () => {
  const oldCss = "@layer emend{body{--old-look:1}}";
  const source = applyHtmlLook("<!doctype html><p>Seeds</p>", { css: oldCss, lightOnly: false });
  const path = await publishHtml(source);
  const response = await f.request(path, "GET");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html.split(pubCss)).toHaveLength(2);
  expect(html).not.toContain(oldCss);
  expect(html).not.toContain("data-emend-look");
  expect(html).not.toContain("@layer emend-file{");
  expect(html).toContain("<p>Seeds</p>");
});
