import { type ChartSpec, parseChartSource } from "@recense/contract";
import { Fragment, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import {
  chartWidth,
  formatChartExact,
  layoutBars,
  layoutLine,
  layoutSparklines,
  type SeriesLine,
} from "./chart-layout.ts";

const seriesClass = (index: number) => `em-chart-s${index + 1}`;

function Plot({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  return (
    <svg aria-hidden="true" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {children}
    </svg>
  );
}

function Heading({ lines }: { lines: { text: string; y: number }[] }) {
  return lines.map(({ text, y }) => (
    <text key={y} x={0} y={y} className="em-chart-heading">
      {text}
    </text>
  ));
}

function Trace({ line, index }: { line: SeriesLine; index: number }) {
  return (
    <g className={seriesClass(index)}>
      <polyline className="em-chart-line" points={line.coordinates} />
      {line.points.map((point) => (
        <circle
          key={point.x}
          cx={point.x}
          cy={point.y}
          r={4}
          className={point === line.end ? "em-chart-end" : "em-chart-point"}
        >
          <title>{point.title}</title>
        </circle>
      ))}
    </g>
  );
}

function EndValue({ line }: { line: SeriesLine }) {
  return (
    <text className="em-chart-value" x={line.valueX} y={line.end.y} dominantBaseline="central">
      {line.value}
    </text>
  );
}

function ChartPlot({ spec, width }: { spec: ChartSpec; width: number }) {
  if (spec.type === "bar") {
    const plot = layoutBars(spec, width);
    return (
      <Plot width={width} height={plot.height}>
        <line className="em-chart-rule" x1={0} x2={0} y1={plot.baselineTop} y2={plot.height} />
        {plot.rows.map(({ heading, bars, barTop }) => (
          <g key={barTop}>
            <Heading lines={heading} />
            {bars.map((bar, index) => (
              <Fragment key={bar.name}>
                {bar.path && (
                  <path className={seriesClass(index)} d={bar.path}>
                    <title>{bar.title}</title>
                  </path>
                )}
                <text className="em-chart-value" x={bar.valueX} y={bar.valueY} dominantBaseline="central">
                  {bar.value}
                </text>
              </Fragment>
            ))}
          </g>
        ))}
      </Plot>
    );
  }
  if (spec.type === "line") {
    const plot = layoutLine(spec, width);
    return (
      <Plot width={plot.width} height={plot.height}>
        {plot.grid.map(({ text, y }) => (
          <g key={y}>
            <line className="em-chart-rule" x1={plot.left} x2={plot.right} y1={y} y2={y} />
            <text className="em-chart-axis" x={plot.tickX} y={y} textAnchor="end" dominantBaseline="central">
              {text}
            </text>
          </g>
        ))}
        {plot.labels.map(({ x, lines }) => (
          <text className="em-chart-axis" key={x} textAnchor="middle">
            {lines.map(({ text, y }) => (
              <tspan key={y} x={x} y={y}>
                {text}
              </tspan>
            ))}
          </text>
        ))}
        {plot.lines.map((line, index) => (
          <Fragment key={line.name}>
            <Trace line={line} index={index} />
            {plot.showEndValues && <EndValue line={line} />}
          </Fragment>
        ))}
      </Plot>
    );
  }
  const plot = layoutSparklines(spec, width);
  return (
    <Plot width={width} height={plot.height}>
      {plot.rows.map(({ heading, line }, index) => (
        <g key={line.name}>
          <Heading lines={heading} />
          <Trace line={line} index={index} />
          <EndValue line={line} />
        </g>
      ))}
    </Plot>
  );
}

function ChartData({ spec }: { spec: ChartSpec }) {
  const labels = spec.labels ?? spec.series[0]?.values.map((_, i) => String(i + 1)) ?? [];
  return (
    <details>
      <summary className="cursor-pointer text-fg-3 [font:var(--type-meta)]">Data</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">{spec.labels ? "Label" : "#"}</th>
            {spec.series.map(({ name }) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((label, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat and the rows are fixed positions in each series.
            <tr key={i}>
              <th scope="row">{label}</th>
              {spec.series.map(({ name, values }) => (
                <td key={name}>{formatChartExact(values[i] as number, spec.unit)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function ChartFigure({ spec }: { spec: ChartSpec }) {
  const figure = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(chartWidth(0));
  useLayoutEffect(() => {
    if (!figure.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(chartWidth(entry.contentRect.width));
    });
    observer.observe(figure.current);
    return () => observer.disconnect();
  }, []);
  return (
    <figure ref={figure} className="em-chart space-y-2 overflow-x-auto rounded-md bg-sunken p-3.5">
      {spec.title && <figcaption className="font-semibold text-fg-1">{spec.title}</figcaption>}
      {spec.type !== "sparkline" && spec.series.length >= 2 && (
        <ul className="em-chart-legend">
          {spec.series.map(({ name }, i) => (
            <li key={name}>
              <span aria-hidden="true" className={seriesClass(i)} />
              {name}
            </li>
          ))}
        </ul>
      )}
      <ChartPlot spec={spec} width={width} />
      <ChartData spec={spec} />
    </figure>
  );
}

export function ChartBlock({ source }: { source: string }) {
  const spec = parseChartSource(source);
  if (spec) return <ChartFigure spec={spec} />;
  return (
    <pre className="overflow-x-auto rounded-md bg-sunken p-3.5 font-mono text-13 text-fg-2">
      <code>{source}</code>
    </pre>
  );
}
