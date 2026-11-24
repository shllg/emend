import type { ThemeValid } from "@recense/contract";

export const customTheme: ThemeValid = {
  valid: true,
  name: "mine",
  base: "dark",
  fonts: { text: "Example Sans", code: "Example Mono" },
  scales: { "n-950": "#112233" },
  tokens: { "bg-app": "n-950", "fg-1": "#eeeeee" },
  themeColor: "#112233",
};
