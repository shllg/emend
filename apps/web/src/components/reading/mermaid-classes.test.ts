import { expect, test } from "vitest";
import { statechartClassColors, statechartClassCSS } from "./mermaid-classes.ts";

const groups = ["blue", "orange", "purple", "yellow", "teal", "tan", "pink"];
const names = [...groups, "breaks", "mayBreak", "bugPath", "repeats"];
const scopes = ["node", "cluster", "statediagram-cluster"];
const palettes = [
  { mode: "light", dark: false, surface: "#fdfdfe", text: "#111213" },
  { mode: "dark", dark: true, surface: "#111213", text: "#f4f4f6" },
];
const customPalettes = [
  { surface: "#777777", text: "#000000" },
  { surface: "#ffffff", text: "#767676" },
  { surface: "#202020", text: "#9a9a9a" },
];

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channels = [
      [1, 0.2126],
      [3, 0.7152],
      [5, 0.0722],
    ] as const;
    return channels.reduce((sum, [offset, weight]) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      return sum + weight * linear;
    }, 0);
  };
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test.each(palettes)("every class colours nodes, subgraphs and composite states in $mode", ({ dark, surface, text }) => {
  const colors = statechartClassColors(dark, surface, text);
  const css = statechartClassCSS(dark, surface, text);
  expect(css.split("\n")).toHaveLength(20);
  expect(colors.map((entry) => entry.name)).toEqual(names);
  for (const entry of colors) {
    for (const scope of scopes) {
      const selector = `.${scope}.${entry.name}:not([data-look=handDrawn])`;
      for (const shape of ["rect", "polygon", "circle", "ellipse", "path"]) {
        expect(css).toContain(`${selector} ${shape}`);
      }
      if (entry.text !== undefined) {
        expect(css).toContain(`${selector} text, ${selector} tspan`);
      }
    }
    expect(css).toContain(`.statediagram-cluster.${entry.name}:not([data-look=handDrawn]) rect.inner`);
    if (entry.text !== undefined) {
      expect(css).toContain(
        `.statediagram-cluster.${entry.name}:not([data-look=handDrawn]) tspan { fill: ${entry.text}; }`,
      );
    }
    for (const color of [entry.fill, entry.text, entry.stroke]) {
      if (color !== undefined) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  }
});

test.each(palettes)("CSS keeps group fills separate from border marks in $mode mode", ({ dark, surface, text }) => {
  const css = statechartClassCSS(dark, surface, text);
  const blue = dark ? "#59aaf8" : "#2b7ec9";
  const purple = dark ? "#ac8ff8" : "#8264c8";
  expect(css).toContain(
    `.statediagram-cluster.teal:not([data-look=handDrawn]) rect.inner { fill: ${dark ? "#224444" : "#cee8e8"}; }`,
  );
  expect(css).toContain(
    `.statediagram-cluster.bugPath:not([data-look=handDrawn]) rect.inner { stroke: ${blue}; stroke-width: 2.5px; }`,
  );
  expect(css).toContain(
    `.statediagram-cluster.repeats:not([data-look=handDrawn]) rect.inner { stroke: ${purple}; stroke-width: 2.5px; stroke-dasharray: 6 3; }`,
  );
  for (const scope of scopes) {
    expect(css).not.toContain(`.${scope}.bugPath:not([data-look=handDrawn]) text`);
    expect(css).not.toContain(`.${scope}.repeats:not([data-look=handDrawn]) text`);
  }
});

test.each([
  ...palettes,
  ...customPalettes.flatMap((palette) => [
    { ...palette, dark: false, mode: "light" },
    { ...palette, dark: true, mode: "dark" },
  ]),
])("class labels meet AA on $surface with $text in $mode mode", ({ dark, surface, text }) => {
  const pairs = statechartClassColors(dark, surface, text).filter(
    (entry) => entry.fill !== undefined && entry.text !== undefined,
  );
  expect(pairs).toHaveLength(9);
  for (const entry of pairs) {
    if (entry.fill === undefined || entry.text === undefined) throw new Error("Missing class colour pair");
    expect(contrast(entry.fill, entry.text), entry.name).toBeGreaterThanOrEqual(4.5);
  }
});

test.each(palettes)("groups preserve borders and marks set only their intended properties in $mode", (palette) => {
  const { dark, surface, text } = palette;
  const colors = statechartClassColors(dark, surface, text);
  for (const name of groups) {
    const entry = colors.find((color) => color.name === name);
    expect(entry).toEqual({ name, fill: expect.any(String), text });
  }
  for (const name of ["breaks", "mayBreak"]) {
    expect(colors.find((color) => color.name === name)).toEqual({
      name,
      fill: expect.any(String),
      text: expect.any(String),
      stroke: name === "breaks" ? (dark ? "#fa695e" : "#d33b36") : dark ? "#f98942" : "#e16c10",
      strokeWidth: "1.5px",
    });
  }
  expect(colors.find((color) => color.name === "bugPath")).toEqual({
    name: "bugPath",
    stroke: dark ? "#59aaf8" : "#2b7ec9",
    strokeWidth: "2.5px",
  });
  expect(colors.find((color) => color.name === "repeats")).toEqual({
    name: "repeats",
    stroke: dark ? "#ac8ff8" : "#8264c8",
    strokeWidth: "2.5px",
    dasharray: "6 3",
  });
});

test.each(palettes)("CSS orders group fills before fill marks before border marks in $mode", (palette) => {
  const css = statechartClassCSS(palette.dark, palette.surface, palette.text);
  for (const group of groups) {
    for (const mark of ["breaks", "mayBreak"]) {
      expect(css.indexOf(`.node.${mark}:not([data-look=handDrawn]) `)).toBeGreaterThan(
        css.lastIndexOf(`.statediagram-cluster.${group}:not([data-look=handDrawn]) `),
      );
    }
  }
  for (const mark of ["breaks", "mayBreak"]) {
    for (const border of ["bugPath", "repeats"]) {
      expect(css.indexOf(`.node.${border}:not([data-look=handDrawn]) `)).toBeGreaterThan(
        css.lastIndexOf(`.statediagram-cluster.${mark}:not([data-look=handDrawn]) `),
      );
    }
  }
});

test.each(palettes)("CSS omits !important so a diagram's classDef wins in $mode mode", (palette) => {
  expect(statechartClassCSS(palette.dark, palette.surface, palette.text)).not.toContain("!important");
});

test.each(palettes)("CSS contains no markup, escapes or URLs in $mode mode", (palette) => {
  const css = statechartClassCSS(palette.dark, palette.surface, palette.text);
  for (const forbidden of ["<", "\\", "url("]) expect(css).not.toContain(forbidden);
});

test.each(palettes)("classes outside the statechart list get no rules in $mode mode", (palette) => {
  const css = statechartClassCSS(palette.dark, palette.surface, palette.text);
  for (const scope of scopes) {
    for (const name of ["green", "maybreak", "bugpath"]) {
      expect(css).not.toMatch(new RegExp(`\\.${scope}\\.${name}:not\\(\\[data-look=handDrawn\\]\\) `));
    }
    const styled = new Set(
      [...css.matchAll(new RegExp(`\\.${scope}\\.([A-Za-z]+):not\\(\\[data-look=handDrawn\\]\\) `, "g"))].map(
        (match) => match[1],
      ),
    );
    expect([...styled]).toEqual(names);
  }
});

test.each(palettes)("hand-drawn nodes and clusters keep Mermaid's sketched fills in $mode mode", (palette) => {
  const css = statechartClassCSS(palette.dark, palette.surface, palette.text);
  for (const [, selectors = ""] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const selector of selectors.split(",").map((selector) => selector.trim())) {
      expect(selector).not.toContain("rough-node");
      expect(selector).toMatch(/^\.(?:node|cluster|statediagram-cluster)\.[A-Za-z]+:not\(\[data-look=handDrawn\]\) /);
    }
  }
});

test.each(palettes)(
  "hand-drawn nodes and clusters keep Mermaid's sketches while other looks get the colours in $mode mode",
  ({ dark, surface, text }) => {
    const css = statechartClassCSS(dark, surface, text);
    const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(([, list = ""]) =>
      list.split(",").map((selector) => selector.trim()),
    );
    const create = (tag: string, className = "") => {
      const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
      if (className) element.setAttribute("class", className);
      return element;
    };
    const svg = create("svg");
    for (const handDrawn of [true, false]) {
      for (const name of ["teal", "breaks"]) {
        for (const scope of handDrawn ? ["rough-node", ...scopes] : scopes) {
          const group = create("g", `${scope} ${name}${scope === "statediagram-cluster" ? " statediagram-state" : ""}`);
          group.setAttribute("data-look", handDrawn ? "handDrawn" : "neo");
          const label = create("text");
          label.append(create("tspan"));
          group.append(create("rect"), create("rect", "inner"), create("path"), create("polygon"), label);
          svg.append(group);
          for (const element of group.querySelectorAll(handDrawn ? "*" : "rect")) {
            expect(selectors.some((selector) => element.matches(selector))).toBe(!handDrawn);
          }
        }
      }
    }
  },
);

test.each(["red", "#fff", "#12345g", "#ABCDEF", "#123456;}", "#123456\n", "#123456 "])(
  "unchecked surface or text colours produce no entries or CSS: %j",
  (invalid) => {
    for (const dark of [false, true]) {
      for (const [surface, text] of [
        [invalid, "#111213"],
        ["#fdfdfe", invalid],
      ] as const) {
        expect(statechartClassColors(dark, surface, text)).toEqual([]);
        expect(statechartClassCSS(dark, surface, text)).toBe("");
      }
    }
  },
);

test.each([false, true])("unreadable theme pairs fall back to the plain theme colours (dark=%s)", (dark) => {
  for (const entry of statechartClassColors(dark, "#777777", "#777777")) {
    if (entry.fill !== undefined) expect(entry).toMatchObject({ fill: "#777777", text: "#777777" });
  }
});
