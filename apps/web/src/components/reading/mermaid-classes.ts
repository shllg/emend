export type ClassColor = {
  name: string;
  fill?: string;
  text?: string;
  stroke?: string;
  strokeWidth?: string;
  dasharray?: string;
};

// Defaults avoid !important so a diagram's classDef can override its class colours.
const anchors = {
  blue: ["#2b7ec9", "#59aaf8"],
  orange: ["#e16c10", "#f98942"],
  purple: ["#8264c8", "#ac8ff8"],
  yellow: ["#f4ce23", "#ebc831"],
  teal: ["#129390", "#4ab8b5"],
  tan: ["#aa845e", "#bf9d7d"],
  pink: ["#db5fa1", "#f080b8"],
} as const;

function parse(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function mix(a: string, b: string, amount: number): string {
  const from = parse(a);
  const to = parse(b);
  const channels = ([0, 1, 2] as const).map((index) =>
    Math.round(from[index] + (to[index] - from[index]) * amount)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${channels.join("")}`;
}

function luminance(hex: string): number {
  const linear = (byte: number) => {
    const value = byte / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const [red, green, blue] = parse(hex);
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function readablePair(
  surface: string,
  text: string,
  anchor: string,
  fillAmount: number,
  textAmount: number,
): { fill: string; text: string } {
  for (let fillStep = 0; fillStep <= Math.ceil(fillAmount * 20); fillStep++) {
    const fill = mix(surface, anchor, Math.max(0, fillAmount - fillStep / 20));
    for (let textStep = Math.round(textAmount * 10); textStep >= 0; textStep--) {
      const foreground = mix(text, anchor, textStep / 10);
      if (contrast(fill, foreground) >= 4.5) return { fill, text: foreground };
    }
  }
  // Theme checks refuse a theme whose text is below 4.5 to 1 on bg-surface, so this pair stays readable.
  return { fill: surface.toLowerCase(), text: text.toLowerCase() };
}

export function statechartClassColors(dark: boolean, surface: string, text: string): ClassColor[] {
  // The CSS goes into the diagram frame, so it takes only checked colours.
  const hex = /^#[0-9a-f]{6}$(?![\s\S])/;
  if (!hex.test(surface) || !hex.test(text)) return [];
  const mode = dark ? 1 : 0;
  const red = dark ? "#fa695e" : "#d33b36";
  // sRGB anchors from colors.css: green-600/400 and ochre-600/400.
  const green = dark ? "#53be70" : "#218041";
  const amber = dark ? "#f5af2e" : "#ba7419";
  const orange = anchors.orange[mode];
  const markAmount = dark ? 0.4 : 0.28;
  return [
    ...Object.entries(anchors).map(([name, hues]) => ({
      name,
      ...readablePair(surface, text, hues[mode], dark ? 0.3 : 0.2, 0),
    })),
    {
      name: "breaks",
      ...readablePair(surface, text, red, markAmount, 0.6),
      stroke: red,
      strokeWidth: "1.5px",
    },
    {
      name: "mayBreak",
      ...readablePair(surface, text, orange, markAmount, 0.6),
      stroke: orange,
      strokeWidth: "1.5px",
    },
    {
      name: "added",
      ...readablePair(surface, text, green, markAmount, 0.6),
      stroke: green,
      strokeWidth: "1.5px",
    },
    {
      name: "changed",
      ...readablePair(surface, text, amber, markAmount, 0.6),
      stroke: amber,
      strokeWidth: "1.5px",
    },
    {
      name: "removed",
      ...readablePair(surface, text, red, markAmount, 0.6),
      stroke: red,
      strokeWidth: "1.5px",
      dasharray: "5 3",
    },
    { name: "bugPath", stroke: anchors.blue[mode], strokeWidth: "2.5px" },
    { name: "repeats", stroke: anchors.purple[mode], strokeWidth: "2.5px", dasharray: "6 3" },
  ];
}

export function statechartClassCSS(dark: boolean, surface: string, text: string): string {
  return statechartClassColors(dark, surface, text)
    .flatMap((color) => {
      // Roughjs draws hand-drawn fills as hatch strokes, so CSS would smear them.
      // Mermaid marks groups data-look=handDrawn; most hand-drawn nodes are also rough-node.
      const scopes = [
        `.node.${color.name}:not([data-look=handDrawn])`,
        `.cluster.${color.name}:not([data-look=handDrawn])`,
        `.statediagram-cluster.${color.name}:not([data-look=handDrawn])`,
      ];
      const shapes = scopes
        .flatMap((scope) => ["rect", "polygon", "circle", "ellipse", "path"].map((shape) => `${scope} ${shape}`))
        .concat(`.statediagram-cluster.${color.name}:not([data-look=handDrawn]) rect.inner`)
        .join(", ");
      const declarations = [
        color.fill && `fill: ${color.fill};`,
        color.stroke && `stroke: ${color.stroke};`,
        color.strokeWidth && `stroke-width: ${color.strokeWidth};`,
        color.dasharray && `stroke-dasharray: ${color.dasharray};`,
      ]
        .filter(Boolean)
        .join(" ");
      const rules = [`${shapes} { ${declarations} }`];
      if (color.text) {
        const labels = scopes.flatMap((scope) => [`${scope} text`, `${scope} tspan`]).join(", ");
        rules.push(`${labels} { fill: ${color.text}; }`);
      }
      return rules;
    })
    .join("\n");
}
