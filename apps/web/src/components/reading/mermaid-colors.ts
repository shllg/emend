// Backdrops precede the colours drawn over them, so every blend uses an opaque sRGB colour.
const colorTokens = {
  background: ["--bg-sunken", null],
  surface: ["--bg-surface", "background"],
  accentBg: ["--topic-bg-2", "background"],
  text: ["--fg-1", "background"],
  text2: ["--fg-2", "background"],
  line: ["--fg-3", "background"],
  border: ["--border-2", "background"],
  accent: ["--topic-solid", "background"],
  nodeText: ["--fg-1", "surface"],
  noteText: ["--fg-1", "accentBg"],
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
    const colors = {} as MermaidColors;
    for (const [key, [token, backdrop]] of Object.entries(colorTokens)) {
      if (backdrop) fill(colors[backdrop]);
      fill(computed.getPropertyValue(token).trim());
      colors[key as keyof MermaidColors] = hex();
    }
    return colors;
  } catch {
    // Missing canvas support or an unconvertible token keeps the frame's built-in palette.
    return;
  }
}
