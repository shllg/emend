import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { detectInstall, locateArgs, restoreArgs, updateArgs } from "./install.ts";

const layouts = {
  mise: "mise/installs/npm-shllg-recense/0.1.0/lib/node_modules/@shllg/recense",
  miseDirect: "mise/installs/npm-shllg-recense/0.1.0/node_modules/@shllg/recense",
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
    "pnpm-x/node_modules/@shllg/recense",
  ])("refuses near miss %s", async (layout) => {
    const f = await fixture(layout);
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
