const colorTokens = {
  background: "--bg-sunken",
  surface: "--bg-surface",
  text: "--fg-1",
  text2: "--fg-2",
  line: "--fg-3",
  border: "--border-2",
  accentBg: "--topic-bg-2",
  accent: "--topic-solid",
} as const;
export type MermaidColors = Record<keyof typeof colorTokens, string>;

/** Read after the theme has been applied, when the frame loads. */
export function readMermaidColors(): MermaidColors | undefined {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { colorSpace: "srgb", alpha: false });
    if (!context) return;
    const computed = getComputedStyle(document.documentElement);
    const values = Object.fromEntries(
      Object.entries(colorTokens).map(([key, token]) => [key, computed.getPropertyValue(token).trim()]),
    ) as MermaidColors;
    const fill = (value: string) => {
      if (!value) throw new Error("Missing colour");
      // An invalid canvas colour leaves fillStyle unchanged. Two sentinels also accept either sentinel as input.
      context.fillStyle = "#010203";
      context.fillStyle = value;
      if (context.fillStyle === "#010203") {
        context.fillStyle = "#040506";
        context.fillStyle = value;
        if (context.fillStyle === "#040506") throw new Error("Invalid colour");
      }
      context.fillRect(0, 0, 1, 1);
    };
    const hex = () => {
      const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
      if (r === undefined || g === undefined || b === undefined || alpha !== 255) throw new Error("Invalid pixel");
      return `#${[r, g, b].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    };
    fill(values.background);
    const background = hex();
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        if (key === "background") return [key, background];
        fill(background);
        fill(value);
        return [key, hex()];
      }),
    ) as MermaidColors;
  } catch {
    // Missing canvas support or an unconvertible token keeps the frame's built-in palette.
    return;
  }
}
