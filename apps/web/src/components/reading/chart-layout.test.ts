// @vitest-environment node
import type { ChartSpec } from "@emend/contract";
import { expect, test } from "vitest";
import {
  chartWidth,
  formatChartExact,
  formatChartLabel,
  labelLines,
  layoutBars,
  layoutLine,
  layoutSparklines,
  niceScale,
} from "./chart-layout.ts";

test.each([
  [0, 0.2, 1],
  [1, 0.2, 1],
  [7, 2, 8],
  [95, 20, 100],
  [420, 100, 500],
  [1234, 250, 1250],
  [1e12, 2e11, 1e12],
])("nice scale for %s", (value, step, axisMax) => {
  const scale = niceScale(value);
  expect(scale.step).toBe(step);
  expect(scale.axisMax).toBe(axisMax);
  expect(scale.ticks.at(-1)).toBe(axisMax);
  expect(scale.ticks.length).toBeGreaterThanOrEqual(4);
  expect(scale.ticks.length).toBeLessThanOrEqual(6);
});

test("zero or missing widths use the fallback, and measured widths stay within bounds", () => {
  expect([0, 150, 320, 1440].map(chartWidth)).toEqual([480, 200, 320, 960]);
});

test.each([
  [0, "0"],
  [0.001, "0.001"],
  [0.004, "0.004"],
  [0.00123456, "0.00123"],
  [1234.5, "1,234.5"],
  [12341, "12.34K"],
  [12349, "12.35K"],
  [123456, "123.5K"],
  [1e12, "1T"],
] as const)("formats %s as a chart label", (value, expected) => {
  expect(formatChartLabel(value)).toBe(expected);
});

test.each([
  [0.001, "0.001"],
  [12341, "12,341"],
  [12349, "12,349"],
  [1e12, "1,000,000,000,000"],
  [0.1, "0.1"],
  [1e-25, "1e-25"],
] as const)("keeps the exact value of %s", (value, expected) => {
  expect(formatChartExact(value)).toBe(expected);
});

test.each([
  [0.004, ["0", "0.001", "0.002", "0.003", "0.004"]],
  [0.012, ["0", "0.0025", "0.005", "0.0075", "0.01", "0.0125"]],
  [0.3, ["0", "0.1", "0.2", "0.3"]],
  [7, ["0", "2", "4", "6", "8"]],
  [95, ["0", "20", "40", "60", "80", "100"]],
  [1234, ["0", "250", "500", "750", "1,000", "1,250"]],
  [1e12, ["0", "200B", "400B", "600B", "800B", "1T"]],
] as const)("draws distinct exact tick labels for a maximum of %s", (maximum, expected) => {
  const { grid } = layoutLine(
    { type: "line", labels: ["First", "Last"], series: [{ name: "Count", values: [0, maximum] }] },
    480,
  );
  expect(grid.map(({ text }) => text)).toEqual(expected);
});

test.each(["ms", "%"])("appends %s to values and reserves space for the drawn strings", (unit) => {
  const suffix = unit === "%" ? "%" : " ms";
  const spec = { unit, labels: ["First", "Last"], series: [{ name: "Counts", values: [0.004, 12349] }] };
  expect(formatChartExact(12349, unit)).toBe(`12,349${suffix}`);
  const bar = layoutBars({ ...spec, type: "bar" }, 480);
  expect(bar.rows[1]?.bars[0]?.value).toBe(`12.35K${suffix}`);
  expect(bar.barSpace).toBe(480 - `12.35K${suffix}`.length * 7 - 8);
  const line = layoutLine({ ...spec, type: "line" }, 480);
  expect(line.grid[0]?.text).toBe(`0${suffix}`);
  expect(line.left).toBe(Math.max(...line.grid.map(({ text }) => text.length)) * 7 + 8);
  expect(line.right).toBe(bar.barSpace);
  expect(layoutSparklines({ ...spec, type: "sparkline" }, 480).rows[0]?.line.end.x).toBe(bar.barSpace);
});

test("long unit suffixes leave room for the plot on a narrow line chart", () => {
  const spec = {
    type: "line" as const,
    labels: ["First", "Next"],
    unit: "requests",
    series: [{ name: "Rate", values: [0, 0.000012345] }],
  };
  const plot = layoutLine(spec, 200);
  expect(plot.left).toBe(Math.max(...plot.grid.map(({ text }) => text.length)) * 7 + 8);
  expect(plot.right).toBe(plot.width - "0.0000123 requests".length * 7 - 8);
  expect(plot.right).toBeGreaterThan(plot.left);
});

const series = [
  { name: "A", values: [0, 100] },
  { name: "B", values: [40, 80] },
];
test("grouped bars share a baseline, leave space for values and omit zero-length paths", () => {
  const layout = layoutBars({ type: "bar", labels: ["First", "Last"], series }, 480);
  const bars = layout.rows.flatMap(({ bars }) => bars);
  expect(bars).toHaveLength(4);
  expect(bars[0]).toMatchObject({ path: null, valueX: 6, value: "0" });
  expect(bars[2]?.length).toBe(layout.barSpace);
  expect(layout.barSpace).toBe(480 - 3 * 7 - 8);
});

test("line labels at both edges survive thinning on a narrow plot", () => {
  const labels = Array.from({ length: 24 }, (_, i) => `Day ${i + 1}`);
  const line = layoutLine({ type: "line", labels, series: [{ name: "Counts", values: labels.map((_, i) => i) }] }, 200);
  expect(line.labels[0]?.lines[0]?.text).toBe("Day 1");
  expect(line.labels.at(-1)?.lines[0]?.text).toBe("Day 24");
  expect(line.labels.length).toBeLessThan(labels.length);
  for (const [i, label] of line.labels.entries()) {
    const previous = line.labels[i - 1];
    if (previous) expect(label.left - previous.right).toBeGreaterThanOrEqual(8);
  }
});

test("label lines fit whole words greedily and split an oversized word by character", () => {
  expect(labelLines("Request counts after the release", 140, 13)).toEqual([
    { text: "Request counts after", y: 13 },
    { text: "the release", y: 29 },
  ]);
  expect(labelLines("Run abcdefgh now", 35, 0).map(({ text }) => text)).toEqual(["Run", "abcde", "fgh", "now"]);
});

test("a bar heading wraps at spaces", () => {
  const plot = layoutBars(
    { type: "bar", labels: ["Request counts after the release"], series: [{ name: "Count", values: [1] }] },
    200,
  );
  expect(plot.rows[0]?.heading.map(({ text }) => text)).toEqual(["Request counts after the", "release"]);
});

test("a narrow line plot anchors its edge labels at their points and keeps the visible labels apart", () => {
  const values = Array.from({ length: 24 }, (_, i) => i);
  const labels = values.map(String);
  labels[0] = "Request counts ahead of releases";
  labels[23] = "Request counts after the release";
  const line = layoutLine({ type: "line", labels, series: [{ name: "Counts", values }] }, 282);
  const points = line.lines[0]?.points ?? [];
  expect(line.labels[0]).toMatchObject({ anchor: "start", x: points[0]?.x });
  expect(line.labels.at(-1)).toMatchObject({ anchor: "end", x: points[23]?.x });
  expect(line.labels.some(({ anchor }) => anchor === "middle")).toBe(true);
  expect(line.height).toBeGreaterThan(170);
  let previousRight = -Infinity;
  for (const label of line.labels) {
    const point = points.findIndex(({ x }) => x === label.x);
    expect(label.lines.map(({ text }) => text).join(" ")).toBe(labels[point]);
    const widest = Math.max(...label.lines.map(({ text }) => text.length * 7));
    const left = label.x - (label.anchor === "start" ? 0 : label.anchor === "end" ? widest : widest / 2);
    const right = left + widest;
    expect(label.left).toBeCloseTo(left);
    expect(label.right).toBeCloseTo(right);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(282);
    expect(left - previousRight).toBeGreaterThanOrEqual(8);
    previousRight = right;
  }
});

test("end labels appear together only when all series ends are far enough apart", () => {
  const spec: Extract<ChartSpec, { type: "line" }> = { type: "line", labels: ["Start", "End"], series };
  expect(layoutLine(spec, 480).showEndValues).toBe(true);
  expect(layoutLine({ ...spec, series: [...series, { name: "C", values: [0, 76] }] }, 480).showEndValues).toBe(false);
  expect(layoutLine({ ...spec, series: [{ name: "Only", values: [0, 0] }] }, 200).showEndValues).toBe(true);
});

test("sparkline rows have independent domains, with a flat line in the middle", () => {
  const { rows } = layoutSparklines(
    {
      type: "sparkline",
      series: [
        { name: "Flat", values: [42, 42] },
        { name: "Rising", values: [1000, 1001] },
      ],
    },
    200,
  );
  expect(rows[0]?.line.points.map(({ y }) => y)).toEqual([rows[0]?.line.end.y, rows[0]?.line.end.y]);
  const rising = rows[1]?.line.points ?? [];
  expect((rising[0]?.y ?? 0) - (rising[1]?.y ?? 0)).toBe(32);
});

test("subnormal values still yield finite chart coordinates", () => {
  const line = layoutLine(
    { type: "line", labels: ["First", "Next"], series: [{ name: "Tiny", values: [0, Number.MIN_VALUE] }] },
    200,
  );
  for (const point of line.lines[0]?.points ?? []) expect(Number.isFinite(point.y)).toBe(true);
});
