import { expect, test } from "vitest";
import { parseChartSource } from "./index.ts";

const bar = {
  type: "bar",
  title: "Search time",
  unit: "ms",
  labels: ["Cold start", "Warm cache"],
  series: [
    { name: "Before", values: [420, 95] },
    { name: "After", values: [180, 40] },
  ],
};

test.each([bar, { ...bar, type: "line" }, { ...bar, type: "sparkline" }, { type: "sparkline", series: bar.series }])(
  "parses $type without rewriting its text or values",
  (spec) => {
    expect(parseChartSource(JSON.stringify(spec))).toEqual(spec);
  },
);

test("refuses malformed, oversized and non-finite input", () => {
  const source = JSON.stringify(bar);
  expect(parseChartSource(source.padEnd(4000))).toEqual(bar);
  for (const invalid of ["{", source.padEnd(4001), source.replace("420", "1e400")]) {
    expect(parseChartSource(invalid)).toBeNull();
  }
});

test("refuses an own __proto__ key in either object", () => {
  const source = JSON.stringify(bar);
  expect(parseChartSource(source.replace('{"type"', '{"__proto__":{},"type"'))).toBeNull();
  expect(parseChartSource(source.replace('{"name"', '{"__proto__":{},"name"'))).toBeNull();
});

test.each([
  { type: undefined },
  { type: "pie" },
  { colour: "blue" },
  { series: [{ name: "A", values: [1, 2], extra: true }] },
  { series: [{ name: "A", values: [1] }] },
  { series: Array.from({ length: 5 }, (_, i) => ({ name: String(i), values: [1, 2] })) },
  { series: [] },
  { labels: [] },
  { title: "" },
  { title: " ".repeat(3) },
  { title: "t".repeat(81) },
  { unit: "123456789" },
  { labels: ["x".repeat(33), "y"] },
  { labels: ["x", " \t"] },
  { series: [{ name: "", values: [1, 2] }] },
  { series: [{ name: "a".repeat(33), values: [1, 2] }] },
  { series: [{ name: "A", values: [-1, 2] }] },
  { series: [{ name: "A", values: [1_000_000_000_001, 2] }] },
  { series: [{ name: "A", values: ["1", 2] }] },
  { series: [bar.series[0], bar.series[0]] },
  { type: "sparkline", labels: undefined, series: [...bar.series, { name: "Other", values: [1, 2, 3] }] },
  { type: "sparkline", labels: ["one", "two", "three"] },
])("refuses an invalid field or series (%#)", (fields) => {
  expect(parseChartSource(JSON.stringify({ ...bar, ...fields }))).toBeNull();
});

test.each([
  ["bar", 1, 12],
  ["line", 2, 24],
  ["sparkline", 2, 60],
] as const)("%s accepts the minimum and maximum number of points", (type, min, max) => {
  for (const count of [min - 1, min, max, max + 1]) {
    const values = Array.from({ length: count }, (_, i) => i);
    const labels = values.map(String);
    for (const names of type === "sparkline" ? [labels, undefined] : [labels]) {
      const source = JSON.stringify({ type, labels: names, series: [{ name: "counts", values }] });
      expect(parseChartSource(source) !== null).toBe(count >= min && count <= max);
    }
  }
});
