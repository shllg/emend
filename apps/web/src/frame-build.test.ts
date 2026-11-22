// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants, runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { build } from "vite";
import { expect, onTestFinished, test, vi } from "vitest";
import { statechartClassColors } from "./components/reading/mermaid-classes.ts";
import { BUILT_IN_FONTS } from "./lib/built-in-fonts.ts";

// The real web build and Mermaid renders under a code-generation ban are the subject.
test("built frame rejects diagram theme overrides without dynamic code generation", async () => {
  const workerModules = new Map<string, string[]>();
  const result = await build({
    root: fileURLToPath(new URL("../", import.meta.url)),
    logLevel: "silent",
    build: { write: false },
    plugins: [
      {
        name: "audit-emitted-worker-modules",
        config(config) {
          const original = config.worker?.plugins;
          config.worker = {
            ...config.worker,
            plugins: () => [
              ...(original?.() ?? []),
              {
                name: "capture-worker-modules",
                generateBundle(_options, bundle) {
                  for (const file of Object.values(bundle)) {
                    if (file.type === "chunk") workerModules.set(file.fileName, Object.keys(file.modules));
                  }
                },
              },
            ],
          };
        },
      },
    ],
  });
  if (Array.isArray(result) || !("output" in result)) throw new Error("Expected a single web build");
  const serviceWorker = result.output.find((file) => file.fileName === "sw.js");
  if (serviceWorker?.type !== "asset") throw new Error("Missing service worker");
  const handlers = new Map<string, (event: unknown) => void>();
  const addAll = vi.fn(async (_urls: string[]) => {});
  const respondWith = vi.fn();
  const skipWaiting = vi.fn(async () => {});
  runInNewContext(String(serviceWorker.source), {
    URL,
    skipWaiting,
    location: { origin: "https://hub.example.ts.net" },
    caches: { open: async () => ({ addAll }) },
    addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
  });
  let installed: Promise<unknown> | undefined;
  handlers.get("install")?.({
    waitUntil: (pending: Promise<unknown>) => {
      installed = pending;
    },
  });
  await installed;
  const shell = addAll.mock.calls[0]?.[0] ?? [];
  expect(shell).toEqual(
    expect.arrayContaining([
      "/",
      "/index.html",
      "/manifest.webmanifest",
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/apple-touch-icon.png",
    ]),
  );
  const assets = result.output.filter((file) => file.fileName.startsWith("assets/")).map((file) => `/${file.fileName}`);
  const defaultFontAssets: string[] = [];
  for (const font of BUILT_IN_FONTS) {
    const emitted = assets.filter((path) => path.startsWith(`/assets/${font.slug}-latin-`) && path.endsWith(".woff2"));
    expect(emitted.length, font.family).toBeGreaterThan(0);
    if (font.default) {
      expect(emitted, font.family).toHaveLength(3);
      defaultFontAssets.push(...emitted);
    }
    for (const path of emitted) expect(shell.includes(path), path).toBe(font.default);
  }
  expect(defaultFontAssets).toHaveLength(6);
  expect(shell.filter((path) => path.startsWith("/assets/")).sort()).toEqual(
    assets.filter((path) => !path.endsWith(".woff2") || defaultFontAssets.includes(path)).sort(),
  );
  for (const path of ["/api/v1/devices", "/content/key/doc.html", "/other"])
    handlers.get("fetch")?.({
      request: { url: `https://hub.example.ts.net${path}`, method: "GET", mode: "navigate" },
      respondWith,
    });
  expect(respondWith).not.toHaveBeenCalled();
  // Installing never skips waiting; only the exact message does.
  expect(skipWaiting).not.toHaveBeenCalled();
  for (const data of [
    undefined,
    null,
    "SKIP_WAITING",
    ["SKIP_WAITING"],
    {},
    { type: "skip_waiting" },
    { type: "OTHER" },
    { type: { type: "SKIP_WAITING" } },
    { data: { type: "SKIP_WAITING" } },
    { type: "SKIP_WAITING", extra: true },
  ])
    handlers.get("message")?.({ data });
  expect(skipWaiting).not.toHaveBeenCalled();
  handlers.get("message")?.({ data: { type: "SKIP_WAITING" } });
  expect(skipWaiting).toHaveBeenCalledTimes(1);
  expect(workerModules.size).toBeGreaterThan(0);
  expect([...workerModules.keys()].some((name) => /\/worker-/.test(name))).toBe(true);
  for (const [name, modules] of workerModules) {
    // Vite wraps nested worker output in assets, losing module metadata here.
    expect(result.output.some((file) => file.fileName === name)).toBe(true);
    expect(
      modules.filter((id) =>
        /\/(?:@shikijs\/(?:langs|themes)\/|shiki\/dist\/(?:langs|themes)|@pierre\/theming\/(?:dist\/)?themes)/.test(id),
      ),
    ).toEqual([]);
  }
  const stubs = result.output.filter((file) => file.fileName.includes("unused-diff-backend-"));
  expect(stubs.length).toBeGreaterThan(0);
  expect(
    stubs.some(
      (file) => file.type === "chunk" && Object.keys(file.modules).some((id) => id.endsWith("/unused-diff-backend.ts")),
    ),
  ).toBe(true);
  const workerStubs = [...workerModules].filter(([, modules]) =>
    modules.some((id) => id.endsWith("/unused-diff-backend.ts")),
  );
  expect(workerStubs.length).toBeGreaterThan(0);
  for (const [name] of workerStubs) expect(stubs.some((file) => file.fileName === name)).toBe(true);
  // Identical main/worker copies may share a filename after Vite deduplicates them.
  const directory = await mkdtemp(join(tmpdir(), "emend-built-stubs-"));
  try {
    for (const [index, stub] of stubs.entries()) {
      const path = join(directory, `stub-${index}.mjs`);
      await writeFile(path, stub.type === "chunk" ? stub.code : stub.source);
      // Use Node's native loader: the test runner's module transform can repair invalid exports.
      const imported = runInNewContext(
        "import(url)",
        { url: pathToFileURL(path).href },
        {
          importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        },
      );
      await expect.soft(imported).rejects.toThrow("This diff backend is disabled. emend uses shiki-js.");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const index = result.output.find((file) => file.fileName === "index.html");
  if (index?.type !== "asset") throw new Error("Missing app HTML");
  const initial = [...String(index.source).matchAll(/(?:src|href)="\/(assets\/[^" ]+\.js)"/g)].map((match) => match[1]);
  expect(initial.length).toBeGreaterThan(0);
  const visited = new Set<string>();
  const visit = (name: string | undefined) => {
    if (!name || visited.has(name)) return;
    visited.add(name);
    const chunk = result.output.find((file) => file.fileName === name);
    if (chunk?.type !== "chunk") throw new Error(`Missing entry chunk ${name}`);
    expect(
      Object.keys(chunk.modules).filter((id) =>
        /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:shiki|@shikijs|diff|@pierre)\//.test(id),
      ),
    ).toEqual([]);
    for (const dependency of chunk.imports) visit(dependency);
  };
  initial.forEach(visit);
  expect(
    result.output.some(
      (file) => file.type === "chunk" && Object.keys(file.modules).some((id) => id.includes("@pierre/diffs")),
    ),
  ).toBe(true);
  // The WebAssembly text grammar is still a supported language, not a WASM engine.
  const wasmGrammar = result.output.find(
    (file) =>
      file.type === "chunk" &&
      Object.keys(file.modules).length > 0 &&
      Object.keys(file.modules).every((id) => /\/(?:@shikijs\/langs|shiki)\/dist\/(?:langs\/)?wasm\.mjs$/.test(id)),
  );
  expect(wasmGrammar).toBeDefined();
  expect(
    result.output
      .filter((file) => file !== wasmGrammar && /(?:wasm|oniguruma)/i.test(file.fileName))
      .map((file) => file.fileName),
  ).toEqual([]);
  for (const file of result.output) {
    if (file.type !== "chunk") continue;
    expect(
      Object.keys(file.modules).filter((id) =>
        /\/(?:@shikijs\/engine-oniguruma|@pierre\/highlights)\/|\/shiki\/dist\/wasm\.mjs$/.test(id),
      ),
    ).toEqual([]);
  }
  const frame = result.output.find((file) => file.fileName === "mermaid-frame.html");
  if (frame?.type !== "asset") throw new Error("Missing frame HTML");
  const html = String(frame.source);
  expect(html).not.toContain('type="module"');
  expect(html).not.toContain("crossorigin");
  const script = /<script src="\/(assets\/mermaid-frame-[\w-]+\.js)"><\/script>/.exec(html)?.[1];
  expect(script).toBeDefined();
  const asset = result.output.find((file) => file.fileName === script);
  if (asset?.type !== "asset") throw new Error("Missing classic frame script");
  const code = String(asset.source);
  expect(code).toContain("This diagram is too large to draw.");
  expect(code).not.toMatch(/\bimport\s*\(/);
  for (const file of result.output) {
    if (file.type === "chunk") expect(file.code).not.toContain("maxTextSize");
  }
  const window = new Window();
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  onTestFinished(() => window.happyDOM.close());
  // Happy DOM's base Node getter returns an empty name. DOMPurify uses that
  // native getter directly; delegate to the concrete node's getter as browsers do.
  const nodeName = Object.getOwnPropertyDescriptor(window.Node.prototype, "nodeName")?.get;
  if (!nodeName) throw new Error("Missing nodeName getter");
  vi.spyOn(window.Node.prototype, "nodeName", "get").mockImplementation(function (
    this: InstanceType<typeof window.Node>,
  ) {
    for (
      let prototype = Object.getPrototypeOf(this);
      prototype && prototype !== window.Node.prototype;
      prototype = Object.getPrototypeOf(prototype)
    ) {
      const getter = Object.getOwnPropertyDescriptor(prototype, "nodeName")?.get;
      if (getter) return getter.call(this);
    }
    return nodeName.call(this);
  });
  // Happy DOM's HTML parser loses SVG children when they contain a style tag.
  // Parse Mermaid's SVG as XML and retain it in an HTML document for DOMPurify.
  const parse = window.DOMParser.prototype.parseFromString;
  vi.spyOn(window.DOMParser.prototype, "parseFromString").mockImplementation(function (
    this: InstanceType<typeof window.DOMParser>,
    source,
    type,
  ) {
    if (type === "text/html" && source.startsWith("<svg")) {
      const xml = parse.call(this, source, "image/svg+xml");
      const html = parse.call(this, "", "text/html");
      html.body.append(html.importNode(xml.documentElement, true));
      return html;
    }
    return parse.call(this, source, type);
  });
  const root = window.document.createElement("div");
  window.document.body.append(root);
  // Supply SVG layout measurements for the synthetic window.
  Object.defineProperty(window.SVGElement.prototype, "getBBox", {
    value: () => ({ x: 0, y: 0, width: 80, height: 20 }),
  });
  vi.spyOn(window.SVGGraphicsElement.prototype, "getBBox").mockImplementation(() => new window.DOMRect(0, 0, 80, 20));
  Object.defineProperty(window.SVGElement.prototype, "getComputedTextLength", { value: () => 80 });
  const sandbox: Record<string, unknown> = {};
  // Keep the VM Array constructor: ELK uses instanceof Array when
  // importing graph children. Happy DOM's foreign constructor drops those nodes.
  for (const name of Object.getOwnPropertyNames(window)) {
    if (!["Array", "Function", "eval", "globalThis"].includes(name)) sandbox[name] = Reflect.get(window, name);
  }
  sandbox.window = window;
  sandbox.self = window;
  runInNewContext(code, sandbox, { contextCodeGeneration: { strings: false, wasm: false } });
  const bridge = Reflect.get(sandbox, "EmendMermaidFrame") as { startFrame: (root: unknown) => () => void };
  const stop = bridge.startFrame(root);
  onTestFinished(stop);
  for (const source of [
    'graph TD\n A\n click A evil "click"',
    '%%{init: {"themeCSS": ".probeThemeInit { fill: rgb(1, 2, 3); }"}}%%\nflowchart LR\nA',
    '---\nconfig:\n  themeCSS: ".probeThemeInit { fill: rgb(1, 2, 3); }"\n---\nflowchart LR\nA',
    '%%{initialize: {"themeCSS": ".probeThemeInitialize { fill: rgb(1, 2, 3); }"}}%%\nflowchart LR\nA',
    '%%{init: {"fontFamily": "x; .probeFontInit{fill:rgb(7,8,9)}"}}%%\nflowchart LR\n  F01a --> F01b',
    '---\nconfig:\n  fontFamily: "x; .probeFontFm{fill:rgb(7,8,9)}"\n---\nflowchart LR\n  F01a --> F01b',
    "flowchart LR\n C01a --> C01b\n classDef synthetic fill:#123456,stroke:#654321;\n class C01a synthetic;\n style C01b fill:#abcdef,stroke:#fedcba;",
    `stateDiagram-v2
  [*] --> S01a
  S01a --> S01b
  S01b --> S01c
  state S01c {
    [*] --> S01d
  }
  S01c --> S01e
  classDef teal fill:#ffd6e7,stroke:#a3004f,color:#4a0020
  class S01a blue
  class S01b teal
  class S01b bugPath
  class S01c purple
  class S01e teal`,
    `flowchart LR
  D01a[Command line] --> D01b[Search cache]
  D01a --> D01c[Review store]
  D01a -.->|removed| D01d[Poller]
  class D01b added
  class D01c changed
  class D01d removed
  subgraph Legend
    direction LR
    L01a[Added]:::added ~~~ L01b[Changed]:::changed ~~~ L01c[Removed]:::removed
  end`,
    // Hand-drawn diagrams cannot render in happy-dom; mermaid-classes.test.ts checks emend's rules skip them.
    "flowchart LR\n  subgraph G01 [G01]\n    G01a --> G01b\n  end\n  G01 --> G01c\n  class G01 teal\n  class G01b breaks",
    '%%{init: {"themeVariables": {"fontSize": ["16px;} text{fill:rgb(7,8,9) !important} .z{color:x"]}}}%%\nflowchart LR\n  B05a --> B05b',
    '%%{initialize: {"themeVariables": {"fontSize": ["16px;} text{fill:rgb(7,8,9) !important} .z{color:x"]}}}%%\nflowchart LR\n  B05a --> B05b',
    '---\nconfig:\n  themeVariables:\n    fontSize: ["16px;} text{fill:rgb(7,8,9) !important} .z{color:x"]\n---\nflowchart LR\n  B05a --> B05b',
  ]) {
    root.replaceChildren();
    const rendered = Promise.withResolvers<void>();
    const observer = new window.MutationObserver(() => {
      if (root.firstElementChild?.localName === "svg" || root.firstElementChild?.localName === "p") rendered.resolve();
    });
    observer.observe(root, { childList: true });
    // A render that never happens ends the test by timeout without unwinding; onTestFinished still runs.
    onTestFinished(() => observer.disconnect());
    window.dispatchEvent(
      new window.MessageEvent("message", { source: window.parent, data: { type: "render", source } }),
    );
    await rendered.promise;
    expect(root.firstElementChild?.localName, root.textContent).toBe("svg");
    observer.disconnect();
    expect(root.querySelector("script, foreignObject, [onclick], [href], [onload]")).toBeNull();
    const nodes = /([FBC]\d+a) --> ([FBC]\d+b)/.exec(source);
    if (nodes) {
      expect(root.textContent).toContain(nodes[1]);
      expect(root.textContent).toContain(nodes[2]);
      const edge = root.querySelector("path[data-edge]")?.getAttribute("d");
      expect(edge).toBeTruthy();
      expect(edge).not.toContain("NaN");
    }
    if (source.includes("classDef synthetic")) {
      expect(root.querySelector(".node.synthetic rect")?.getAttribute("style")).toMatch(/fill:\s*#123456/);
      const styled = [...root.querySelectorAll(".node")].find((node) => node.textContent.includes("C01b"));
      expect(styled?.querySelector("rect")?.getAttribute("style")).toMatch(/fill:\s*#abcdef/);
    }
    const styles = [...root.querySelectorAll("svg style")];
    expect(styles.length).toBeGreaterThan(0);
    const css = styles.map((style) => style.textContent).join("\n");
    if (source.includes("class S01c purple")) {
      const blue = root.querySelector("g.node.blue");
      if (!blue) throw new Error("Missing blue state");
      expect(blue.textContent).toContain("S01a");
      expect(blue.matches(".node.blue:not([data-look=handDrawn])")).toBe(true);
      expect(root.querySelector("g.node.teal.bugPath")?.textContent).toContain("S01b");
      const parent = root.querySelector("g.statediagram-cluster.purple");
      const stateNodes = [...root.querySelectorAll("g.node")];
      const child = stateNodes.find((node) => node.textContent.includes("S01d"));
      if (!parent || !child) throw new Error("Missing composite state or its child");
      expect(parent.matches(".statediagram-cluster.purple:not([data-look=handDrawn])")).toBe(true);
      expect(parent.contains(child)).toBe(false);
      const own = stateNodes.find((node) => node.textContent.includes("S01e"));
      expect(own?.querySelector("rect, path")?.getAttribute("style")).toMatch(/fill:\s*#ffd6e7/);

      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const colors = statechartClassColors(dark, dark ? "#111213" : "#fdfdfe", dark ? "#f4f4f6" : "#111213");
      const blueFill = colors.find((color) => color.name === "blue")?.fill;
      expect(blueFill).toBeDefined();
      expect(css).toMatch(
        new RegExp(
          `\\.node\\.blue:not\\(\\[data-look=handDrawn\\]\\)\\s+rect\\b[^{}]*\\{[^{}]*\\bfill\\s*:\\s*${blueFill}\\s*(?:;|\\})`,
        ),
      );
      expect(css).toMatch(/\.statediagram-cluster\.purple:not\(\[data-look=handDrawn\]\)\s+rect\.inner\b/);

      // Scoped selectors distinguish emend's defaults from Mermaid's classDef rules.
      const names = colors.map((color) => color.name).join("|");
      const defaults = new RegExp(`\\.(?:node|cluster|statediagram-cluster)\\.(?:${names})\\b`);
      for (const [, selectors = "", declarations = ""] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (defaults.test(selectors)) expect(declarations).not.toContain("!important");
      }
      const tealDefault = css.search(/\.node\.teal:not\(\[data-look=handDrawn\]\)\s+rect\b/);
      const tealClassDef = /(?:^|\s)\.teal\s+rect\s*\{[^{}]*\bfill\s*:\s*#ffd6e7\s*!important\b[^{}]*\}/.exec(css);
      expect(tealDefault).toBeGreaterThanOrEqual(0);
      expect(tealClassDef?.index).toBeGreaterThan(tealDefault);
    }
    if (source.includes("class D01b added")) {
      const legend = [...root.querySelectorAll("g.cluster")].find((cluster) => cluster.textContent.includes("Legend"));
      expect(legend).toBeDefined();
      // Mermaid draws cluster shapes and their nodes in separate SVG groups.
      for (const [name, label, legendLabel] of [
        ["added", "Search cache", "Added"],
        ["changed", "Review store", "Changed"],
        ["removed", "Poller", "Removed"],
      ] as const) {
        const nodes = [...root.querySelectorAll(`g.node.${name}`)];
        expect(nodes.find((node) => node.textContent.includes(label))?.textContent).toContain(label);
        expect(nodes.find((node) => node.textContent.includes(legendLabel))?.textContent).toContain(legendLabel);
      }
      expect(css).toMatch(
        /\.node\.removed:not\(\[data-look=handDrawn\]\)\s+rect\b[^{}]*\{[^{}]*\bstroke-dasharray\s*:\s*5 3\s*(?:;|\})/,
      );
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const colors = statechartClassColors(dark, dark ? "#111213" : "#fdfdfe", dark ? "#f4f4f6" : "#111213");
      const addedFill = colors.find((color) => color.name === "added")?.fill;
      expect(addedFill).toBeDefined();
      expect(css).toMatch(
        new RegExp(
          `\\.node\\.added:not\\(\\[data-look=handDrawn\\]\\)\\s+rect\\b[^{}]*\\{[^{}]*\\bfill\\s*:\\s*${addedFill}\\s*(?:;|\\})`,
        ),
      );
    }
    if (source.includes("class G01 teal")) {
      const cluster = root.querySelector("g.cluster.teal");
      const node = [...root.querySelectorAll("g.node")].find((node) => node.textContent.includes("G01b"));
      if (!cluster || !node) throw new Error("Missing classic subgraph or its child");
      expect(cluster.querySelector("rect")).not.toBeNull();
      expect(cluster.getAttribute("data-look")).not.toBe("handDrawn");
      expect(cluster.matches(".cluster.teal:not([data-look=handDrawn])")).toBe(true);
      expect(node.matches("g.node.breaks")).toBe(true);
      expect(cluster.contains(node)).toBe(false);
      expect(css).toMatch(/\.cluster\.teal:not\(\[data-look=handDrawn\]\)\s+rect\b/);
    }
    for (const style of styles) {
      expect
        .soft(style.textContent.match(/\.probe(?:ThemeInit|ThemeInitialize|FontInit|FontFm)\b/g) ?? [], source)
        .toEqual([]);
      expect
        .soft(style.textContent.match(/text\s*\{\s*fill:\s*rgb\(7,\s*8,\s*9\)\s*!important\s*;?\s*\}/g) ?? [], source)
        .toEqual([]);
    }
  }
}, 30000);
