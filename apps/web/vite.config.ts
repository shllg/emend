import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, defineConfig, type Plugin } from "vite";
import { checkPubStylesheet, pickPubStylesheet } from "./build/pub-frame.ts";
import { serviceWorker } from "./build/service-worker.ts";
import { diffBuildPruning } from "./diff-build.ts";

// A sandbox with an opaque origin cannot fetch ESM without CORS permission.
// Bundle this HTML entry's script as one classic asset so the exact frame CSP
// works without widening any response headers or sharing app-origin modules.
function mermaidFrame(): Plugin {
  let asset: string;
  return {
    name: "mermaid-frame",
    apply: "build",
    async buildStart() {
      const result = await build({
        configFile: false,
        root: fileURLToPath(new URL(".", import.meta.url)),
        logLevel: "silent",
        build: {
          write: false,
          minify: true,
          lib: {
            entry: fileURLToPath(new URL("./mermaid-frame.ts", import.meta.url)),
            name: "EmendMermaidFrame",
            formats: ["iife"],
          },
          rolldownOptions: { output: { codeSplitting: false } },
        },
      });
      const output = Array.isArray(result) ? result[0] : result;
      if (!output || !("output" in output)) throw new Error("The diagram bundle was not generated.");
      const chunk = output.output.find((file) => file.type === "chunk" && file.isEntry);
      if (chunk?.type !== "chunk") throw new Error("The diagram entry was not generated.");
      asset = this.emitFile({ type: "asset", name: "mermaid-frame.js", source: chunk.code });
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const html = bundle["mermaid-frame.html"];
        if (html?.type !== "asset") throw new Error("The diagram page was not generated.");
        html.source = String(html.source).replace(
          "<!--frame-script-->",
          `<script src="/${this.getFileName(asset)}"></script>`,
        );
      },
    },
  };
}

function pubFrame(): Plugin {
  return {
    name: "pub-frame",
    apply: "build",
    async buildStart() {
      const result = await build({
        configFile: false,
        root: fileURLToPath(new URL(".", import.meta.url)),
        publicDir: false,
        logLevel: "silent",
        build: {
          write: false,
          minify: true,
          cssMinify: true,
          assetsInlineLimit: () => true,
          rolldownOptions: { input: fileURLToPath(new URL("./pub-frame.css", import.meta.url)) },
        },
      });
      const output = Array.isArray(result) ? result[0] : result;
      if (!output || !("output" in output)) throw new Error("The pub stylesheet was not generated.");
      const css = pickPubStylesheet(output.output);
      checkPubStylesheet(css);
      this.emitFile({ type: "asset", fileName: "pub-frame.css", source: css });
    },
  };
}

const emendPackage: { version: string } = JSON.parse(
  readFileSync(fileURLToPath(new URL("../emend/package.json", import.meta.url)), "utf8"),
);

export default defineConfig({
  define: { __EMEND_VERSION__: JSON.stringify(emendPackage.version) },
  plugins: [react(), tailwindcss(), mermaidFrame(), pubFrame(), diffBuildPruning(), serviceWorker()],
  worker: { format: "es", plugins: () => [diffBuildPruning(true)] },
  build: {
    rolldownOptions: {
      input: {
        app: fileURLToPath(new URL("./index.html", import.meta.url)),
        mermaid: fileURLToPath(new URL("./mermaid-frame.html", import.meta.url)),
      },
    },
  },
});
