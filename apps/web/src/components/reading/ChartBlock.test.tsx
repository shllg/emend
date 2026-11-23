import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChartBlock } from "./ChartBlock.tsx";

afterEach(cleanup);
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

test("draws two grouped bars per label, names their series and exposes the data as a table", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  const { container, getByRole, getByText } = render(<ChartBlock source={JSON.stringify(bar)} />);
  expect(container.querySelector("svg")?.getAttribute("width")).toBe("480");
  expect(container.querySelector("figcaption")?.textContent).toBe("Search time");
  expect(
    within(getByRole("list"))
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["Before", "After"]);
  expect(Array.from(container.querySelectorAll("svg path"), (path) => path.getAttribute("class"))).toEqual([
    "em-chart-s1",
    "em-chart-s2",
    "em-chart-s1",
    "em-chart-s2",
  ]);
  expect(Array.from(container.querySelectorAll("svg path title"), (title) => title.textContent)).toEqual([
    "Cold start · Before: 420 ms",
    "Cold start · After: 180 ms",
    "Warm cache · Before: 95 ms",
    "Warm cache · After: 40 ms",
  ]);
  expect(Array.from(container.querySelectorAll("svg text"), (el) => el.textContent)).toEqual([
    "Cold start",
    "420 ms",
    "180 ms",
    "Warm cache",
    "95 ms",
    "40 ms",
  ]);
  fireEvent.click(getByText("Data"));
  const table = within(getByRole("table"));
  expect(table.getAllByRole("columnheader").map((el) => el.textContent)).toEqual(["Label", "Before", "After"]);
  expect(table.getAllByRole("rowheader").map((el) => el.textContent)).toEqual(bar.labels);
  expect(table.getAllByRole("cell").map((el) => el.textContent)).toEqual(["420 ms", "180 ms", "95 ms", "40 ms"]);
});

test.each(["bar", "line", "sparkline"])("shows exact %s values in the Data table and tooltips", (type) => {
  const source = JSON.stringify({ ...bar, type, series: [{ name: "Search", values: [12341, 12349] }] });
  const { container, getByRole, getByText } = render(<ChartBlock source={source} />);
  fireEvent.click(getByText("Data"));
  expect(
    within(getByRole("table"))
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual(["12,341 ms", "12,349 ms"]);
  const titles = container.querySelectorAll(type === "bar" ? "path title" : "circle title");
  expect(Array.from(titles, (title) => title.textContent)).toEqual([
    "Cold start · Search: 12,341 ms",
    "Warm cache · Search: 12,349 ms",
  ]);
});

test.each(["line", "sparkline"])("draws a %s with a tooltip at every point", (type) => {
  const source = JSON.stringify({ ...bar, type, labels: type === "line" ? bar.labels : undefined });
  const { container } = render(<ChartBlock source={source} />);
  expect(container.querySelectorAll("polyline")).toHaveLength(2);
  expect(container.querySelectorAll("circle title")).toHaveLength(4);
  expect(container.querySelectorAll("ul")).toHaveLength(type === "line" ? 1 : 0);
  expect(container.querySelector("th")?.textContent).toBe(type === "line" ? "Label" : "#");
  expect(container.querySelector("circle title")?.textContent).toBe(
    `${type === "line" ? "Cold start" : "1"} · Before: 420 ms`,
  );
});

test("an invalid source is exact text in a code block", () => {
  const source = '{"type":"line","unit":"<img onerror=bad()>"}\n';
  const { container } = render(<ChartBlock source={source} />);
  expect(container.querySelector("pre code")?.textContent).toBe(source);
  expect(container.querySelector("img, svg")).toBeNull();
});

test.each(["bar", "line", "sparkline"])("%s renders hostile strings only as text", (type) => {
  const fields = {
    title: "<script>alert(1)</script>",
    labels: ["<img src=x onerror=alert(1)>", "javascript:alert(1)"],
    series: [{ name: "<svg onload=alert(1)>", values: [1, 2] }],
    unit: "<x>",
  };
  const { container } = render(<ChartBlock source={JSON.stringify({ type, ...fields })} />);
  for (const text of [fields.title, ...fields.labels, fields.series[0]?.name, fields.unit])
    expect(container.textContent).toContain(text);
  expect(container.querySelectorAll("svg")).toHaveLength(1);
  expect(container.querySelector("script, img, svg svg, x")).toBeNull();
  for (const el of container.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      expect(attr.name).not.toMatch(/^on/i);
      expect(attr.value).not.toMatch(/<|javascript:/i);
    }
  }
});

test("uses the observed content width and disconnects when a chart becomes code", () => {
  let resize: ((width: number) => void) | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
        resize = (width) => callback([{ contentRect: { width } }]);
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const { container, rerender } = render(<ChartBlock source={JSON.stringify(bar)} />);
  const svg = container.querySelector("svg");
  for (const [width, expected] of [
    [0, 480],
    [315, 315],
    [1200, 960],
    [75, 200],
  ] as const) {
    act(() => resize?.(width));
    expect(svg?.getAttribute("width")).toBe(String(expected));
  }
  rerender(<ChartBlock source="broken" />);
  expect(disconnect).toHaveBeenCalled();
});
