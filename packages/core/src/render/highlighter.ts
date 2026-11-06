import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

async function createHighlighter() {
  // Explicit imports keep the server bundle to these grammars and the JavaScript engine.
  return createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    langs: [
      import("shiki/langs/ts.mjs"),
      import("shiki/langs/tsx.mjs"),
      import("shiki/langs/js.mjs"),
      import("shiki/langs/jsx.mjs"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/css.mjs"),
      import("shiki/langs/html.mjs"),
      import("shiki/langs/md.mjs"),
      import("shiki/langs/yaml.mjs"),
      import("shiki/langs/sh.mjs"),
      import("shiki/langs/go.mjs"),
      import("shiki/langs/py.mjs"),
      import("shiki/langs/sql.mjs"),
      import("shiki/langs/diff.mjs"),
    ],
  });
}
let highlighterPromise: ReturnType<typeof createHighlighter> | undefined;
export function sharedHighlighter() {
  highlighterPromise ??= createHighlighter().catch((error: unknown) => {
    highlighterPromise = undefined;
    throw error;
  });
  return highlighterPromise;
}
