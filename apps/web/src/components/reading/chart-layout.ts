import type { ChartSpec } from "@emend/contract";

const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatChartValue(value: number, unit?: string) {
  const number = (value < 10_000 ? decimal : compact).format(value);
  return unit ? number + (unit === "%" ? "%" : ` ${unit}`) : number;
}

export function chartWidth(width: number) {
  return width > 0 && Number.isFinite(width) ? Math.max(200, Math.min(960, Math.floor(width))) : 480;
}

export function niceScale(maximum: number) {
  const max = maximum || 1;
  // Subnormal values can underflow when divided into five intervals.
  const power = Math.max(Number.MIN_VALUE, 10 ** Math.floor(Math.log10(max / 5 || Number.MIN_VALUE)));
  const factor = [1, 2, 2.5, 5, 10].find((n) => n * power * 5 >= max) ?? 10;
  const step = factor * power;
  const count = [1, 2, 3, 4, 5].find((n) => n * step >= max) ?? 5;
  return { step, axisMax: step * count, ticks: Array.from({ length: count + 1 }, (_, i) => i * step) };
}

type Spec<T extends ChartSpec["type"]> = Extract<ChartSpec, { type: T }>;
type Series = ChartSpec["series"][number];
const textWidth = (text: string) => Array.from(text).length * 7;
const reserve = (values: string[]) => Math.max(...values.map(textWidth)) + 8;
const maximum = (spec: ChartSpec) => Math.max(...spec.series.flatMap(({ values }) => values));

function labelLines(text: string, width: number, baseline: number) {
  const chars = Array.from(text);
  const length = Math.max(1, Math.floor(width / 7));
  const lines = [];
  for (let i = 0; i < chars.length; i += length)
    lines.push({ text: chars.slice(i, i + length).join(""), y: baseline + lines.length * 16 });
  return lines;
}

function barPath(length: number, y: number) {
  if (length === 0) return null;
  const radius = Math.min(4, length);
  const edge = length - radius;
  return `M0 ${y}H${edge}a${radius} ${radius} 0 0 1 ${radius} ${radius}v${12 - 2 * radius}a${radius} ${radius} 0 0 1 ${-radius} ${radius}H0Z`;
}

export function layoutBars(spec: Spec<"bar">, width: number) {
  const { axisMax } = niceScale(maximum(spec));
  const formatted = spec.series.flatMap(({ values }) => values.map((n) => formatChartValue(n, spec.unit)));
  const barSpace = width - reserve(formatted);
  let top = 0;
  const rows = spec.labels.map((label, index) => {
    const heading = labelLines(label, width, top + 13);
    const barTop = top + heading.length * 16 + 4;
    const bars = spec.series.map(({ name, values }, s) => {
      const n = values[index] as number;
      const value = formatChartValue(n, spec.unit);
      const length = (n / axisMax) * barSpace;
      const y = barTop + s * 14;
      return {
        name,
        length,
        path: barPath(length, y),
        value,
        valueX: length + 6,
        valueY: y + 6,
        title: `${label} · ${name}: ${value}`,
      };
    });
    top = barTop + bars.length * 14 - 2 + 14;
    return { heading, bars, barTop };
  });
  return { rows, barSpace, baselineTop: rows[0]?.barTop ?? 0, height: top - 14 };
}

const lastValue = (series: Series) => series.values.at(-1) as number;

function seriesLine(spec: ChartSpec, series: Series, x: (index: number) => number, y: (n: number) => number) {
  const points = series.values.map((n, i) => {
    const value = formatChartValue(n, spec.unit);
    const label = spec.labels?.[i] ?? String(i + 1);
    return { x: x(i), y: y(n), title: `${label} · ${series.name}: ${value}` };
  });
  const end = points[points.length - 1] as (typeof points)[number];
  return {
    name: series.name,
    points,
    end,
    coordinates: points.map(({ x, y }) => `${x},${y}`).join(" "),
    value: formatChartValue(lastValue(series), spec.unit),
    valueX: end.x + 8,
  };
}
export type SeriesLine = ReturnType<typeof seriesLine>;

function thinLabels(labels: string[], x: (i: number) => number, width: number) {
  const last = labels.length - 1;
  const middle = (x(0) + x(last)) / 2;
  const candidates = labels.map((label, i) => {
    // Both endpoints must fit even when two long labels alone would fill the entire plot.
    const min = i === last ? middle + 4 : 0;
    const max = i === 0 ? middle - 4 : width;
    const lines = labelLines(label, max - min, 166);
    const half = Math.max(...lines.map(({ text }) => textWidth(text))) / 2;
    const center = Math.max(min + half, Math.min(max - half, x(i)));
    return { lines, x: center, left: center - half, right: center + half };
  });
  const end = candidates[last] as (typeof candidates)[number];
  let right = -Infinity;
  return candidates.filter((label, i) => {
    if (i > 0 && i < last && (label.left < right + 8 || label.right + 8 > end.left)) return false;
    right = label.right;
    return true;
  });
}

export function layoutLine(spec: Spec<"line">, width: number) {
  const { axisMax, ticks } = niceScale(maximum(spec));
  const y = (n: number) => 7 + (1 - n / axisMax) * 140;
  const grid = ticks.map((tick) => ({ y: y(tick), text: formatChartValue(tick) }));
  const left = reserve(grid.map(({ text }) => text));
  const ends = spec.series.map((series) => y(lastValue(series))).sort((a, b) => a - b);
  const showEndValues = ends.every((end, i) => i === 0 || end - (ends[i - 1] as number) >= 14);
  const right =
    width - (showEndValues ? reserve(spec.series.map((s) => formatChartValue(lastValue(s), spec.unit))) : 6);
  const x = (i: number) => left + ((right - left) * i) / (spec.labels.length - 1);
  const labels = thinLabels(spec.labels, x, width);
  return {
    height: 170 + 16 * (Math.max(...labels.map((label) => label.lines.length)) - 1),
    left,
    right,
    tickX: left - 8,
    grid,
    labels,
    showEndValues,
    lines: spec.series.map((series) => seriesLine(spec, series, x, y)),
  };
}

export function layoutSparklines(spec: Spec<"sparkline">, width: number) {
  const right = width - reserve(spec.series.map((s) => formatChartValue(lastValue(s), spec.unit)));
  let top = 0;
  const rows = spec.series.map((series) => {
    const heading = labelLines(series.name, width, top + 13);
    const plotTop = top + heading.length * 16 + 6;
    const min = Math.min(...series.values);
    const max = Math.max(...series.values);
    const x = (i: number) => 2 + ((right - 2) * i) / (series.values.length - 1);
    const y = (n: number) => plotTop + (min === max ? 0.5 : (max - n) / (max - min)) * 32;
    const line = seriesLine(spec, series, x, y);
    top = plotTop + 32 + 6 + 8;
    return { heading, line };
  });
  return { height: top - 8, rows };
}
