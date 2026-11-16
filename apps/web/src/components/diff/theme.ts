import { createCSSVariablesTheme, registerCustomCSSVariableTheme, registerCustomTheme } from "@pierre/diffs";

const name = "emend";
export const syntaxVariables = {
  foreground: "var(--syn-plain)",
  background: "var(--bg-surface)",
  "token-keyword": "var(--syn-keyword)",
  "token-type": "var(--syn-type)",
  "token-function": "var(--syn-function)",
  "token-string": "var(--syn-string)",
  "token-string-expression": "var(--syn-string)",
  "token-constant": "var(--syn-number)",
  "token-comment": "var(--syn-comment)",
  "token-punctuation": "var(--syn-punct)",
  "token-parameter": "var(--syn-plain)",
  "token-link": "var(--syn-string)",
  "token-heading": "var(--syn-plain)",
  "token-inserted": "var(--diff-add-fg)",
  "token-deleted": "var(--diff-del-fg)",
  "token-changed": "var(--syn-plain)",
};
export const diffTheme = createCSSVariablesTheme({ name, variableDefaults: syntaxVariables, fontStyle: true });
const variable = (key: keyof typeof syntaxVariables) => `var(--diffs-${key}, ${syntaxVariables[key]})`;
const rule = (scope: string[], key: keyof typeof syntaxVariables, fontStyle = "") => ({
  scope,
  settings: { foreground: variable(key), fontStyle },
});

// The stock Shiki CSS-variable scopes conflate types/functions and properties/constants.
// Register a TextMate specialization under the SAME name; shiki-js prefers it over the
// shared descriptor. Both resolve on the main thread and travel in resolvedThemes.
export const syntaxTheme = {
  name,
  type: "dark" as const,
  colors: diffTheme.colors,
  tokenColors: [
    rule(["keyword", "storage"], "token-keyword"),
    rule(
      ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class"],
      "token-type",
    ),
    rule(["entity.name.function", "support.function", "variable.function"], "token-function"),
    rule(["variable", "meta.property-name", "support.type.property-name", "entity.other.attribute-name"], "foreground"),
    rule(["variable.parameter"], "token-parameter"),
    rule(["constant", "variable.other.constant"], "token-constant"),
    rule(["string", "entity.name.tag"], "token-string-expression"),
    rule(["punctuation", "keyword.operator"], "token-punctuation"),
    rule(["comment", "string.quoted.docstring.multi"], "token-comment", "italic"),
    rule(["markup.heading"], "token-heading", "bold"),
    rule(["strong", "markup.bold"], "foreground", "bold"),
    rule(["emphasis", "markup.italic"], "foreground", "italic"),
    rule(
      ["markup.inline", "markup.raw", "markup.fenced_code", "markup.underline.link", "meta.link", "string.other.link"],
      "token-link",
    ),
    rule(["punctuation.definition.list", "beginning.punctuation.definition.list"], "token-punctuation"),
    rule(["markup.inserted"], "token-inserted"),
    rule(["markup.deleted"], "token-deleted"),
  ],
};
registerCustomCSSVariableTheme(name, syntaxVariables, true);
registerCustomTheme(name, () => Promise.resolve(syntaxTheme));
