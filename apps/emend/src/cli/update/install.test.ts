import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { detectInstall, locateArgs, restoreArgs, updateArgs } from "./install.ts";

const layouts = {
  mise: "mise/installs/npm-shllg-emend/0.1.0/lib/node_modules/@shllg/emend",
  miseDirect: "mise/installs/npm-shllg-emend/0.1.0/node_modules/@shllg/emend",
  npm: "prefix/lib/node_modules/@shllg/emend",
  miseNode: "mise/installs/node/26.0.0/lib/node_modules/@shllg/emend",
  nvm: "nvm/versions/node/v26/lib/node_modules/@shllg/emend",
  brew: "homebrew/lib/node_modules/@shllg/emend",
  pnpm10: "pnpm/global/5/node_modules/.pnpm/@shllg+emend@0.1.0/node_modules/@shllg/emend",
  pnpm11: "pnpm/store/v11/links/@shllg/emend/0.1.0/hash/node_modules/@shllg/emend",
  linked: "mise/linked-installs/npm-shllg-emend/dev",
  checkout: "checkout/apps/emend",
};
async function fixture(layout: string, manifest: unknown = { name: "@shllg/emend" }, link = true) {
  const root = await mkdtemp(join(process.env.EMEND_HOME as string, "detect-"));
  const folder = join(root, layout);
  const entry = join(folder, "dist/emend.mjs");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "");
  await writeFile(join(folder, "package.json"), JSON.stringify(manifest));
  if (link && layout.endsWith("lib/node_modules/@shllg/emend")) {
    const prefix = folder.slice(0, -"/lib/node_modules/@shllg/emend".length);
    await mkdir(join(prefix, "bin"), { recursive: true });
    await mkdir(join(folder, "bin"));
    await writeFile(join(folder, "bin/emend"), "");
    await symlink(join(folder, "bin/emend"), join(prefix, "bin/emend"));
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
    const f = await fixture(layout, { name: "@shllg/emend", emendLocalBuild: "abc123" });
    expect(await detectInstall(f.entry)).toEqual({ kind: "local", where: "marked" });
  });
  test.each([
    layouts.pnpm10,
    layouts.pnpm11,
    "project/node_modules/.pnpm/x/node_modules/@shllg/emend",
    "pnpm/dlx/x/node_modules/@shllg/emend",
  ])("refuses unconfirmed pnpm copy %s", async (layout) => {
    const f = await fixture(layout);
    expect(await detectInstall(f.entry, async () => false)).toEqual({ kind: "unknown" });
  });
  test("npm requires its bin/emend to resolve to this package's launcher", async () => {
    const f = await fixture(layouts.npm, undefined, false);
    expect(await detectInstall(f.entry)).toEqual({ kind: "unknown" });
    const bin = join(f.root, "prefix/bin");
    await mkdir(bin);
    await writeFile(join(bin, "emend"), "foreign");
    expect(await detectInstall(f.entry)).toEqual({ kind: "unknown" });
  });
  test("npm refuses a launcher whose real target is outside its package", async () => {
    const f = await fixture(layouts.npm);
    const launcher = join(f.folder, "bin/emend");
    await rm(launcher);
    await writeFile(join(f.root, "foreign-launcher"), "");
    await symlink(join(f.root, "foreign-launcher"), launcher);
    expect(await detectInstall(f.entry)).toEqual({ kind: "unknown" });
  });
  test.each([{ name: "@shllg/emend-evil" }, {}, { name: "@shllg/emend", emendLocalBuild: 1 }])(
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
    "m/npm-shllg-emend/installs/0.1.0/lib/node_modules/@shllg/emend",
    "m/installs/npm-shllg-emend/lib/node_modules/@shllg/emend",
    "prefix/lib/node_modules/@shllg/emend-evil",
    "prefix/lib/node_modules/@shllg-evil/emend",
    "prefix/lib/node_modules/@shllg/emend/node_modules/@shllg/emend",
    "prefix/node_modules/@shllg/emend",
    "prefix/lib/x/node_modules/@shllg/emend",
    "m/installs/npm-shllg-emend/0.1.0/extra/lib/node_modules/@shllg/emend",
    "pnpm-x/node_modules/@shllg/emend",
  ])("refuses near miss %s", async (layout) => {
    const f = await fixture(layout);
    expect(await detectInstall(f.entry)).toEqual({ kind: "unknown" });
  });
  test.each([
    "relative/dist/emend.mjs",
    "/m/installs/x/npm-shllg-emend",
    "/usr/local/lib/node_modules/@shllg/emend/dist/other.mjs",
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
      "@shllg/emend@latest",
    ]);
    expect(updateArgs({ kind: "pnpm" })).toEqual([
      "add",
      "--global",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "@shllg/emend@latest",
    ]);
    for (const install of [npm, { kind: "pnpm" } as const])
      expect(restoreArgs(install, "0.1.0")).toEqual(updateArgs(install).map((arg) => arg.replace("@latest", "@0.1.0")));
    expect(updateArgs({ kind: "mise" })).toEqual(["upgrade", "--bump", "npm:@shllg/emend"]);
    expect(restoreArgs({ kind: "mise" }, "0.1.0")).toEqual(["use", "--global", "npm:@shllg/emend@0.1.0"]);
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
    expect(locateArgs({ kind: "mise" })).toEqual(["where", "npm:@shllg/emend"]);
  });
});
