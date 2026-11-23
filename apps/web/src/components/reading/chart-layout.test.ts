// @vitest-environment node
import type { ChartSpec } from "@emend/contract";
import { expect, test } from "vitest";
import { chartWidth, formatChartValue, layoutBars, layoutLine, layoutSparklines, niceScale } from "./chart-layout.ts";

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

test("formats precise small values, compact large values and percent units", () => {
  expect(formatChartValue(12, "ms")).toBe("12 ms");
  expect(formatChartValue(1234.5)).toBe("1,234.5");
  expect(formatChartValue(12345)).toBe("12.3K");
  expect(formatChartValue(7, "%")).toBe("7%");
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

test("long endpoint labels wrap in their own space on a phone", () => {
  const labels = ["One long label with a long name", "One more long name for the plot"];
  const line = layoutLine({ type: "line", labels, series }, 200);
  expect(line.labels.map((label) => label.lines.map(({ text }) => text).join(""))).toEqual(labels);
  expect(line.height).toBeGreaterThan(170);
  expect((line.labels[1]?.left ?? 0) - (line.labels[0]?.right ?? 0)).toBeGreaterThanOrEqual(8);
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
