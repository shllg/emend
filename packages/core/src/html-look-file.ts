import {
  pubStylesheetSafe,
  THEME_SCALE_STEPS,
  THEME_TOKENS,
  type ThemeBase,
  ThemeColor,
  ThemeScaleStep,
} from "@recense/contract";

export const HTML_LOOK_FILE_LAYER = "recense-file";
export type HtmlLookTheme = {
  base: ThemeBase;
  scales: Record<string, string>;
  tokens: Record<string, string>;
};

/** Keep the leading doctype and parser-ignored preamble ahead of the look. */
export function htmlLookInsertAt(html: string): number {
  let at = html.startsWith("\uFEFF") ? 1 : 0;
  let doctype = false;
  while (at < html.length) {
    const space = /^[\t\n\f\r ]+/.exec(html.slice(at));
    if (space) {
      at += space[0].length;
      continue;
    }
    if (html.startsWith("<!--", at)) {
      const content = at + 4;
      if (html[content] === ">") at = content + 1;
      else if (html.startsWith("->", content)) at = content + 2;
      else {
        const end = /--!?>/g;
        end.lastIndex = content;
        const match = end.exec(html);
        if (!match) break;
        at = match.index + match[0].length;
      }
      continue;
    }
    const declaration = /^<!doctype/i.test(html.slice(at));
    if (declaration && !doctype) {
      const end = html.indexOf(">", at + 9);
      if (end < 0) break;
      at = end + 1;
      doctype = true;
      continue;
    }
    if (
      html.startsWith("<?", at) ||
      (html.startsWith("<!", at) && !declaration) ||
      (html.startsWith("</", at) && at + 2 < html.length && !/[a-z]/i.test(html[at + 2] ?? ""))
    ) {
      const end = html.indexOf(">", at + 2);
      if (end < 0) break;
      at = end + 1;
      continue;
    }
    break;
  }
  return at;
}

/** Only known, checked colours and scale references can enter raw style text. */
export function htmlLookThemeVars(theme: HtmlLookTheme): string {
  let vars = "";
  for (const name of THEME_SCALE_STEPS) {
    if (!Object.hasOwn(theme.scales, name)) continue;
    const value = theme.scales[name];
    if (ThemeColor.safeParse(value).success) vars += `--${name}:${value};`;
  }
  for (const name of THEME_TOKENS) {
    if (!Object.hasOwn(theme.tokens, name)) continue;
    const value = theme.tokens[name];
    if (ThemeColor.safeParse(value).success) vars += `--${name}:${value};`;
    else if (ThemeScaleStep.safeParse(value).success) vars += `--${name}:var(--${value});`;
  }
  return vars;
}

export function htmlLookThemeRules(theme: HtmlLookTheme): string {
  const vars = htmlLookThemeVars(theme);
  return theme.base === "dark"
    ? `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${vars}}}:root[data-theme=dark]{${vars}}`
    : `@media not all and (prefers-color-scheme:dark){:root:not([data-theme=dark]){${vars}}}:root[data-theme=light]{${vars}}`;
}

const lightStart = '<html data-theme="light">';
const marker = '<meta charset="utf-8"><style data-recense-look>';
// The chunk `emend look` wrote before the rename; stripping it keeps a re-run from stacking a second look.
const legacyMarker = '<meta charset="utf-8"><style data-emend-look>';

export function stripHtmlLook(html: string): string {
  const at = htmlLookInsertAt(html);
  const present = [marker, legacyMarker].some(
    (candidate) => html.startsWith(candidate, at) || html.startsWith(lightStart + candidate, at),
  );
  if (!present) return html;
  const close = html.indexOf("</", at);
  if (close < 0 || !html.startsWith("</style>", close)) return html;
  let end = close + "</style>".length;
  if (html[end] === "\n") end++;
  return html.slice(0, at) + html.slice(end);
}

export function applyHtmlLook(html: string, input: { css: string; lightOnly: boolean; theme?: HtmlLookTheme }): string {
  if (!pubStylesheetSafe(input.css)) throw new Error("Unsafe pub stylesheet");
  const stripped = stripHtmlLook(html);
  const at = htmlLookInsertAt(stripped);
  const chunk = `${input.lightOnly ? lightStart : ""}${marker}@layer ${HTML_LOOK_FILE_LAYER}{${input.css}${input.theme ? htmlLookThemeRules(input.theme) : ""}}</style>\n`;
  return stripped.slice(0, at) + chunk + stripped.slice(at);
}
