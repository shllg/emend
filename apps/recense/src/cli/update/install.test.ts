import { chmod, cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  detectInstall,
  locateArgs,
  locateMisePackage,
  misePackageFolders,
  restoreArgs,
  updateArgs,
} from "./install.ts";
import { misePackageFixtures } from "./test-support.ts";

const miseInstall = "mise/installs/npm-shllg-recense/0.1.0";
const mise = misePackageFixtures(miseInstall);
const layouts = {
  mise: mise.npm.folder,
  miseBun: mise.bun.folder,
  miseAube: mise.aube.folder,
  misePnpm10: mise.pnpm10.folder,
  misePnpm11: mise.pnpm11.folder,
  miseAubeCli: mise.aube_cli.folder,
  npm: "prefix/lib/node_modules/@shllg/recense",
  miseNode: "mise/installs/node/26.0.0/lib/node_modules/@shllg/recense",
  nvm: "nvm/versions/node/v26/lib/node_modules/@shllg/recense",
  brew: "homebrew/lib/node_modules/@shllg/recense",
  pnpm10: "pnpm/global/5/node_modules/.pnpm/@shllg+recense@0.1.0/node_modules/@shllg/recense",
  pnpm11: "pnpm/store/v11/links/@shllg/recense/0.1.0/hash/node_modules/@shllg/recense",
  linked: "mise/linked-installs/npm-shllg-recense/dev",
  checkout: "checkout/apps/recense",
};
async function fixture(layout: string, manifest: unknown = { name: "@shllg/recense" }, link = true) {
  const root = await mkdtemp(join(process.env.RECENSE_HOME as string, "detect-"));
  const folder = join(root, layout);
  const entry = join(folder, "dist/recense.mjs");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "");
  await writeFile(join(folder, "package.json"), JSON.stringify(manifest));
  if (link) {
    const links = Object.values(mise).find((item) => item.folder === layout)?.links ?? [];
    for (const [target, path] of links) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await symlink(join(root, target), join(root, path));
    }
  }
  if (link && layout.endsWith("lib/node_modules/@shllg/recense")) {
    const prefix = folder.slice(0, -"/lib/node_modules/@shllg/recense".length);
    await mkdir(join(prefix, "bin"), { recursive: true });
    await mkdir(join(folder, "bin"));
    await writeFile(join(folder, "bin/recense"), "");
    await symlink(join(folder, "bin/recense"), join(prefix, "bin/recense"));
  }
  if (layout === layouts.checkout) await mkdir(join(root, "checkout/.git"));
  return { folder, entry, root };
}
describe("confirmed install detection", () => {
  test.each(Object.entries(layouts))("recognizes %s with ownership evidence", async (name, layout) => {
    const f = await fixture(layout);
    const install = await detectInstall(f.entry, async (folder) => folder === f.folder);
    expect(install.kind).toBe(
      name.startsWith("pnpm")
        ? "pnpm"
        : name.startsWith("mise") && name !== "miseNode"
          ? "mise"
          : ["linked", "checkout"].includes(name)
            ? "local"
            : "npm",
    );
  });
  test.each(Object.entries(layouts))("the local-build marker overrides %s", async (_name, layout) => {
    const f = await fixture(layout, { name: "@shllg/recense", recenseLocalBuild: "abc123" });
    expect(await detectInstall(f.entry)).toEqual({ kind: "local", where: "marked" });
  });
  test.each([
    ["pnpm11", join("v11", "f".repeat(64))],
    ["aube_cli", join("global-aube", "e".repeat(64))],
    ["aube", ""],
  ] as const)("keeps the stable entry path for mise with %s", async (layout, parent) => {
    const f = await fixture(mise[layout].folder);
    expect(await detectInstall(f.entry)).toEqual({
      kind: "mise",
      entry: join(await realpath(f.root), miseInstall, parent, "node_modules/@shllg/recense/dist/recense.mjs"),
    });
  });
  test.each([
    layouts.pnpm10,
    layouts.pnpm11,
    "project/node_modules/.pnpm/x/node_modules/@shllg/recense",
    "pnpm/dlx/x/node_modules/@shllg/recense",
  ])("refuses unconfirmed pnpm copy %s", async (layout) => {
    const f = await fixture(layout);
    expect(await detectInstall(f.entry, async () => false)).toEqual({ kind: "unknown" });
  });
  test("npm requires its bin/recense to resolve to this package's launcher", async () => {
    const f = await fixture(layouts.npm, undefined, false);
    expect(await detectInstall(f.entry)).toEqual({ kind: "unknown" });
    const bin = join(f.root, "prefix/bin");
    await mkdir(bin);
    await writeFile(join(bin, "recense"), "foreign");
    expect(await detectInstall(f.entry)).toEqual({ kind: "unknown" });
  });
  test("npm refuses a launcher whose real target is outside its package", async () => {
    const f = await fixture(layouts.npm);
    const launcher = join(f.folder, "bin/recense");
    await rm(launcher);
    await writeFile(join(f.root, "foreign-launcher"), "");
    await symlink(join(f.root, "foreign-launcher"), launcher);
    expect(await detectInstall(f.entry)).toEqual({ kind: "unknown" });
  });
  test.each([{ name: "@shllg/recense-evil" }, {}, { name: "@shllg/recense", recenseLocalBuild: 1 }])(
    "refuses invalid manifest %j",
    async (manifest) => {
      const f = await fixture(layouts.npm, manifest);
      expect(await detectInstall(f.entry)).toEqual({ kind: "unknown" });
    },
  );
  test("bounded manifest reads refuse oversized input", async () => {
    const f = await fixture(layouts.npm);
    await writeFile(join(f.folder, "package.json"), " ".repeat(65537));
    expect(await detectInstall(f.entry)).toEqual({ kind: "unknown" });
  });
  test.each([
    "m/npm-shllg-recense/installs/0.1.0/lib/node_modules/@shllg/recense",
    "m/installs/npm-shllg-recense/lib/node_modules/@shllg/recense",
    "prefix/lib/node_modules/@shllg/recense-evil",
    "prefix/lib/node_modules/@shllg-evil/recense",
    "prefix/lib/node_modules/@shllg/recense/node_modules/@shllg/recense",
    "prefix/node_modules/@shllg/recense",
    "prefix/lib/x/node_modules/@shllg/recense",
    "m/installs/npm-shllg-recense/0.1.0/extra/lib/node_modules/@shllg/recense",
    "m/installs/npm-shllg-recense/0.1.0/global-aube/1a2b-18c3d4e5f60/lib/node_modules/@shllg/recense",
    "m/installs/npm-shllg-recense/.staging/lib/node_modules/@shllg/recense",
    "pnpm-x/node_modules/@shllg/recense",
  ])("refuses near miss %s", async (layout) => {
    const f = await fixture(layout);
    expect(await detectInstall(f.entry)).toEqual({ kind: "unknown" });
  });
  test.each([layouts.miseAube, layouts.misePnpm11])("refuses a store copy without a link: %s", async (layout) => {
    const f = await fixture(layout, undefined, false);
    expect(await detectInstall(f.entry)).toEqual({ kind: "unknown" });
  });
  test("refuses an aube store copy when the top-level link points to a different copy", async () => {
    const f = await fixture(layouts.miseAube);
    const link = join(f.root, miseInstall, "node_modules/@shllg/recense");
    const other = f.folder.replace("@shllg+recense@0.1.0", "@shllg+recense@0.2.0");
    await cp(f.folder, other, { recursive: true });
    await rm(link);
    await symlink(other, link);
    expect(await detectInstall(f.entry)).toEqual({ kind: "unknown" });
  });
  test.each([
    "relative/dist/recense.mjs",
    "/m/installs/x/npm-shllg-recense",
    "/usr/local/lib/node_modules/@shllg/recense/dist/other.mjs",
  ])("refuses invalid entry %s", async (entry) => {
    expect(await detectInstall(entry)).toEqual({ kind: "unknown" });
  });
});

describe("locating the package in a mise install", () => {
  test.each(Object.entries(mise))("locates the %s package", async (_name, layout) => {
    const f = await fixture(layout.folder);
    const located = await locateMisePackage(join(f.root, miseInstall));
    expect(located).toBeDefined();
    expect(await realpath(located as string)).toBe(await realpath(f.folder));
  });
  test("returns the first path to a package even when it is a symlink", async () => {
    const f = await fixture(layouts.miseAubeCli);
    const install = join(f.root, miseInstall);
    const alias = join(install, "global-aube", "e".repeat(64), "node_modules/@shllg/recense");
    expect(await locateMisePackage(install)).toBe(alias);
  });
  test("finds no package in an empty install folder", async () => {
    const install = await mkdtemp(join(process.env.RECENSE_HOME as string, "empty-"));
    expect(await locateMisePackage(install)).toBeUndefined();
  });
  test("refuses two distinct package folders", async () => {
    const f = await fixture(layouts.mise);
    await mkdir(join(f.root, layouts.miseBun), { recursive: true });
    expect(await locateMisePackage(join(f.root, miseInstall))).toBeUndefined();
  });
  test("stops using a v11 listing once it exceeds 64 entries", async () => {
    const f = await fixture(layouts.misePnpm11);
    const install = join(f.root, miseInstall);
    const v11 = join(install, "v11");
    for (let i = 2; i < 64; i++) await writeFile(join(v11, `.ignored-${i}`), "");
    expect(await locateMisePackage(install)).toBeDefined();
    await writeFile(join(v11, ".ignored-64"), "");
    expect(await locateMisePackage(install)).toBeUndefined();
  });
  test("refuses the npm layout when a v11 listing exceeds 64 entries", async () => {
    const f = await fixture(layouts.mise);
    const install = join(f.root, miseInstall);
    const v11 = join(install, "v11");
    await mkdir(v11);
    for (let i = 0; i < 65; i++) await writeFile(join(v11, `entry-${i}`), "");
    expect(await locateMisePackage(install)).toBeUndefined();
    expect(await detectInstall(f.entry)).toEqual({ kind: "unknown" });
  });
  test.skipIf(process.getuid?.() === 0)("refuses the npm layout when global-aube cannot be listed", async () => {
    const f = await fixture(layouts.mise);
    const install = join(f.root, miseInstall);
    const globalAube = join(install, "global-aube");
    await mkdir(globalAube, { mode: 0o700 });
    await chmod(globalAube, 0o000);
    try {
      expect(await locateMisePackage(install)).toBeUndefined();
    } finally {
      await chmod(globalAube, 0o700);
    }
  });
  test("lists package folders in layout and name order", async () => {
    const install = await mkdtemp(join(process.env.RECENSE_HOME as string, "layouts-"));
    const roots = ["lib", "", "10", "5", "v11/a", "v11/b", "v12/c", "global-aube/a", "global-aube/b"];
    const ignored = ["other", "v11/.cache", "v11/node_modules", "global-aube/.cache", "global-aube/node_modules"];
    const folder = (root: string) => join(install, root, "node_modules/@shllg/recense");
    for (const root of [...roots, ...ignored].reverse()) await mkdir(folder(root), { recursive: true });
    await writeFile(join(install, "v13"), "");
    expect(await misePackageFolders(install)).toEqual(roots.map(folder));
  });
});

describe("commands", () => {
  const npm = { kind: "npm", prefix: "/usr/local" } as const;
  test("update and restore use identical safety flags", () => {
    expect(updateArgs(npm)).toEqual([
      "install",
      "--global",
      "--prefix",
      "/usr/local",
      "--ignore-scripts",
      "@shllg/recense@latest",
    ]);
    expect(updateArgs({ kind: "pnpm" })).toEqual([
      "add",
      "--global",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "@shllg/recense@latest",
    ]);
    for (const install of [npm, { kind: "pnpm" } as const])
      expect(restoreArgs(install, "0.1.0")).toEqual(updateArgs(install).map((arg) => arg.replace("@latest", "@0.1.0")));
    expect(updateArgs({ kind: "mise" })).toEqual(["upgrade", "--bump", "npm:@shllg/recense"]);
    expect(restoreArgs({ kind: "mise" }, "0.1.0")).toEqual(["use", "--global", "npm:@shllg/recense@0.1.0"]);
  });
  test("locate queries pnpm's global dependencies and mise's installed folder", () => {
    expect(locateArgs({ kind: "pnpm" })).toEqual([
      "list",
      "--global",
      "--json",
      "--depth",
      "0",
      "--config.ignore-pnpmfile=true",
    ]);
    expect(locateArgs({ kind: "mise" })).toEqual(["where", "npm:@shllg/recense"]);
  });
});
