import { cp, readFile, rm } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { copySkills } from "./src/build/skill-copy-filter.ts";

await build({
  entryPoints: {
    emend: fileURLToPath(new URL("./src/cli.ts", import.meta.url)),
    "publish-worker": fileURLToPath(new URL("./src/server/publish/worker.ts", import.meta.url)),
  },
  outdir: fileURLToPath(new URL("./dist", import.meta.url)),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["node:*"],
});

for (const entry of ["emend", "publish-worker"]) {
  const output = await readFile(new URL(`./dist/${entry}.mjs`, import.meta.url), "utf8");
  // Prefix of @shikijs/engine-oniguruma's embedded WASM module (not a generic WASM marker).
  if (output.includes("AGFzbQEAAAABoQEWYAJ/fwF/YAF/AX9gA39/fwF/") || output.includes("onig.wasm"))
    throw new Error("The CLI must use Shiki's JavaScript engine only");
}

const webOutput = new URL("./dist/web", import.meta.url);
await rm(webOutput, { recursive: true, force: true });
await cp(new URL("../web/dist", import.meta.url), webOutput, {
  recursive: true,
  filter: (source) => basename(source) !== ".vite",
});

await copySkills(
  fileURLToPath(new URL("../../", import.meta.url)),
  fileURLToPath(new URL("./dist/skills", import.meta.url)),
);
