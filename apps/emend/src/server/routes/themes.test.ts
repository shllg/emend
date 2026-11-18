import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS, ThemeList } from "@emend/contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
let dir: string;
beforeEach(async () => {
  f = await mailboxFixture();
  vi.stubEnv("XDG_CONFIG_HOME", join(f.dir, "config"));
  vi.stubEnv("EMEND_HOME", join(f.dir, "state"));
  dir = join(f.dir, "config", "emend", "themes");
  await mkdir(dir, { recursive: true });
  f.deps.themesDir = dir;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await f.cleanup();
});

test("reviewer sessions get a contract-checked list read afresh each time", async () => {
  await mkdir(join(dir, "mine"));
  await writeFile(join(dir, "mine", "theme.json"), JSON.stringify({ version: 1, base: "dark", density: "compact" }));
  for (const who of ["reviewer", "foreign"] as const) {
    const response = await f.request("/themes", "GET", undefined, who);
    expect(response.status).toBe(200);
    expect(ThemeList.parse(await response.json())).toMatchObject({
      folderError: false,
      themes: [{ name: "mine", valid: true, base: "dark", density: "compact" }],
    });
  }
  await writeFile(join(dir, "mine", "theme.json"), "{");
  const response = await f.request("/themes", "GET");
  expect(ThemeList.parse(await response.json()).themes[0]).toMatchObject({
    valid: false,
    problems: ["theme.json is not valid JSON."],
  });
  await rm(join(dir, "mine", "theme.json"));
  const missingFile = await f.request("/themes", "GET");
  expect(ThemeList.parse(await missingFile.json()).themes).toEqual([
    { name: "mine", valid: false, base: null, problems: ["The folder has no theme.json."] },
  ]);
  await rm(join(dir, "mine"), { recursive: true });
  const missingFolder = await f.request("/themes", "GET");
  expect(ThemeList.parse(await missingFolder.json()).themes).toEqual([]);
});

test("bearer tokens get 403 just as they do for settings", async () => {
  for (const path of ["/themes", "/settings"]) {
    const response = await f.request(path, "GET", undefined, "agent");
    expect(response.status).toBe(403);
  }
});

test("a missing or unconfigured folder yields an empty list", async () => {
  await rm(dir, { recursive: true });
  for (const themesDir of [dir, undefined]) {
    f.deps.themesDir = themesDir;
    const response = await f.request("/themes", "GET");
    expect(response.status).toBe(200);
    expect(ThemeList.parse(await response.json())).toEqual({ themes: [], folderError: false });
  }
});

async function seedFontTheme(file = "Example.woff2") {
  await mkdir(join(dir, "mine"));
  await mkdir(join(dir, "fonts"));
  await writeFile(
    join(dir, "mine", "theme.json"),
    JSON.stringify({ version: 1, base: "dark", fonts: { text: "Example", files: [{ font: "text", file }] } }),
  );
}

test.each([
  ["Example.WOFF2", "font/woff2"],
  ["Example.woff", "font/woff"],
  ["Example.ttf", "font/ttf"],
  ["Example.otf", "font/otf"],
])("named font %s is served with locked-down headers and HEAD support", async (file, type) => {
  await seedFontTheme(file);
  const bytes = Buffer.from("synthetic font bytes");
  await writeFile(join(dir, "fonts", file), bytes);
  for (const method of ["GET", "HEAD"]) {
    const response = await f.request(`/themes/mine/fonts/${file}`, method);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(type);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
    expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(method === "GET" ? bytes : Buffer.alloc(0));
  }
});

test.each(["unlisted", "refused", "unknown", "wrong type", "large", "outside", "missing", "unconfigured"])(
  "font route returns the same 404 for %s files or themes",
  async (kind) => {
    const file = kind === "wrong type" ? "Example.css" : "Example.woff2";
    await seedFontTheme(file);
    const path = join(dir, "fonts", file);
    if (kind === "outside") {
      const target = join(f.dir, file);
      await writeFile(target, "synthetic font bytes");
      await symlink(target, path);
    } else if (kind !== "missing") {
      await writeFile(path, kind === "large" ? Buffer.alloc(LIMITS.themeFontBytes + 1) : "synthetic font bytes");
    }
    if (kind === "refused") await writeFile(join(dir, "mine", "theme.json"), "{}");
    if (kind === "unlisted")
      await writeFile(join(dir, "mine", "theme.json"), JSON.stringify({ version: 1, base: "dark" }));
    if (kind === "unconfigured") f.deps.themesDir = undefined;
    const response = await f.request(`/themes/${kind === "unknown" ? "unknown" : "mine"}/fonts/${file}`, "GET");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "The resource was not found." } });
  },
);

test.each([
  "..%2FExample.woff2",
  "%2e%2e%2FExample.woff2",
  "sub%2FExample.woff2",
  "sub%5CExample.woff2",
  "%2FExample.woff2",
  "%00Example.woff2",
  "Example.woff2%00",
  "Example%252Fother.woff2",
])("font route refuses encoded traversal or unsafe file %s", async (file) => {
  await seedFontTheme();
  await writeFile(join(dir, "fonts", "Example.woff2"), "synthetic font bytes");
  const response = await f.request(`/themes/mine/fonts/${file}`, "GET");
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: { code: "not_found", message: "The resource was not found." } });
});

test.each(["fonts", "dark", "Bad", "..%2Fmine", "%2Fmine", "mine%5Cother", "mine%00"])(
  "font route refuses unsafe or reserved theme name %s",
  async (name) => {
    await seedFontTheme();
    await writeFile(join(dir, "fonts", "Example.woff2"), "synthetic font bytes");
    expect((await f.request(`/themes/${name}/fonts/Example.woff2`, "GET")).status).toBe(404);
  },
);

test("font route requires a reviewer session, just like the list route", async () => {
  await seedFontTheme();
  await writeFile(join(dir, "fonts", "Example.woff2"), "synthetic font bytes");
  for (const method of ["GET", "HEAD"]) {
    const path = "/themes/mine/fonts/Example.woff2";
    const anonymous = await f.app.request(`http://127.0.0.1:3636/api/v1${path}`, {
      method,
      headers: { Host: "127.0.0.1:3636" },
    });
    expect(anonymous.status).toBe(401);
    expect((await f.request(path, method, undefined, "agent")).status).toBe(403);
    expect((await f.request(path, method, undefined, "foreign")).status).toBe(200);
  }
});

test("font authorization is reread when a theme stops naming a file", async () => {
  await seedFontTheme();
  await writeFile(join(dir, "fonts", "Example.woff2"), "synthetic font bytes");
  const path = "/themes/mine/fonts/Example.woff2";
  expect((await f.request(path, "GET")).status).toBe(200);
  await writeFile(join(dir, "mine", "theme.json"), JSON.stringify({ version: 1, base: "dark" }));
  expect((await f.request(path, "GET")).status).toBe(404);
});
