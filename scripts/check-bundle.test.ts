import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { type Budgets, checkBundles, measureBundles } from "./check-bundle.ts";

test("static closure deduplicates shared chunks and excludes dynamic imports and CSS", (t) => {
  const dist = mkdtempSync(join(tmpdir(), "emend-bundle-test-"));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  const files = {
    "entry.js": "export const entry = 1;",
    "app.js": "export const app = 2;",
    "shared.js": "export const shared = 3;",
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dist, name), content);
  const expected = Object.values(files).reduce((sum, file) => sum + gzipSync(file, { level: 9 }).length, 0);
  const manifest = {
    entry: { file: "entry.js", imports: ["shared", "css"], dynamicImports: ["absent"] },
    app: { file: "app.js", imports: ["shared"] },
    shared: { file: "shared.js", imports: ["entry"] },
    css: { file: "style.css" },
  };
  const sizes = measureBundles(dist, manifest, { inbox: { roots: ["entry", "app"], gzipBytes: expected } });
  assert.equal(sizes[0].gzipBytes, expected);
  assert.match(checkBundles(sizes), new RegExp(`inbox ${expected}/${expected}`));
  assert.throws(
    () => checkBundles(measureBundles(dist, manifest, { inbox: { roots: ["entry", "app"], gzipBytes: expected - 1 } })),
    new RegExp(`inbox: ${expected} gzip bytes exceeds budget ${expected - 1}`),
  );
  assert.throws(
    () => measureBundles(dist, manifest, { review: { roots: ["missing"], gzipBytes: 1000 } }),
    /review: missing manifest root or import missing/,
  );
});

test("worker assets of imported chunks count once and their growth fails the route budget", (t) => {
  const dist = mkdtempSync(join(tmpdir(), "emend-worker-budget-test-"));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  const files = { "entry.js": "export {};", "diff.js": "export const diff = 1;", "worker.js": "postMessage(1);", "parse.worker.js": "postMessage(2);" };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dist, name), content);
  const manifest = {
    entry: { file: "entry.js", imports: ["diff"] },
    diff: { file: "diff.js", assets: ["worker.js", "parse.worker.js", "worker.js", "unused.png"] },
  };
  const expected = Object.values(files).reduce((sum, content) => sum + gzipSync(content, { level: 9 }).length, 0);
  const budgets = { review: { roots: ["entry"], gzipBytes: expected } };
  const sizes = measureBundles(dist, manifest, budgets);
  assert.deepEqual(sizes[0].files, Object.keys(files).sort());
  assert.equal(sizes[0].gzipBytes, expected);
  assert.doesNotThrow(() => checkBundles(sizes));
  writeFileSync(join(dist, "worker.js"), Array.from({ length: 1000 }, (_, i) => `postMessage("synthetic-${i}");`).join("\n"));
  const grown = measureBundles(dist, manifest, budgets);
  assert(grown[0].gzipBytes > expected);
  assert.throws(() => checkBundles(grown), new RegExp(`review: ${grown[0].gzipBytes} gzip bytes exceeds budget ${expected}`));
});

test("index roots count classic scripts, deduplicate files and exclude module and non-script types", (t) => {
  const dist = mkdtempSync(join(tmpdir(), "emend-classic-budget-test-"));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  const entry = "export const entry = 1;", boot = "window.syntheticTheme = 1;";
  writeFileSync(join(dist, "entry.js"), entry);
  writeFileSync(join(dist, "theme-boot.js"), boot);
  writeFileSync(join(dist, "index.html"), `<!doctype html>
    <script src="/theme-boot.js"></script>
    <script defer src='/theme-boot.js?version=1'></script>
    <SCRIPT SRC=/theme-boot.js TYPE="text/javascript"></SCRIPT>
    <script src="/entry.js"></script>
    <script type="module" src="/module-only.js"></script>
    <script type="application/json" src="/data.json"></script>`);
  const manifest = { "index.html": { file: "entry.js" }, entry: { file: "entry.js" } };
  const sizes = measureBundles(dist, manifest, {
    inbox: { roots: ["index.html"], gzipBytes: 1000 },
    entry: { roots: ["entry"], gzipBytes: 1000 },
  });
  assert.deepEqual(sizes[0].files, ["entry.js", "theme-boot.js"]);
  assert.equal(sizes[0].gzipBytes, gzipSync(entry, { level: 9 }).length + gzipSync(boot, { level: 9 }).length);
  assert.deepEqual(sizes[1].files, ["entry.js"]);
});

test("commented-out scripts neither count nor require their files to exist", (t) => {
  const dist = mkdtempSync(join(tmpdir(), "emend-comment-budget-test-"));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  const entry = "export {};", boot = "window.syntheticTheme = 1;";
  writeFileSync(join(dist, "entry.js"), entry);
  writeFileSync(join(dist, "theme-boot.js"), boot);
  writeFileSync(join(dist, "index.html"), `<!doctype html>
    <!-- <script src="/missing.js"></script> -->
    <script src="/theme-boot.js"></script>
    <!--
      <script src="/also-missing.js"></script>
      <script src="/theme-boot.js"></script>
    -->`);
  const [size] = measureBundles(dist, { "index.html": { file: "entry.js" } }, {
    inbox: { roots: ["index.html"], gzipBytes: 1000 },
  });
  assert.deepEqual(size.files, ["entry.js", "theme-boot.js"]);
  assert.equal(size.gzipBytes, gzipSync(entry, { level: 9 }).length + gzipSync(boot, { level: 9 }).length);
});

test("all classic JavaScript MIME types count, ignoring case and parameters", (t) => {
  const dist = mkdtempSync(join(tmpdir(), "emend-script-types-test-"));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  const types = [
    "", "  ", "application/ecmascript", "application/javascript", "application/x-ecmascript",
    "application/x-javascript", "text/ecmascript", "text/javascript", "text/javascript1.0",
    "text/javascript1.1", "text/javascript1.2", "text/javascript1.3", "text/javascript1.4",
    "text/javascript1.5", "text/jscript", "text/livescript", "text/x-ecmascript", "text/x-javascript",
    "TEXT/JavaScript; charset=utf-8", " Application/X-JavaScript ; charset=utf-8 ",
  ];
  const excluded = ["module", "application/json", "importmap", "unknown", "text/javascript1.6"];
  const files = { "entry.js": "export {};", ...Object.fromEntries(types.map((_, index) =>
    [`classic-${index}.js`, `window.syntheticType = ${index};`])) };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dist, name), content);
  writeFileSync(join(dist, "index.html"), [
    ...types.map((type, index) => `<script type="${type}" src="/classic-${index}.js"></script>`),
    ...excluded.map((type, index) => `<script type="${type}" src="/missing-${index}.js"></script>`),
  ].join("\n"));
  const [size] = measureBundles(dist, { "index.html": { file: "entry.js" } }, {
    inbox: { roots: ["index.html"], gzipBytes: 10000 },
  });
  assert.deepEqual(size.files, Object.keys(files).sort());
  assert.equal(size.gzipBytes, Object.values(files).reduce((sum, file) => sum + gzipSync(file, { level: 9 }).length, 0));
});

test("classic script paths cannot leave the build through traversal or symlinks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-classic-path-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "entry.js"), "export {};");
  writeFileSync(join(root, "outside.js"), "window.synthetic = 1;");
  symlinkSync(join(root, "outside.js"), join(dist, "escape.js"));
  for (const src of ["/../outside.js", "/%2e%2e%2foutside.js", "/escape.js"]) {
    writeFileSync(join(dist, "index.html"), `<script src="${src}"></script>`);
    assert.throws(() => measureBundles(dist, { "index.html": { file: "entry.js" } }, {
      entry: { roots: ["index.html"], gzipBytes: 1000 },
    }), /entry: script path outside build folder/);
  }
});

test("empty roots and negative or fractional budgets are invalid", (t) => {
  const dist = mkdtempSync(join(tmpdir(), "emend-invalid-budget-test-"));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  for (const budget of [
    { roots: [], gzipBytes: 100 }, { roots: ["entry"], gzipBytes: -1 },
    { roots: ["entry"], gzipBytes: 1.5 },
  ]) assert.throws(() => measureBundles(dist, {}, { entry: budget }), /entry: invalid bundle budget/);
});

test("committed budget roots name existing web source files", () => {
  const web = fileURLToPath(new URL("../apps/web", import.meta.url));
  const budgets: Budgets = JSON.parse(readFileSync(join(web, "bundle-budget.json"), "utf8"));
  for (const { roots } of Object.values(budgets)) {
    assert(roots.length > 0);
    for (const root of roots) {
      assert(root === "index.html" || root.startsWith("src/"), root);
      assert(!root.split("/").includes(".."), root);
      assert(statSync(join(web, root)).isFile(), root);
    }
  }
});
