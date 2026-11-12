import { describe, expect, test } from "vitest";
import { detectInstall, locateArgs, restoreArgs, updateArgs } from "./install.ts";

const none = async () => undefined;
const tail = "node_modules/@shllg/emend/dist/emend.mjs";

describe("detectInstall", () => {
  test.each([
    [`/home/user/.local/share/mise/installs/npm-shllg-emend/0.1.0/lib/${tail}`, { kind: "mise" }],
    [`/home/user/.local/share/mise/installs/npm-shllg-emend/0.1.0/${tail}`, { kind: "mise" }],
    [`/home/user/.local/share/pnpm/global/5/node_modules/.pnpm/@shllg+emend@0.1.0/${tail}`, { kind: "pnpm" }],
    [`/home/user/.local/pnpm/global/5/${tail}`, { kind: "pnpm" }],
    [`/usr/local/lib/${tail}`, { kind: "npm", prefix: "/usr/local" }],
    [`/home/user/.npm-global/lib/${tail}`, { kind: "npm", prefix: "/home/user/.npm-global" }],
    [
      "/home/user/.local/share/mise/linked-installs/npm-shllg-emend/dev/dist/emend.mjs",
      { kind: "local", where: "mise-link" },
    ],
  ])("%s", async (path, expected) => {
    expect(await detectInstall(path, none)).toEqual(expected);
  });

  test("a checkout is a folder with .git above an entry outside node_modules", async () => {
    expect(
      await detectInstall("/home/user/src/emend/apps/emend/dist/emend.mjs", async () => "/home/user/src/emend"),
    ).toEqual({
      kind: "local",
      where: "checkout",
      root: "/home/user/src/emend",
    });
    expect(await detectInstall("/home/user/src/emend/apps/emend/dist/emend.mjs", none)).toEqual({ kind: "unknown" });
  });

  test("a checkout above node_modules is not a checkout", async () => {
    const lookup = async () => "/home/user/project";
    expect(await detectInstall(`/home/user/project/${tail}`, lookup)).toEqual({ kind: "unknown" });
  });

  test.each([
    ["npm-shllg-emend as a file name", "/m/installs/x/npm-shllg-emend"],
    ["the mise folder names out of order", `/m/npm-shllg-emend/installs/0.1.0/lib/${tail}`],
    ["a missing version folder", `/m/installs/npm-shllg-emend/lib/${tail}`],
    ["a look-alike package", "/usr/local/lib/node_modules/@shllg/emend-evil/dist/emend.mjs"],
    ["a look-alike scope", "/usr/local/lib/node_modules/@shllg-evil/emend/dist/emend.mjs"],
    ["the package twice", "/usr/local/lib/node_modules/@shllg/emend/node_modules/@shllg/emend/dist/emend.mjs"],
    ["a different file", "/usr/local/lib/node_modules/@shllg/emend/dist/other.mjs"],
    ["an npm path without lib", `/usr/local/${tail}`],
    ["an npm path with extra folders", `/usr/local/lib/x/${tail}`],
    ["a relative path", `lib/${tail}`],
    ["an installs path with extra folders", `/m/installs/npm-shllg-emend/0.1.0/extra/lib/${tail}`],
    ["the pnpm look-alike pnpm-x", `/home/user/pnpm-x/${tail}`],
  ])("refuses %s", async (_name, path) => {
    expect(await detectInstall(path, none)).toEqual({ kind: "unknown" });
  });

  test("a mise link is not a release install", async () => {
    const path = `/m/linked-installs/npm-shllg-emend/0.1.0/lib/${tail}`;
    expect(await detectInstall(path, none)).toEqual({ kind: "local", where: "mise-link" });
  });
});

describe("commands", () => {
  const npm = { kind: "npm", prefix: "/usr/local" } as const;
  test("update", () => {
    expect(updateArgs(npm)).toEqual([
      "install",
      "--global",
      "--prefix",
      "/usr/local",
      "--ignore-scripts",
      "@shllg/emend@latest",
    ]);
    expect(updateArgs({ kind: "pnpm" })).toEqual(["add", "--global", "--ignore-scripts", "@shllg/emend@latest"]);
    expect(updateArgs({ kind: "mise" })).toEqual(["upgrade", "--bump", "npm:@shllg/emend"]);
  });
  test("locate", () => {
    expect(locateArgs({ kind: "pnpm" })).toEqual(["root", "--global"]);
    expect(locateArgs({ kind: "mise" })).toEqual(["where", "npm:@shllg/emend"]);
  });
  test("restore", () => {
    expect(restoreArgs(npm, "0.1.0")).toEqual(["install", "--global", "--prefix", "/usr/local", "@shllg/emend@0.1.0"]);
    expect(restoreArgs({ kind: "pnpm" }, "0.1.0")).toEqual(["add", "--global", "@shllg/emend@0.1.0"]);
    expect(restoreArgs({ kind: "mise" }, "0.1.0")).toEqual(["use", "--global", "npm:@shllg/emend@0.1.0"]);
  });
});
