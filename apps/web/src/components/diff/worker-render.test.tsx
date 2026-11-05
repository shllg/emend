import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import { cleanup, render, waitFor } from "@testing-library/react";
import { build } from "vite";
import { expect, test } from "vitest";
import { diffBuildPruning } from "../../../diff-build.ts";
import { DiffView, DiffWorkers } from "./FileDiff.tsx";
import { parsePair } from "./parse.worker.ts";
import { diffTheme } from "./theme.ts";

test("built JS worker highlights TypeScript and a language loaded late without its own registries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-diff-worker-"));
  const workers: NodeWorker[] = [];
  const requests: {
    type: string;
    preferredHighlighter?: string;
    resolvedLanguages?: { name: string }[];
    resolvedThemes?: { name: string }[];
  }[] = [];
  const responses: { type: string; requestType?: string; error?: string }[] = [];
  const failures: unknown[] = [];
  try {
    const built = await build({
      configFile: false,
      root: resolve(import.meta.dirname, "../../.."),
      plugins: [diffBuildPruning(true)],
      logLevel: "silent",
      build: {
        outDir: dir,
        emptyOutDir: false,
        lib: {
          entry: resolve(import.meta.dirname, "../../../node_modules/@pierre/diffs/dist/worker/worker.js"),
          formats: ["es"],
          fileName: "worker",
        },
      },
    });
    const result = Array.isArray(built) ? built[0] : built;
    if (!result || !("output" in result)) throw new Error("Expected worker output");
    const entry = result.output.find((file) => file.type === "chunk" && file.isEntry);
    if (!entry) throw new Error("Missing worker entry");
    const modules = result.output.flatMap((file) => (file.type === "chunk" ? Object.keys(file.modules) : []));
    expect(modules.filter((id) => /@shikijs\/(langs|themes)\//.test(id))).toEqual([]);
    expect(result.output.filter((file) => /wasm|oniguruma/.test(file.fileName))).toEqual([]);
    const shim = join(dir, "bridge.mjs");
    await writeFile(
      shim,
      `import {parentPort} from "node:worker_threads";
      globalThis.self=globalThis;
      globalThis.postMessage=(data,transfer)=>parentPort.postMessage(data,transfer);
      globalThis.addEventListener=(type,callback)=>{if(type==="message") parentPort.on("message",data=>callback({data}));};
      await import(${JSON.stringify(pathToFileURL(join(dir, entry.fileName)).href)});
      parentPort.postMessage({type:"bridge-ready"});`,
      { mode: 0o644 },
    );
    const factory = (): Worker => {
      const node = new NodeWorker(pathToFileURL(shim));
      workers.push(node);
      let ready = false;
      const queued: unknown[] = [];
      const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
      const dispatch = (type: string, event: Event) => {
        for (const listener of listeners.get(type) ?? [])
          typeof listener === "function" ? listener(event) : listener.handleEvent(event);
      };
      node.on("message", (data) => {
        if (data.type === "bridge-ready") {
          ready = true;
          for (const request of queued) node.postMessage(request);
          queued.length = 0;
        } else {
          responses.push(data);
          dispatch("message", new MessageEvent("message", { data }));
        }
      });
      node.on("error", (error) => {
        failures.push(error);
        dispatch("error", new Event("error"));
      });
      return {
        postMessage(data: (typeof requests)[number]) {
          requests.push(data);
          if (ready) node.postMessage(data);
          else queued.push(data);
        },
        terminate() {
          void node.terminate();
        },
        addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          const list = listeners.get(type) ?? new Set();
          list.add(listener);
          listeners.set(type, list);
        },
        removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          listeners.get(type)?.delete(listener);
        },
      } as unknown as Worker;
    };
    const ts = parsePair({
      oldFile: null,
      newFile: { name: "sample.ts", contents: "const answer: number = 42;\n", cacheKey: "ts" },
    });
    const view = render(
      <DiffWorkers workerFactory={factory}>
        <DiffView fileDiff={ts} diffStyle="split" annotations={[]} selected={null} onSelect={() => {}} />
      </DiffWorkers>,
    );
    await waitFor(() =>
      expect(responses.some((response) => response.type === "success" && response.requestType === "diff")).toBe(true),
    );
    await waitFor(() =>
      expect(
        view.container.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line] span[style]"),
      ).toBeTruthy(),
    );
    const initialResponses = responses.length;
    const late = parsePair({
      oldFile: null,
      newFile: { name: "late.py", contents: 'def greet(name):\n    return "hello " + name\n', cacheKey: "python" },
    });
    view.rerender(
      <DiffWorkers workerFactory={factory}>
        <DiffView fileDiff={late} diffStyle="unified" annotations={[]} selected={null} onSelect={() => {}} />
      </DiffWorkers>,
    );
    await waitFor(() =>
      expect(
        responses
          .slice(initialResponses)
          .some((response) => response.type === "success" && response.requestType === "diff"),
      ).toBe(true),
    );
    await waitFor(() => {
      const shadow = view.container.querySelector("diffs-container")?.shadowRoot;
      const lines = [...(shadow?.querySelectorAll("[data-line]") ?? [])];
      expect(lines.map((line) => line.textContent).join("\n")).toContain("def greet(name):");
      expect(lines.map((line) => line.textContent).join("\n")).not.toContain("const answer");
      expect(
        [...(shadow?.querySelectorAll("[data-line] span[style]") ?? [])].some(
          (span) => span.textContent?.trim() === "def",
        ),
      ).toBe(true);
    });
    expect(
      requests.some((request) => request.resolvedLanguages?.some((language) => language.name === "typescript")),
    ).toBe(true);
    expect(requests.some((request) => request.resolvedLanguages?.some((language) => language.name === "python"))).toBe(
      true,
    );
    expect(
      requests.some(
        (request) =>
          request.type === "initialize" &&
          request.preferredHighlighter === "shiki-js" &&
          request.resolvedThemes?.length === 1 &&
          request.resolvedThemes[0]?.name === diffTheme.name,
      ),
    ).toBe(true);
    expect(JSON.stringify(requests.flatMap((request) => request.resolvedThemes ?? []))).toContain("--syn-keyword");
    expect(responses.filter((response) => response.type === "error")).toEqual([]);
    expect(failures).toEqual([]);
    expect((await readFile(join(dir, entry.fileName), "utf8")).length).toBeGreaterThan(0);
  } finally {
    cleanup();
    await Promise.all(workers.map((worker) => worker.terminate()));
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
