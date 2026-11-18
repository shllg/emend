import type { SyntaxRole } from "@emend/contract";
import type { ThemeRegistration } from "shiki/core";

export const syntaxColors = {
  plain: "var(--syn-plain)",
  keyword: "var(--syn-keyword)",
  type: "var(--syn-type)",
  function: "var(--syn-function)",
  string: "var(--syn-string)",
  number: "var(--syn-number)",
  comment: "var(--syn-comment)",
  punct: "var(--syn-punct)",
  inserted: "var(--diff-add-fg)",
  deleted: "var(--diff-del-fg)",
} as const satisfies Record<SyntaxRole, string>;

const colorRoles = new Map<string, SyntaxRole>(
  (Object.keys(syntaxColors) as SyntaxRole[]).map((role) => [syntaxColors[role], role]),
);
export function syntaxRole(color: string | undefined): SyntaxRole {
  return colorRoles.get(color ?? "") ?? "plain";
}
const rule = (scope: string[], role: SyntaxRole, fontStyle = "") => ({
  scope,
  settings: { foreground: syntaxColors[role], fontStyle },
});

// Keep the token rules in step with apps/web/src/components/diff/theme.ts.
export const syntaxTheme = {
  name: "emend",
  type: "dark",
  colors: { "editor.foreground": syntaxColors.plain, "editor.background": "var(--bg-sunken)" },
  tokenColors: [
    rule(["keyword", "storage"], "keyword"),
    rule(
      ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class"],
      "type",
    ),
    rule(["entity.name.function", "support.function", "variable.function"], "function"),
    rule(["variable", "meta.property-name", "support.type.property-name", "entity.other.attribute-name"], "plain"),
    rule(["variable.parameter"], "plain"),
    rule(["constant", "variable.other.constant"], "number"),
    rule(["string", "entity.name.tag"], "string"),
    rule(["punctuation", "keyword.operator"], "punct"),
    rule(["comment", "string.quoted.docstring.multi"], "comment", "italic"),
    rule(["markup.heading"], "plain", "bold"),
    rule(["strong", "markup.bold"], "plain", "bold"),
    rule(["emphasis", "markup.italic"], "plain", "italic"),
    rule(
      ["markup.inline", "markup.raw", "markup.fenced_code", "markup.underline.link", "meta.link", "string.other.link"],
      "string",
    ),
    rule(["punctuation.definition.list", "beginning.punctuation.definition.list"], "punct"),
    rule(["markup.inserted"], "inserted"),
    rule(["markup.deleted"], "deleted"),
  ],
} satisfies ThemeRegistration;
