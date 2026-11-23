import { z } from "zod";
import { LIMITS } from "./limits.ts";

const text = (max: number) => z.string().min(1).max(max).regex(/\S/);
const label = text(LIMITS.chartLabelChars);
const ChartValue = z.number().min(0).max(LIMITS.chartValueMax);
const ChartSeries = z.strictObject({ name: label, values: z.array(ChartValue) });
const fields = {
  title: text(LIMITS.chartTitleChars).optional(),
  unit: text(LIMITS.chartUnitChars).optional(),
  series: z.array(ChartSeries).min(1).max(LIMITS.chartSeries),
};

export const ChartSpec = z
  .discriminatedUnion("type", [
    z.strictObject({ type: z.literal("bar"), ...fields, labels: z.array(label).min(1).max(LIMITS.chartBarLabels) }),
    z.strictObject({ type: z.literal("line"), ...fields, labels: z.array(label).min(2).max(LIMITS.chartLineLabels) }),
    z.strictObject({
      type: z.literal("sparkline"),
      ...fields,
      labels: z.array(label).min(2).max(LIMITS.chartSparklineValues).optional(),
    }),
  ])
  .refine(({ series }) => new Set(series.map(({ name }) => name)).size === series.length, "series names must be unique")
  .refine(({ type, labels, series }) => {
    const count = labels?.length ?? series[0]?.values.length ?? 0;
    if (type === "sparkline" && (count < 2 || count > LIMITS.chartSparklineValues)) return false;
    return series.every(({ values }) => values.length === count);
  }, "every series must have one value per point");
export type ChartSpec = z.infer<typeof ChartSpec>;

export function parseChartSource(source: string): ChartSpec | null {
  if (source.length > LIMITS.chartSourceChars) return null;
  try {
    const result = ChartSpec.safeParse(JSON.parse(source));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
