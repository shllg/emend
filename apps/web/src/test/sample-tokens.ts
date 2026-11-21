import { globSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type SampleView, THEME_TOKENS } from "@emend/contract";
import { DEFAULT_COLLAPSED_CONTEXT_THRESHOLD, parseDiffFromFile } from "@pierre/diffs";
import { SAMPLE_HTML } from "../../../../packages/core/src/sample/content.ts";

const web = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(web, path), "utf8");
function cssFiles(dir: string): string[] {
  return readdirSync(join(web, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? cssFiles(`${dir}/${entry.name}`)
      : entry.name.endsWith(".css")
        ? [`${dir}/${entry.name}`]
        : [],
  );
}
const sources = [...cssFiles("src/styles"), ...cssFiles("src/components")].map(read);
const references = (value: string) => [...value.matchAll(/var\(\s*--([\w-]+)/g)].map((match) => match[1] ?? "");
const tokens = new Set<string>(THEME_TOKENS);

// No emend element uses these tokens; remove a token as soon as an element uses it.
export const TOKENS_NO_ELEMENT_USES = ["agent-working", "agent-approved"] as const;

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type TokenReference = { path: string; line: number; reference: string };

/** Match supplied source text without reading files, including Tailwind aliases from @theme inline. */
export function findTokenReferencesInSource(
  token: string,
  source: string,
  theme: string,
  path = "synthetic",
): TokenReference[] {
  const name = escapePattern(token);
  const aliases = [...theme.matchAll(/@theme\s+inline\s*\{([^{}]*)\}/g)].flatMap((block) =>
    [...(block[1] ?? "").matchAll(/--color-([\w-]+)\s*:\s*var\(\s*--([\w-]+)\s*\)/g)].flatMap((match) =>
      match[1] && match[2] === token ? [escapePattern(match[1])] : [],
    ),
  );
  const patterns = [
    `var\\(\\s*--${name}(?=\\s*[,)])`,
    `(["'\`])(?:--)?${name}\\1`,
    `[\\w-]+-\\((?:\\w+:)?--${name}\\)`,
  ];
  if (aliases.length)
    patterns.push(
      `(?<![\\w-])(?:bg|text|border(?:-[xysetrbl])?|outline|ring(?:-offset)?|inset-ring|decoration|fill|stroke|divide|placeholder|caret|accent|(?:inset-|text-)?shadow|from|via|to)-(?:${aliases.join("|")})(?![\\w-])`,
    );

  const definition =
    path === "src/styles/colors.css" ? `--${name}` : path === "src/styles/theme.css" ? `--color-${name}` : null;
  // Mask only this token's own definition/alias, preserving line numbers and other uses in these files.
  const searchable = definition
    ? source.replace(new RegExp(`${definition}\\s*:[^;{}]*;`, "g"), (value) => value.replace(/[^\n]/g, " "))
    : source;
  return [...searchable.matchAll(new RegExp(patterns.join("|"), "g"))].map((match) => ({
    path,
    line: searchable.slice(0, match.index).split("\n").length,
    reference: match[0],
  }));
}

export function findWebTokenReferences(token: string): TokenReference[] {
  const theme = read("src/styles/theme.css");
  return globSync(["src/**/*.{ts,tsx,css}", "pub-frame.css", "mermaid-frame.ts"], {
    cwd: web,
    exclude: ["src/**/*.test.*", "src/test/**"],
  })
    .sort()
    .flatMap((path) => findTokenReferencesInSource(token, read(path), theme, path));
}

/** Read leaf rules through @layer/@media wrappers; declarations alone never count as usage. */
function rules(source: string): { selector: string; body: string }[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match) => {
    const selector = match[1]?.trim() ?? "";
    return selector.startsWith("@") ? [] : [{ selector, body: match[2] ?? "" }];
  });
}
function stripPseudos(selector: string): string {
  let result = "";
  for (let i = 0; i < selector.length; ) {
    if (selector[i] !== ":") {
      result += selector[i++];
      continue;
    }
    const match = /^::?([\w-]+)/.exec(selector.slice(i));
    if (!match) {
      result += selector[i++];
      continue;
    }
    i += match[0].length;
    if (selector[i] !== "(") continue;
    const start = ++i;
    let depth = 1;
    while (i < selector.length && depth) {
      if (selector[i] === "(") depth++;
      if (selector[i] === ")") depth--;
      i++;
    }
    if (match[1] === "is" || match[1] === "where") {
      const inside = stripPseudos(selector.slice(start, i - 1))
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      if (inside.length) result += `:${match[1]}(${inside.join(",")})`;
    }
  }
  return result;
}
function selectorMatches(root: ParentNode, selector: string): boolean {
  const clean = stripPseudos(selector).trim() || "*";
  try {
    return !!root.querySelector(clean);
  } catch {
    return false;
  }
}

function sampleHasSeparator(sample: SampleView): boolean {
  return sample.revision.files.some((file) => {
    const texts = sample.fileTexts[file.id];
    if (file.role !== "diff" || !texts) return false;
    const diff = parseDiffFromFile(
      file.hasOld ? { name: file.oldPath ?? file.path, contents: texts.old } : null,
      file.hasNew ? { name: file.path, contents: texts.new } : null,
    );
    const last = diff.hunks.at(-1);
    const collapsedAfter = last ? diff.additionLines.length - last.additionLineIndex - last.additionCount : 0;
    // FileDiff keeps expandUnchanged false; Pierre expands tiny context gaps by default.
    return (
      diff.hunks.some((hunk) => hunk.collapsedBefore > DEFAULT_COLLAPSED_CONTEXT_THRESHOLD) ||
      collapsedAfter > DEFAULT_COLLAPSED_CONTEXT_THRESHOLD
    );
  });
}

export function collectSampleTokens(root: Document, sample: SampleView): Set<string> {
  const definitions = new Map<string, Set<string>>();
  for (const source of sources)
    for (const [, key, value] of source.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
      if (!key || value === undefined) continue;
      const name = key.slice(2);
      const refs = definitions.get(name) ?? new Set();
      for (const ref of references(value)) refs.add(ref);
      definitions.set(name, refs);
    }
  const used = new Set<string>();
  const visit = (name: string, seen = new Set<string>()) => {
    if (seen.has(name)) return;
    seen.add(name);
    if (tokens.has(name)) {
      used.add(name);
      return;
    }
    for (const ref of definitions.get(name) ?? []) visit(ref, seen);
  };
  const collectValue = (value: string) => {
    for (const name of references(value)) visit(name);
  };
  const scan = (dom: ParentNode, css: string[]) => {
    for (const element of dom.querySelectorAll("*")) {
      collectValue(element.getAttribute("style") ?? "");
      for (const cls of element.classList) {
        collectValue(cls.replaceAll("_", " "));
        // Parenthesized shorthand, including text-(--fg-link), is Tailwind's var() form.
        for (const [, name] of cls.matchAll(/\(--([\w-]+)\)/g)) if (name) visit(name);
        // The last colon outside brackets ends a variant; arbitrary selectors can contain colons too.
        const utility = cls.slice(cls.lastIndexOf(":") + 1).split("/")[0] ?? "";
        const match =
          /^(?:bg|text|border|outline|ring|inset-ring|decoration|fill|stroke|divide|placeholder|caret|accent)-(.+)$/.exec(
            utility,
          );
        if (match?.[1]) visit(`color-${match[1]}`);
      }
    }
    for (const source of css)
      for (const rule of rules(source)) {
        if (!selectorMatches(dom, rule.selector)) continue;
        for (const declaration of rule.body.split(";")) {
          const colon = declaration.indexOf(":");
          if (colon === -1 || declaration.trimStart().startsWith("--")) continue;
          collectValue(declaration.slice(colon + 1));
        }
      }
  };
  // pub.css belongs only to the isolated document, never the app DOM.
  scan(
    root,
    sources.filter(
      (_, index) => ![...cssFiles("src/styles"), ...cssFiles("src/components")][index]?.endsWith("/pub.css"),
    ),
  );
  if (root.querySelector('iframe[src="/mermaid-frame.html"]'))
    for (const [, name] of read("src/components/reading/mermaid-colors.ts").matchAll(/"--([\w-]+)"/g))
      if (name) visit(name);
  const texts = Object.values(sample.fileTexts);
  const changed = texts.some((file) => file.old && file.new && file.old !== file.new);
  const additions = texts.some((file) => file.new && file.old !== file.new);
  const deletions = texts.some((file) => file.old && file.old !== file.new);
  if (root.querySelector(".em-diff-host") && changed && additions && deletions) {
    const separator = sampleHasSeparator(sample);
    for (const rule of rules(read("src/components/diff/shadow.ts")))
      if (separator || !rule.selector.includes("[data-separator")) collectValue(rule.body);
    collectValue(read("src/components/diff/theme.ts"));
    // Pierre consumes these override properties inside its shadow root.
    for (const rule of rules(read("src/styles/diff.css")))
      if (selectorMatches(root, rule.selector))
        for (const [, name, value] of rule.body.matchAll(/(--diffs-[\w-]+)\s*:\s*([^;]+)/g))
          if (separator || name !== "--diffs-bg-separator-override") collectValue(value ?? "");
  }
  if (root.querySelector('iframe[src^="/content/sample/"]')) {
    const doc = new DOMParser().parseFromString(SAMPLE_HTML, "text/html");
    const imports = [...read("pub-frame.css").matchAll(/@import "\.\/([^";]+)"/g)].flatMap((match) =>
      match[1] ? [read(match[1])] : [],
    );
    scan(doc, imports);
  }
  return used;
}
