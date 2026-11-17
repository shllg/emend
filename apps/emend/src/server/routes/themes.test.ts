import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ThemeList } from "@emend/contract";
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
  await writeFile(join(dir, "mine", "theme.json"), JSON.stringify({ version: 1, base: "dark" }));
  for (const who of ["reviewer", "foreign"] as const) {
    const response = await f.request("/themes", "GET", undefined, who);
    expect(response.status).toBe(200);
    expect(ThemeList.parse(await response.json())).toMatchObject({
      folderError: false,
      themes: [{ name: "mine", valid: true, base: "dark" }],
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
