// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const webSource = fileURLToPath(new URL(".", import.meta.url));
const webLicenses = fileURLToPath(new URL("../public/licenses/", import.meta.url));
const webFonts = join(webSource, "fonts");
const fontFiles = [
  "hanken-grotesk-latin-wght-normal.woff2",
  "hanken-grotesk-latin-ext-wght-normal.woff2",
  "hanken-grotesk-latin-wght-italic.woff2",
  "martian-mono-latin-standard-normal.woff2",
  "martian-mono-latin-ext-standard-normal.woff2",
];
const fontLicenses = ["hanken-grotesk-OFL.txt", "martian-mono-OFL.txt"];

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

test("phone topic metadata wraps without changing the clipped desktop row", () => {
  const css = readFileSync(join(webSource, "styles/diff.css"), "utf8");
  const desktop = /\.em-topic-meta\s*\{([^}]+)\}/.exec(css)?.[1];
  expect(desktop).toMatch(/flex-wrap:\s*nowrap;/);
  expect(desktop).toMatch(/white-space:\s*nowrap;/);
  expect(desktop).toMatch(/overflow:\s*hidden;/);
  const phone = /\.em-diff-topic\[data-phone\] \.em-topic-meta\s*\{([^}]+)\}/.exec(css)?.[1];
  expect(phone).toMatch(/flex-wrap:\s*wrap;/);
  expect(phone).toMatch(/white-space:\s*normal;/);
  expect(phone).toMatch(/overflow:\s*visible;/);
  expect(phone).toMatch(/row-gap:\s*4px;/);
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

test("the reading column grows with the pane up to 1000px on desktop and keeps its phone measure", () => {
  const css = readFileSync(join(webSource, "styles/reading.css"), "utf8");
  expect(/\.em-reading-column\s*\{([^}]+)\}/.exec(css)?.[1]).toMatch(/--reading-max:\s*68ch\s*;/);
  expect(css).toMatch(/\.em-reading-column\s*\{\s*--reading-max:\s*1000px;\s*\}/);
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

test("the five variable fonts and their OFL licences ship with matching font-face sources", () => {
  for (const file of fontFiles) {
    const bytes = readFileSync(join(webFonts, file));
    expect(bytes.subarray(0, 4).toString(), file).toBe("wOF2");
  }
  for (const file of fontLicenses) {
    expect(readFileSync(join(webLicenses, file), "utf8"), file).toContain("SIL OPEN FONT LICENSE Version 1.1");
  }
  const sources: string[] = [];
  for (const { path, css } of webStylesheets()) {
    for (const face of css.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
      const declarations = face[1] ?? "";
      const src = /\bsrc\s*:\s*([^;]+);/i.exec(declarations)?.[1] ?? "";
      const urls = cssUrls(src);
      expect(urls).toHaveLength(1);
      expect(declarations).toMatch(/font-display:\s*swap\s*;/);
      for (const url of urls) {
        const martian = url.includes("martian-mono-");
        const italic = url.endsWith("-italic.woff2");
        expect(declarations, url).toMatch(martian ? /font-weight:\s*100\s+800\s*;/ : /font-weight:\s*100\s+900\s*;/);
        if (martian) expect(declarations, url).toMatch(/font-stretch:\s*75%\s+112\.5%\s*;/);
        expect(declarations, url).toMatch(italic ? /font-style:\s*italic\s*;/ : /font-style:\s*normal\s*;/);
        if (!italic) expect(declarations, url).toMatch(/unicode-range:\s*U\+[0-9a-f]/i);
        sources.push(resolve(dirname(path), url));
      }
    }
  }
  expect(sources.sort()).toEqual(fontFiles.map((file) => join(webFonts, file)).sort());
});

test("writeup images keep their own size, stay under half the screen and show a ring, using theme tokens only", () => {
  const css = readFileSync(join(webSource, "styles/prose.css"), "utf8");
  const rule = (selector: string) =>
    new RegExp(`${selector.replace(/[.>]/g, "\\$&")}\\s*\\{([^}]+)\\}`).exec(css)?.[1] ?? "";
  expect(rule(".em-prose .emend-media")).toMatch(/display:\s*inline-block/);
  expect(rule(".em-prose .emend-media")).toMatch(/max-width:\s*100%/);
  expect(rule(".em-prose .emend-media")).toMatch(/--emend-media-fit:\s*min\(\s*calc\(var\(--emend-media-w\) \* 1px\)/);
  expect(rule(".em-prose .emend-media img")).toMatch(/max-height:\s*50svh/);
  expect(rule(".em-prose .emend-media img")).toMatch(/object-fit:\s*contain/);
  expect(rule(".em-prose .emend-media img")).toMatch(/box-shadow:\s*0 0 0 1px var\(--border-1\)/);
  expect(rule(".em-prose .emend-media img")).toMatch(/border-radius:\s*var\(--radius-md\)/);
  expect(rule(".em-prose .emend-media img")).toMatch(/background:\s*var\(--bg-sunken\)/);
  expect(rule(".em-prose p.emend-media-row")).toMatch(/flex-wrap:\s*wrap/);
  expect(rule(".em-prose p.emend-media-row > .emend-media")).toMatch(
    /flex:\s*1 1 min\(var\(--emend-media-fit\), 18rem\)/,
  );
  const media = css.slice(css.indexOf(".em-prose .emend-media {"), css.indexOf(".em-prose > :first-child"));
  expect(media).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/i);
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
