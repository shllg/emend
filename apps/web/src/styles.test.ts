// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pubStylesheetSafe } from "@recense/contract";
import { expect, test } from "vitest";
import { BUILT_IN_FONTS } from "./lib/built-in-fonts.ts";
import { readingMeasure } from "./lib/layout-store.ts";

const webSource = fileURLToPath(new URL(".", import.meta.url));
const webLicenses = fileURLToPath(new URL("../public/licenses/", import.meta.url));
const webFonts = join(webSource, "fonts");
const fontSources = BUILT_IN_FONTS.flatMap((font) =>
  ["latin-wght-normal", "latin-ext-wght-normal", ...(font.italic ? ["latin-wght-italic"] : [])].map((suffix) => ({
    font,
    file: `${font.slug}-${suffix}.woff2`,
  })),
);
const fontFiles = fontSources.map(({ file }) => file);
const fontLicenses = BUILT_IN_FONTS.map((font) => `${font.slug}-OFL.txt`);
const pubFontFiles = fontSources
  .filter(({ font, file }) => font.default && file !== "jetbrains-mono-latin-wght-italic.woff2")
  .map(({ file }) => file);

test("automatic dark styles skip explicit Light and retain their explicit Dark copies", () => {
  for (const name of ["colors", "spacing", "prose"]) {
    const css = readFileSync(join(webSource, `styles/${name}.css`), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const media = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(css)?.[1];
    expect(media, name).toBeTruthy();
    for (const rule of media?.matchAll(/([^{}]+)\{([^}]+)\}/g) ?? []) {
      const selectors = rule[1]?.trim().split(/,\s*/);
      expect(selectors?.length).toBeGreaterThan(0);
      for (const selector of selectors ?? []) {
        expect(selector).toMatch(/^:root:not\(\[data-theme="light"\]\)/);
        const explicit = selector.replace(':root:not([data-theme="light"])', '[data-theme="dark"]');
        expect(css).toContain(explicit);
      }
    }
    // Removing only the guarded root prefix and whitespace leaves the original dark rules.
    const normalize = (value: string) => value.replace(/\s+/g, "").replace("color-scheme:dark;", "");
    const explicit = css.slice(css.indexOf('[data-theme="dark"]'));
    const expected = normalize((media ?? "").replaceAll(':root:not([data-theme="light"])', '[data-theme="dark"]'));
    expect(normalize(explicit).startsWith(expected), name).toBe(true);
  }
  const colors = readFileSync(join(webSource, "styles/colors.css"), "utf8");
  expect(colors).toMatch(/\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;/);
});

function webStylesheets() {
  return readdirSync(webSource, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".css"))
    .map((path) => ({
      path: join(webSource, path),
      css: readFileSync(join(webSource, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
    }));
}

function cssUrls(css: string) {
  const matches = [...css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)];
  expect(matches).toHaveLength([...css.matchAll(/url\(/gi)].length);
  return matches.map((match) => match[2]?.trim() ?? "");
}

test("inbox arrival fades the accent tint for one second only when reduced motion is not requested", () => {
  const css = readFileSync(join(webSource, "styles.css"), "utf8");
  expect(css).toMatch(
    /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{\s*\.em-inbox-new\s*\{\s*animation:\s*inbox-arrival 1s ease-out;/,
  );
  expect(css).toMatch(
    /@keyframes inbox-arrival\s*\{\s*from\s*\{\s*background-color:\s*var\(--accent-tint\);\s*\}\s*to\s*\{\s*background-color:\s*transparent;/,
  );
});

test("reduced motion runs every animation once in 1 ms and cuts transitions to 1 ms", () => {
  const css = readFileSync(join(webSource, "styles/base.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*\s*\{([^}]+)\}/.exec(css)?.[1];
  expect(rule).toContain("animation-duration: 1ms !important;");
  expect(rule).toContain("animation-iteration-count: 1 !important;");
  expect(rule).toContain("transition-duration: 1ms !important;");
});

test("change bars define their base and continuation offsets in the components stylesheet", () => {
  const css = readFileSync(join(webSource, "styles/reading.css"), "utf8");
  expect(css).toMatch(/^@layer components\s*\{/);
  const base = /\.em-reading-block__change\s*\{([^}]+)\}/.exec(css)?.[1];
  expect(base).toMatch(/\btop:\s*0\s*;/);
  expect(base).toMatch(/\bbottom:\s*0\s*;/);
  const continuation =
    /\.em-reading-block\[data-change-continuation\]\s*>\s*\.em-reading-block__change\s*\{([^}]+)\}/.exec(css)?.[1];
  expect(continuation).toMatch(/\btop:\s*calc\(-1\s*\*\s*var\(--reading-block-gap\)\)\s*;/);
});

test("topic metadata wraps whole desktop items and keeps the phone spacing", () => {
  const css = readFileSync(join(webSource, "styles/diff.css"), "utf8");
  const desktop = /\.em-topic-meta\s*\{([^}]+)\}/.exec(css)?.[1];
  expect(desktop).toMatch(/flex-wrap:\s*wrap;/);
  expect(desktop).toMatch(/row-gap:\s*2px;/);
  expect(desktop).toMatch(/white-space:\s*nowrap;/);
  expect(desktop).toMatch(/overflow:\s*hidden;/);
  const phone = /\.em-diff-topic\[data-phone\] \.em-topic-meta\s*\{([^}]+)\}/.exec(css)?.[1];
  expect(phone).toMatch(/flex-wrap:\s*wrap;/);
  expect(phone).toMatch(/white-space:\s*normal;/);
  expect(phone).toMatch(/overflow:\s*visible;/);
  expect(phone).toMatch(/row-gap:\s*4px;/);
});

test("each proof contains its floated kind so later lines can use the full measure", () => {
  const css = readFileSync(join(webSource, "styles/reading.css"), "utf8");
  const proof = /\.em-proof\s*\{([^}]+)\}/.exec(css)?.[1];
  const label = /\.em-proof-kind\s*\{([^}]+)\}/.exec(css)?.[1];
  expect(proof).toMatch(/display:\s*flow-root;/);
  expect(label).toMatch(/float:\s*inline-start;/);
  expect(label).toMatch(/position:\s*relative;/);
  expect(label).toMatch(/z-index:\s*1;/);
  expect(label).toMatch(/margin-inline-end:\s*var\(--space-2\);/);
});

test("changed files keep the unviewed checkbox look", () => {
  const css = readFileSync(join(webSource, "styles/files.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css).not.toMatch(/\[data-stale[^\]]*\][^{}]*\.em-viewed-mark__box\b[^{}]*\{/);
  const media = /@media\s*\(max-width:\s*767px\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(css);
  expect(media).not.toBeNull();
  const labelRule = /\.em-viewed-mark\[data-stale\] \.em-viewed-mark__label\s*\{([^}]+)\}/;
  expect(labelRule.exec(media?.[1] ?? "")?.[1]).toMatch(/\bdisplay:\s*none\s*;/);
  const hiddenLabel = /\.em-viewed-mark__label\b[^{}]*\{[^{}]*\bdisplay:\s*none\b/;
  expect(css.replace(media?.[0] ?? "", "")).not.toMatch(hiddenLabel);
  expect(media?.[1]?.replace(labelRule, "")).not.toMatch(hiddenLabel);
});

test("the reading column grows with the pane up to the chosen reading width on desktop and keeps its phone measure", () => {
  const css = readFileSync(join(webSource, "styles/reading.css"), "utf8");
  expect(/\.em-reading-column\s*\{([^}]+)\}/.exec(css)?.[1]).toMatch(/--reading-max:\s*68ch\s*;/);
  expect(css).toMatch(/@media \(min-width: 768px\)[\s\S]*--reading-max: var\(--reader-measure, 1024px\);/);
  expect(css).toMatch(/max-width:\s*calc\(var\(--reading-max\)\s*\+\s*112px\)/);
  expect(css).not.toMatch(/68ch\s*\+|-\s*68ch/);
  const prose = readFileSync(join(webSource, "styles/prose.css"), "utf8");
  expect(/\.em-prose\s*\{([^}]+)\}/.exec(prose)?.[1]).toMatch(/max-width:\s*var\(--reading-max,\s*68ch\)\s*;/);
});

test("reading prose uses reading colours and keeps strong text and code inside links in the link colour", () => {
  const prose = readFileSync(join(webSource, "styles/prose.css"), "utf8");
  expect(/\.em-prose\s*\{([^}]+)\}/.exec(prose)?.[1]).toMatch(/\bcolor:\s*var\(--fg-reading\)\s*;/);
  expect(/\.em-prose :is\(h1, h2, h3, h5, h6, strong, code\)\s*\{([^}]+)\}/.exec(prose)?.[1]).toMatch(
    /\bcolor:\s*var\(--fg-reading-strong\)\s*;/,
  );
  const linkRule = /\.em-prose a :is\(strong, code\)\s*\{([^}]+)\}/.exec(prose);
  expect(linkRule?.[1]).toMatch(/\bcolor:\s*inherit\s*;/);
  // The link rule must come after the emphasis rule to win at equal-or-higher specificity.
  expect(linkRule?.index).toBeGreaterThan(prose.indexOf(".em-prose :is(h1, h2, h3, h5, h6, strong, code)"));
  expect(/\.em-prose blockquote\s*\{([^}]+)\}/.exec(prose)?.[1]).toMatch(/\bcolor:\s*var\(--fg-reading\)\s*;/);
  const colors = readFileSync(join(webSource, "styles/colors.css"), "utf8");
  // Both themes define --fg-reading, so the token follows the theme.
  expect(colors.match(/--fg-reading:/g)?.length).toBeGreaterThanOrEqual(3);
});

test("web CSS loads only relative bundled fonts and never imports a remote stylesheet", () => {
  const stylesheets = webStylesheets();
  expect(stylesheets.length).toBeGreaterThan(0);
  for (const { path, css } of stylesheets) {
    for (const url of cssUrls(css)) {
      expect(url, path).toMatch(/^\.{1,2}\//);
      const asset = resolve(dirname(path), url);
      expect(dirname(asset), path).toBe(webFonts);
      expect(statSync(asset).isFile(), url).toBe(true);
    }
    const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?(["'])(.*?)\1/gi)];
    expect(imports).toHaveLength([...css.matchAll(/@import\b/gi)].length);
    for (const match of imports) {
      expect(match[2]?.trim(), path).not.toMatch(/^(?:[a-z][\w+.-]*:|\/\/)/i);
    }
  }
});

test("every built-in font and its OFL licence ship with matching font-face sources", () => {
  for (const directory of [webFonts, webLicenses]) {
    expect(readdirSync(directory).filter((file) => /^(?:hanken-grotesk|martian-mono)-/.test(file))).toEqual([]);
  }
  for (const file of fontFiles) {
    const bytes = readFileSync(join(webFonts, file));
    expect(bytes.subarray(0, 4).toString(), file).toBe("wOF2");
  }
  for (const file of fontLicenses) {
    expect(readFileSync(join(webLicenses, file), "utf8"), file).toContain("SIL OPEN FONT LICENSE Version 1.1");
  }
  expect(
    readdirSync(webFonts)
      .filter((file) => file.endsWith(".woff2"))
      .sort(),
  ).toEqual([...fontFiles].sort());
  expect(
    readdirSync(webLicenses)
      .filter((file) => file.endsWith("-OFL.txt"))
      .sort(),
  ).toEqual([...fontLicenses].sort());
  const sources: string[] = [];
  for (const { path, css } of webStylesheets()) {
    for (const face of css.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
      const declarations = face[1] ?? "";
      const src = /\bsrc\s*:\s*([^;]+);/i.exec(declarations)?.[1] ?? "";
      const urls = cssUrls(src);
      expect(urls).toHaveLength(1);
      expect(src).toContain('format("woff2")');
      expect(declarations).toMatch(/font-display:\s*swap\s*;/);
      expect(declarations).not.toMatch(/font-stretch/);
      for (const url of urls) {
        const matches = fontSources.filter(({ file }) => url === `../fonts/${file}`);
        expect(matches, url).toHaveLength(1);
        const font = matches[0]?.font;
        if (!font) throw new Error(`Unknown built-in font source: ${url}`);
        const italic = url.endsWith("-italic.woff2");
        expect(/font-family:\s*([^;]+);/.exec(declarations)?.[1]?.trim(), url).toBe(`"${font.family}"`);
        expect(/font-weight:\s*([^;]+);/.exec(declarations)?.[1]?.trim().replace(/\s+/g, " "), url).toBe(
          font.weight.join(" "),
        );
        expect(declarations, url).toMatch(italic ? /font-style:\s*italic\s*;/ : /font-style:\s*normal\s*;/);
        if (italic) expect(declarations, url).not.toMatch(/unicode-range/);
        else expect(declarations, url).toMatch(/unicode-range:\s*U\+[0-9a-f]/i);
        sources.push(resolve(dirname(path), url));
      }
    }
  }
  expect(sources.sort()).toEqual([...fontFiles, ...pubFontFiles].map((file) => join(webFonts, file)).sort());
});

test("pub defaults use tokens, stay inside one recense layer and define the documented classes", () => {
  const css = readFileSync(join(webSource, "styles/pub.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/i);
  expect(css).toMatch(/^@layer recense\s*\{/);
  expect(css).toMatch(/:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;\s*\}/);
  // Only the last closing brace may end the outer layer; nested media rules remain inside it.
  let depth = 0;
  for (let i = css.indexOf("{"); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") {
      depth--;
      if (depth === 0) expect(i).toBe(css.length - 1);
    }
  }
  expect(depth).toBe(0);
  for (const name of ["tldr", "facts", "note", "warning", "pair", "status", "ok", "warn", "bad"])
    expect(css).toMatch(new RegExp(`\\.${name}\\b`));
  expect(css).toContain("font: var(--type-prose)");
  expect(css).toContain("background: var(--bg-reading)");
  const diagramBox = /pre,\s*\[data-recense-diagram\]\s*\{([^}]+)\}/.exec(css)?.[1] ?? "";
  for (const property of [
    "margin:",
    "padding:",
    "border:",
    "border-radius:",
    "background: var(--bg-sunken)",
    "overflow: auto",
  ])
    expect(diagramBox).toContain(property);
  const link = /(?:^|\s)a\s*\{([^}]+)\}/.exec(css)?.[1] ?? "";
  expect(link).toContain("text-decoration: underline;");
  expect(link).toContain("text-decoration-thickness: 1px;");
  expect(link).toContain("text-underline-offset: 2px;");
  expect(css).toMatch(/a:hover\s*\{\s*color: var\(--fg-link-hover\);/);
  const body = /body\s*\{([^}]+)\}/.exec(css)?.[1] ?? "";
  expect(body).toContain("--reading-max: 68ch;");
  expect(body).toContain("max-width: calc(var(--reading-max) + 2 * var(--space-4));");
  expect(body).toContain("padding: var(--space-4) var(--space-10) var(--space-8);");
  const boxedResets = [...css.matchAll(/(:is\([^{}]+?\)) > :(?:first|last)-child\s*\{\s*margin-(?:top|bottom): 0;/g)];
  expect(boxedResets).toHaveLength(2);
  for (const [, selector] of boxedResets) {
    expect(selector).toBe(":is(section.tldr, aside.note, aside.warning, blockquote, details, figure, dl.facts dd)");
    expect(selector).not.toMatch(/\b(?:main|article)\b|(?:\(|,\s*)section(?:\s*,|\))/);
  }
  const flat = css.replace(/\s+/g, " ");
  const wide =
    "max-width: calc(var(--reading-max) + 112px); " +
    "padding: calc(var(--space-6) + var(--space-1)) 56px calc(var(--space-16) + var(--space-2)); " +
    "padding-right: clamp(var(--space-8), calc(100% - var(--reading-max) - 56px), 56px);";
  expect(flat).toContain(
    `:root[data-recense-layout="wide"] body { --reading-max: var(--reader-measure, 1024px); ${wide} }`,
  );
  expect(flat).toContain(
    `@media (min-width: 768px) { :root:not([data-recense-layout]) body { --reading-max: 1024px; ${wide} } }`,
  );
  const narrow = "grid-template-columns: minmax(0, 1fr);";
  expect(flat).toContain(`:root[data-recense-layout="narrow"] dl.facts { ${narrow} }`);
  expect(flat).toContain(`@media (max-width: 767px) { :root:not([data-recense-layout]) dl.facts { ${narrow} } }`);
  for (const edge of ["nth-child", "nth-last-child"])
    expect(flat).toContain(`body :${edge}(1 of :not(script, style, meta, link, title, template)):not(`);
  const entry = readFileSync(join(webSource, "../pub-frame.css"), "utf8");
  expect(entry.startsWith("@layer recense-file, emend-file, recense;\n")).toBe(true);
  for (const name of ["pub-fonts", "colors", "typography", "spacing"])
    expect(entry).toContain(`@import "./src/styles/${name}.css" layer(recense);`);
});

test("pub preferences match reading measures and sizes through safe root attribute rules", () => {
  const css = readFileSync(join(webSource, "styles/pub.css"), "utf8");
  expect(pubStylesheetSafe(css)).toBe(true);
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  for (const [width, measure] of Object.entries(readingMeasure)) {
    if (width === "comfortable") {
      expect(flat).toContain(
        `:root[data-recense-layout="wide"] body { --reading-max: var(--reader-measure, ${measure});`,
      );
    } else expect(flat).toContain(`:root[data-recense-width="${width}"] { --reader-measure: ${measure}; }`);
  }
  for (const prose of [15, 16, 17, 18])
    expect(flat).toContain(`:root[data-recense-prose="${prose}"] { --reader-prose-size: ${prose}px; }`);
  for (const code of [12, 13, 14, 15])
    expect(flat).toContain(`:root[data-recense-code="${code}"] { --reader-code-size: ${code}px; }`);
});

test("pub fonts reuse only the app's default faces without JetBrains Mono italic", () => {
  const fonts = readFileSync(join(webSource, "styles/fonts.css"), "utf8");
  const pub = readFileSync(join(webSource, "styles/pub-fonts.css"), "utf8");
  const faces = (css: string) => [...css.matchAll(/@font-face\s*\{[^}]+\}/g)].map((match) => match[0]);
  expect(faces(pub)).toEqual(
    faces(fonts).filter((face) => pubFontFiles.some((file) => face.includes(`../fonts/${file}`))),
  );
});

test("text and labels use the sans family and every mono declaration disables programming ligatures", () => {
  const typography = readFileSync(join(webSource, "styles/typography.css"), "utf8");
  expect(typography).toMatch(/--font-sans:\s*"Geist",/);
  expect(typography).toMatch(/--font-mono:\s*"JetBrains Mono",/);
  expect(typography).toMatch(/--mono-features:\s*"calt"\s+0\s*;/);
  expect(typography).toMatch(/--type-label:\s*[^;]+var\(--font-sans\)\s*;/);
  let monoDeclarations = 0;
  for (const { path, css } of webStylesheets()) {
    expect(css, path).not.toMatch(/--mono-stretch|font-stretch/);
    for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = block[2] ?? "";
      const context = `${path}: ${block[1]?.trim()}`;
      const fonts = declarations.matchAll(
        /(?:^|;)\s*font(?:-family)?:\s*[^;]*var\(--(?:font-mono|type-code|type-path)\)[^;]*(?=;)/g,
      );
      for (const font of fonts) {
        monoDeclarations++;
        expect(declarations.slice(font.index + font[0].length), context).toMatch(
          /;\s*font-feature-settings:\s*var\(--mono-features\)\s*;/,
        );
      }
    }
  }
  expect(monoDeclarations).toBeGreaterThan(0);
  expect(readFileSync(join(webSource, "styles/diff.css"), "utf8")).toMatch(
    /--diffs-font-features:\s*var\(--mono-features\)\s*;/,
  );
  expect(readFileSync(join(webSource, "styles/theme.css"), "utf8")).toMatch(
    /--font-mono--font-feature-settings:\s*var\(--mono-features\)\s*;/,
  );
});

test("mono text uses stylesheet rules or font-mono instead of arbitrary font utilities", () => {
  const files = readdirSync(webSource, { recursive: true, encoding: "utf8" }).filter(
    (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
  );
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = readFileSync(join(webSource, file), "utf8");
    for (const utility of [
      "[font-feature-settings:",
      "[font:var(--type-path)]",
      "[font:var(--type-code)]",
      "[font:var(--font-mono)",
    ]) {
      expect(source, file).not.toContain(utility);
    }
  }
  const css = readFileSync(join(webSource, "styles/diff.css"), "utf8");
  expect(/\.em-path\s*\{([^}]+)\}/.exec(css)?.[1]).toMatch(
    /font:\s*var\(--type-path\)\s*;\s*font-feature-settings:\s*var\(--mono-features\)\s*;/,
  );
});

// Rendered blocks stored before the rename carry `emend-*` classes, so every selector for a class the server
// writes into blocks has a legacy twin: `:is(.recense-x, .emend-x)`. These tests read the current names.
const withoutLegacyTwins = (css: string) => css.replace(/:is\((\.recense-[a-z-]+), \.emend-[a-z-]+\)/g, "$1");

test("writeup images keep their own size, stay under half the screen and show a ring, using theme tokens only", () => {
  const css = withoutLegacyTwins(readFileSync(join(webSource, "styles/prose.css"), "utf8"));
  const rule = (selector: string) =>
    new RegExp(`${selector.replace(/[.>]/g, "\\$&")}\\s*\\{([^}]+)\\}`).exec(css)?.[1] ?? "";
  expect(rule(".em-prose .recense-media")).toMatch(/display:\s*inline-block/);
  expect(rule(".em-prose .recense-media")).toMatch(/max-width:\s*100%/);
  expect(rule(".em-prose .recense-media")).toMatch(
    /--recense-media-fit:\s*min\(\s*calc\(var\(--recense-media-w\) \* 1px\)/,
  );
  expect(rule(".em-prose .recense-media img")).toMatch(/max-height:\s*50svh/);
  expect(rule(".em-prose .recense-media img")).toMatch(/object-fit:\s*contain/);
  expect(rule(".em-prose .recense-media img")).toMatch(/box-shadow:\s*0 0 0 1px var\(--border-1\)/);
  expect(rule(".em-prose .recense-media img")).toMatch(/border-radius:\s*var\(--radius-md\)/);
  expect(rule(".em-prose .recense-media img")).toMatch(/background:\s*var\(--bg-sunken\)/);
  expect(rule(".em-prose p.recense-media-row")).toMatch(/flex-wrap:\s*wrap/);
  expect(rule(".em-prose p.recense-media-row > .recense-media")).toMatch(
    /flex:\s*1 1 min\(var\(--recense-media-fit\), 18rem\)/,
  );
  const media = css.slice(css.indexOf(".em-prose .recense-media {"), css.indexOf(".em-prose > :first-child"));
  expect(media).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/i);
});

test("screenshot effect lines shrink and wrap unbroken tokens on phones", () => {
  const css = withoutLegacyTwins(readFileSync(join(webSource, "styles/prose.css"), "utf8"));
  const effect = /\.em-prose \.recense-media-effect\s*\{([^}]+)\}/.exec(css)?.[1];
  expect(effect).toMatch(/\bmin-width:\s*0\s*;/);
  expect(effect).toMatch(/\boverflow-wrap:\s*anywhere\s*;/);
});

test("every selector for a class the server writes into blocks also matches the name before the rename", () => {
  for (const file of ["styles/prose.css", "styles/threads.css"]) {
    const css = readFileSync(join(webSource, file), "utf8");
    // A current block class outside a twin would leave old stored blocks unstyled.
    expect(css.replace(/:is\(\.recense-[a-z-]+, \.emend-[a-z-]+\)/g, ""), file).not.toMatch(
      /\.recense-(?:media|callout|example|term)/,
    );
  }
  const prose = readFileSync(join(webSource, "styles/prose.css"), "utf8");
  expect(prose).toContain(":is(.recense-media, .emend-media)");
  expect(prose).toContain(":is(.recense-callout, .emend-callout)");
});

test("reading components use semantic colours, with white reserved for the isolated HTML document page", () => {
  const reading = join(webSource, "components/reading");
  for (const file of readdirSync(reading).filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))) {
    const source = readFileSync(join(reading, file), "utf8");
    expect(source, file).not.toMatch(/(?:neutral-|amber-|dark:|bg-white|text-white)/);
    if (source.includes("bg-[#fff]")) expect(file).toBe("HtmlDocFrame.tsx");
  }
  const frame = readFileSync(join(webSource, "../mermaid-frame.html"), "utf8");
  expect(frame).toMatch(/:root\s*\{\s*color-scheme:\s*light dark/);
  expect(frame).toMatch(/body\s*\{\s*background:\s*transparent/);
});

test("code blocks keep legacy Shiki theme rules and use syntax plain as their fallback", () => {
  const prose = readFileSync(join(webSource, "styles/prose.css"), "utf8");
  for (const mode of ["light", "dark"]) {
    expect(prose).toContain(`color: var(--shiki-${mode}, var(--syn-plain));`);
    expect(prose).toContain(`background-color: var(--shiki-${mode}-bg, var(--bg-sunken));`);
  }
  expect(prose).toContain(':root:not([data-theme="light"]) .em-prose .shiki span');
  expect(prose).toContain('[data-theme="dark"] .em-prose .shiki span');
  expect(prose).toMatch(/\.em-prose pre code\s*\{[^}]*color: var\(--syn-plain\)/);
  expect(readFileSync(join(webSource, "styles/source.css"), "utf8")).toMatch(
    /\.em-source-code\s*\{[^}]*color: var\(--syn-plain\)/,
  );
});
