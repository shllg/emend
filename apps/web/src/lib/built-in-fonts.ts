type BuiltInFont = {
  family: string;
  role: "text" | "code";
  slug: string;
  weight: readonly [number, number];
  italic: boolean;
  default: boolean;
};

export const BUILT_IN_FONTS = [
  { family: "Geist", role: "text", slug: "geist", weight: [100, 900], italic: true, default: true },
  { family: "Inter", role: "text", slug: "inter", weight: [100, 900], italic: true, default: false },
  { family: "Roboto", role: "text", slug: "roboto", weight: [100, 900], italic: true, default: false },
  {
    family: "Atkinson Hyperlegible Next",
    role: "text",
    slug: "atkinson-hyperlegible-next",
    weight: [200, 800],
    italic: true,
    default: false,
  },
  { family: "JetBrains Mono", role: "code", slug: "jetbrains-mono", weight: [100, 800], italic: true, default: true },
  { family: "Geist Mono", role: "code", slug: "geist-mono", weight: [100, 900], italic: true, default: false },
  { family: "Roboto Mono", role: "code", slug: "roboto-mono", weight: [100, 700], italic: true, default: false },
  { family: "Fira Code", role: "code", slug: "fira-code", weight: [300, 700], italic: false, default: false },
] as const satisfies readonly BuiltInFont[];

const defaultSlugs = BUILT_IN_FONTS.filter((font) => font.default).map((font) => font.slug);

/** Keep optional fonts out of the shell cache so they download only when used. */
export function shouldPrecacheAsset(fileName: string): boolean {
  if (!fileName.endsWith(".woff2")) return true;
  const basename = fileName.slice(fileName.lastIndexOf("/") + 1);
  return defaultSlugs.some((slug) => basename.startsWith(`${slug}-latin-`));
}
