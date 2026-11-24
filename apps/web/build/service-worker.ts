import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import { shouldPrecacheAsset } from "../src/lib/built-in-fonts.ts";

export function serviceWorker(): Plugin {
  return {
    name: "recense-service-worker",
    apply: "build",
    generateBundle: {
      order: "post",
      async handler(_options, bundle) {
        const files = Object.values(bundle).sort((a, b) => a.fileName.localeCompare(b.fileName));
        const shell = [
          "/",
          "/index.html",
          "/theme-boot.js",
          "/manifest.webmanifest",
          "/icons/icon-192.png",
          "/icons/icon-512.png",
          "/icons/apple-touch-icon.png",
          ...files
            .filter((file) => file.fileName.startsWith("assets/") && shouldPrecacheAsset(file.fileName))
            .map((file) => `/${file.fileName}`),
        ];
        const hash = createHash("sha256");
        for (const file of files) hash.update(file.fileName).update(file.type === "chunk" ? file.code : file.source);
        for (const path of [
          "src/sw.ts",
          "src/sw-routing.ts",
          "public/theme-boot.js",
          "public/manifest.webmanifest",
          "public/icons/icon-192.png",
          "public/icons/icon-512.png",
          "public/icons/apple-touch-icon.png",
        ])
          hash.update(await readFile(new URL(`../${path}`, import.meta.url)));
        const result = await build({
          configFile: false,
          logLevel: "silent",
          define: {
            __RECENSE_SHELL__: JSON.stringify(shell),
            __RECENSE_BUILD_ID__: JSON.stringify(hash.digest("hex").slice(0, 16)),
          },
          build: {
            write: false,
            minify: true,
            lib: {
              entry: fileURLToPath(new URL("../src/sw.ts", import.meta.url)),
              name: "RecenseServiceWorker",
              formats: ["iife"],
            },
            rolldownOptions: { output: { codeSplitting: false } },
          },
        });
        const output = Array.isArray(result) ? result[0] : result;
        if (!output || !("output" in output)) throw new Error("The service worker was not generated.");
        const worker = output.output.find((file) => file.type === "chunk" && file.isEntry);
        if (worker?.type !== "chunk") throw new Error("The service worker entry was not generated.");
        this.emitFile({ type: "asset", fileName: "sw.js", source: worker.code });
      },
    },
  };
}
