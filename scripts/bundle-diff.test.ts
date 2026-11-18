import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { compareBundles, formatBundleSummary, parseArgs, USAGE, validateBaseCache } from "./bundle-diff.ts";

const sha = "abcdef0123456789abcdef0123456789abcdef01";
const bundles = (sizes: Record<string, number>, budgets: Record<string, number> = {}) => ({ sizes, budgets });

test("growth below the threshold and shrinking are listed without findings", () => {
  const result = compareBundles(bundles({ entry: 10000, review: 20000, inbox: 1000 }),
    bundles({ entry: 10400, review: 18800, inbox: 1000 }));
  assert.deepEqual(result.rows, [
    { route: "entry", base: 10000, head: 10400, delta: 400, status: "grew" },
    { route: "review", base: 20000, head: 18800, delta: -1200, status: "shrank" },
    { route: "inbox", base: 1000, head: 1000, delta: 0, status: "same" },
  ]);
  assert.deepEqual(result.over, []);
  assert.equal(formatBundleSummary(result, sha),
    "Bundle vs main abcdef0 (gzip): entry +0.4 KB; review -1.2 KB; others unchanged.");
});

test("unchanged sizes and empty comparisons use the exact no-change line", () => {
  for (const sizes of [{}, { entry: 1000 }]) {
    const result = compareBundles(bundles(sizes), bundles(sizes));
    assert.equal(formatBundleSummary(result, sha),
      "Bundle vs main abcdef0 (gzip): no chunk changed size.");
    assert.deepEqual(result.over, []);
  }
});

test("head routes come first, then removed routes in base order, and neither new nor removed is over", () => {
  const result = compareBundles(bundles({ pair: 336900, entry: 1000, old: 2000 }),
    bundles({ settings: 336900, entry: 1000 }));
  assert.deepEqual(result.rows, [
    { route: "settings", base: null, head: 336900, delta: null, status: "new" },
    { route: "entry", base: 1000, head: 1000, delta: 0, status: "same" },
    { route: "pair", base: 336900, head: null, delta: null, status: "removed" },
    { route: "old", base: 2000, head: null, delta: null, status: "removed" },
  ]);
  assert.deepEqual(result.over, []);
  assert.equal(formatBundleSummary(result, sha),
    "Bundle vs main abcdef0 (gzip): settings new 336.9 KB; pair removed (was 336.9 KB); old removed (was 2.0 KB); others unchanged.");
});

test("only growth strictly greater than 5000 bytes is over", () => {
  const base = bundles({ exact: 1000, over: 1000, shrink: 9000 });
  const head = bundles({ exact: 6000, over: 6001, shrink: 0 });
  const result = compareBundles(base, head);
  assert.deepEqual(result.over, [result.rows[1]]);
  assert.equal(formatBundleSummary(result, sha).split("\n")[1], "Over 5 KB: over +5.0 KB");
  assert.deepEqual(compareBundles(base, head, 5001).over, []);
  assert.deepEqual(compareBundles(base, head, 4999).over.map((row) => row.route), ["exact", "over"]);
});

test("equal exact deltas group in row order, without grouping rounded matches or opposite signs", () => {
  const result = compareBundles(bundles({ inbox: 10000, review: 10000, pub: 10000, settings: 10000, entry: 10000 }),
    bundles({ inbox: 13100, review: 6900, pub: 13100, settings: 13100, entry: 13101 }));
  assert.equal(formatBundleSummary(result, sha),
    "Bundle vs main abcdef0 (gzip): inbox, pub, settings +3.1 KB; review -3.1 KB; entry +3.1 KB.");
});

test("deltas under 100 bytes use bytes and larger deltas use decimal KB", () => {
  const result = compareBundles(bundles({ tiny: 0, smaller: 1000, boundary: 0, negative: 1000 }),
    bundles({ tiny: 42, smaller: 901, boundary: 100, negative: 900 }));
  assert.equal(formatBundleSummary(result, sha),
    "Bundle vs main abcdef0 (gzip): tiny +42 B; smaller -99 B; boundary +0.1 KB; negative -0.1 KB.");
});

test("every ceiling change is listed even when sizes do not change", () => {
  const result = compareBundles(
    bundles({ entry: 100 }, { removed: 0, lowered: 20000, raised: 10000, same: 30000 }),
    bundles({ entry: 100 }, { raised: 12000, lowered: 19000, added: 0, same: 30000 }),
  );
  assert.deepEqual(result.ceilings, [
    { route: "raised", old: 10000, new: 12000, change: "raised" },
    { route: "lowered", old: 20000, new: 19000, change: "lowered" },
    { route: "added", old: null, new: 0, change: "added" },
    { route: "removed", old: 0, new: null, change: "removed" },
  ]);
  assert.equal(formatBundleSummary(result, sha), [
    "Bundle vs main abcdef0 (gzip): no chunk changed size.",
    "Ceiling raised: raised from 10000 to 12000 gzip bytes.",
    "Ceiling lowered: lowered from 20000 to 19000 gzip bytes.",
    "Ceiling added: added 0 gzip bytes.",
    "Ceiling removed: removed (was 0 gzip bytes).",
  ].join("\n"));
});

test("cache accepts only the matching schema and sha with safe non-negative integer maps", () => {
  const cache = { schemaVersion: 1, sha, sizes: { entry: 0 }, budgets: { entry: 1000 } };
  assert(validateBaseCache(cache, sha));
  assert(validateBaseCache({ ...cache, sizes: {}, budgets: {} }, sha));
  assert(!validateBaseCache(cache, "b".repeat(40)));
  assert(!validateBaseCache({ ...cache, schemaVersion: 2 }, sha));
  assert(!validateBaseCache({ ...cache, sha: "bad" }, "bad"));
  for (const field of ["sizes", "budgets"]) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "100", null])
      assert(!validateBaseCache({ ...cache, [field]: { entry: value } }, sha));
    for (const value of [undefined, null, [], 1, "invalid"])
      assert(!validateBaseCache({ ...cache, [field]: value }, sha));
  }
  for (const value of [null, undefined, [], "invalid", {}]) assert(!validateBaseCache(value, sha));
});

test("route names are own keys even when they match object prototype names", () => {
  const result = compareBundles(bundles({ toString: 1000 }), bundles(JSON.parse('{"__proto__": 0}')));
  assert.deepEqual(result.rows.map((row) => [row.route, row.status]), [["__proto__", "new"], ["toString", "removed"]]);
});

test("arguments accept base and JSON output and reject unknown flags or missing values", () => {
  assert.deepEqual(parseArgs([]), { base: undefined, json: undefined });
  assert.deepEqual(parseArgs(["--base", "main~1", "--json", "result.json"]),
    { base: "main~1", json: resolve("result.json") });
  for (const args of [["--unknown"], ["main"], ["--base"], ["--json"], ["--base", "--json", "file"], ["--json", "--base", "main"], ["--base", ""]])
    assert.throws(() => parseArgs(args), { message: USAGE });
});
