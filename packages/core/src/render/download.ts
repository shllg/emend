import {
  LIMITS,
  OTHER_TOPIC,
  type PublishLinks,
  type RenderedBlock,
  type RenderedWriteup,
  type SourceContent,
  type TopicMeta,
} from "@emend/contract";
import { fromHtml } from "hast-util-from-html";
import { toString as hastText } from "hast-util-to-string";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import type { HtmlElement as Element, HtmlRoot as Root } from "./blocks.ts";
import { MEDIA_URL_PREFIX } from "./sanitize.ts";

type ElementContent = Element["children"][number];
type RootContent = Root["children"][number];
type Properties = Element["properties"];
type Text = Extract<ElementContent, { type: "text" }>;

export const DOWNLOAD_FILE_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; base-uri 'none'; form-action 'none'";
export type DownloadAsset = { mediaType: string; bytes: Uint8Array };
export type ResolveResult = DownloadAsset | null | "too-large";
export type DownloadResolver = (path: string) => Promise<ResolveResult>;
export type DownloadDetails = {
  project: string | null;
  branch: string | null;
  seq: number;
  publishedAt: string;
  links: PublishLinks | undefined;
};
type PageInput = {
  title: string;
  details: DownloadDetails;
  resolveMedia: DownloadResolver;
  inlineBudget?: number;
  pause?: () => Promise<void>;
};

const STYLESHEET_LIMIT = 64;
const CSS_WORK_BYTES = 64 * 1024 * 1024;
const CSS_PAUSE_BYTES = 1024 * 1024;
const REFERENCE_PAUSE_COUNT = 1000;

// Literal reading tokens keep the exported page independent of the app and its fonts.
const READING_STYLES = `
:root{color-scheme:light dark;--bg:oklch(.985 .001 260);--sunken:oklch(.968 .002 260);--fg:oklch(.49 .004 260);--strong:oklch(.18 .004 260);--muted:oklch(.55 .004 260);--border:oklch(.895 .003 260);--link:oklch(.42 .09 60)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:400 16px/1.7 ui-sans-serif,system-ui,sans-serif}.em-download{max-width:68ch;margin:auto;padding:32px 20px;overflow-wrap:break-word}h1,h2,h3,h5,h6,strong,code{color:var(--strong)}h1{font-size:24px;line-height:1.2;letter-spacing:-.015em;margin:0 0 16px}h2{font-size:19px;line-height:1.3;letter-spacing:-.01em;margin:36px 0 12px}h3{font-size:16px;line-height:1.35;margin:24px 0 6px}h4{font:600 11px/1.3 ui-monospace,"SF Mono",Menlo,monospace;text-transform:uppercase;letter-spacing:.04em}h1,h2,h3{font-weight:600}p,ul,ol{margin:0 0 12px}ul,ol{padding-left:22px}li{margin:6px 0}a{color:var(--link)}a :is(strong,code){color:inherit}.em-doc-link{color:inherit}code{font:400 .84em/1 ui-monospace,"SF Mono",Menlo,monospace;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--sunken)}pre{margin:0 0 14px;padding:12px 14px;border:1px solid var(--border);border-radius:6px;background:var(--sunken);overflow:auto;font:400 12px/1.6 ui-monospace,"SF Mono",Menlo,monospace}pre code{padding:0;border:0;background:none;font:inherit}.shiki{background-color:var(--shiki-light-bg,var(--sunken))}.shiki,.shiki span{color:var(--shiki-light,inherit)}blockquote{margin:0 0 12px;padding-left:14px;border-left:2px solid var(--border)}table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;margin:0 0 14px;font-size:14px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--border)}th{font-weight:500}hr{border:0;border-top:1px solid var(--border);margin:24px 0}img{max-width:100%;height:auto}.emend-media{display:inline-block;max-width:100%;vertical-align:top}.emend-media img{display:block;border-radius:6px}.emend-media-caption{display:block;margin-top:6px;overflow-wrap:anywhere}.em-meta,.emend-media-caption,figcaption,footer,.em-topic-blast,.em-link-host{font:400 12px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--muted)}.em-links{list-style:none;padding:0}.em-link-host{margin-left:6px}.em-diagram{margin:16px 0}.em-diagram figcaption{margin-bottom:6px}.em-download-note{padding:12px 14px;border:1px solid var(--border);border-radius:6px;background:var(--sunken)}footer{border-top:1px solid var(--border);margin-top:36px;padding-top:16px}
@media(prefers-color-scheme:dark){:root{--bg:oklch(.18 .004 260);--sunken:oklch(.125 .004 260);--fg:oklch(.79 .004 260);--strong:oklch(.895 .003 260);--muted:oklch(.7 .004 260);--border:oklch(.25 .004 260);--link:oklch(.85 .14 81)}.shiki{background-color:var(--shiki-dark-bg,var(--sunken))}.shiki,.shiki span{color:var(--shiki-dark,inherit)}}
`;
const rel = ["noopener", "noreferrer", "nofollow"];
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const text = (value: string): Text => ({ type: "text", value });
const element = (tagName: string, children: ElementContent[] = [], properties: Properties = {}): Element => ({
  type: "element",
  tagName,
  properties,
  children,
});
// Style text is raw HTML to the serializer, even in SVG and MathML.
const escapeCssText = (css: string) => css.replace(/<(?=[a-z/!?])/gi, "\\3c ");
const style = (css: string, properties: Properties = {}) => element("style", [text(escapeCssText(css))], properties);
const serialize = (tree: Root) =>
  String(unified().use(rehypeStringify, { allowDangerousCharacters: false }).stringify(tree));
const note = () =>
  element("p", [text("Some images or files were left out because the download would pass 128 MiB.")], {
    className: ["em-download-note"],
  });
const headMetas = () => [
  element("meta", [], { charSet: "utf-8" }),
  element("meta", [], { httpEquiv: ["Content-Security-Policy"], content: DOWNLOAD_FILE_CSP }),
  element("meta", [], { name: "referrer", content: "no-referrer" }),
];
function absoluteLink(value: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
function dataUri(asset: DownloadAsset): string {
  const chunks: string[] = [];
  for (let i = 0; i < asset.bytes.length; i += 0x8000)
    chunks.push(String.fromCharCode(...asset.bytes.subarray(i, i + 0x8000)));
  return `data:${asset.mediaType};base64,${btoa(chunks.join(""))}`;
}
function resolverState(
  resolve: DownloadResolver,
  inlineBudget: number = LIMITS.downloadInlineBytes,
  pause?: () => Promise<void>,
) {
  const cache = new Map<string, Promise<DownloadAsset | null>>();
  let stylesheets = 0;
  let cssWork = 0;
  let cssSincePause = 0;
  let referencesSincePause = 0;
  const state = {
    tooLarge: false,
    used: 0,
    take(length: number): boolean {
      if (length > inlineBudget - state.used) {
        state.tooLarge = true;
        return false;
      }
      state.used += length;
      return true;
    },
    reference(): Promise<void> | undefined {
      referencesSincePause++;
      if (referencesSincePause < REFERENCE_PAUSE_COUNT) return;
      referencesSincePause = 0;
      return pause?.();
    },
    cssAvailable(): boolean {
      if (cssWork < CSS_WORK_BYTES) return true;
      state.tooLarge = true;
      return false;
    },
    beginCss(css: string): number | null {
      if (!state.cssAvailable()) return null;
      const bytes = new TextEncoder().encode(css).byteLength;
      if (bytes > CSS_WORK_BYTES - cssWork) {
        cssWork = CSS_WORK_BYTES;
        state.tooLarge = true;
        return null;
      }
      // Charge the whole occurrence before rewriting; dropping output never refunds this work.
      cssWork += bytes;
      return bytes;
    },
    tokenizedCss(bytes: number): Promise<void> | undefined {
      if (!pause) return;
      cssSincePause += bytes;
      if (cssSincePause < CSS_PAUSE_BYTES) return;
      return (async () => {
        while (cssSincePause >= CSS_PAUSE_BYTES) {
          cssSincePause -= CSS_PAUSE_BYTES;
          await pause();
        }
      })();
    },
    data(asset: DownloadAsset, suffix = ""): string | null {
      const length = `data:${asset.mediaType};base64,`.length + 4 * Math.ceil(asset.bytes.length / 3) + suffix.length;
      return state.take(length) ? dataUri(asset) + suffix : null;
    },
    get(path: string): Promise<DownloadAsset | null> {
      let result = cache.get(path);
      if (!result) {
        result = resolve(path).then((asset) => {
          if (asset === "too-large") {
            state.tooLarge = true;
            return null;
          }
          return asset;
        });
        cache.set(path, result);
      }
      return result;
    },
    async stylesheet(path: string): Promise<DownloadAsset | null> {
      const pending = state.reference();
      if (pending) await pending;
      if (!state.cssAvailable()) return null;
      if (stylesheets >= STYLESHEET_LIMIT) {
        state.tooLarge = true;
        return null;
      }
      const asset = await state.get(path);
      if (asset?.mediaType !== "text/css") return null;
      // Reserve each occurrence before following its imports, including repeated paths.
      stylesheets++;
      return asset;
    },
  };
  return state;
}
type AssetState = ReturnType<typeof resolverState>;
function frame(input: PageInput, content: ElementContent[], tooLarge: boolean): string {
  const { title, details } = input;
  const links = (details.links ?? []).flatMap((link) => {
    try {
      const url = new URL(link.url);
      if (url.protocol !== "https:" || url.username || url.password) return [];
      return [
        element("li", [
          element("a", [text(link.label)], { href: url.href, rel }),
          element("span", [text(url.host)], { className: ["em-link-host"] }),
        ]),
      ];
    } catch {
      return [];
    }
  });
  const meta = [
    details.project,
    details.branch,
    `Revision ${details.seq}`,
    new Date(details.publishedAt).toISOString().slice(0, 10),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return serialize({
    type: "root",
    children: [
      { type: "doctype" },
      element(
        "html",
        [
          element("head", [
            ...headMetas(),
            element("meta", [], { name: "viewport", content: "width=device-width, initial-scale=1" }),
            element("meta", [], { name: "color-scheme", content: "light dark" }),
            element("title", [text(title)]),
            style(READING_STYLES),
          ]),
          element("body", [
            element(
              "main",
              [
                ...(tooLarge ? [note()] : []),
                element("header", [
                  element("h1", [text(title)]),
                  element("p", [text(meta)], { className: ["em-meta"] }),
                  ...(links.length ? [element("ul", links, { className: ["em-links"] })] : []),
                ]),
                ...content,
                element("footer", [text("Downloaded from emend.")]),
              ],
              { className: ["em-download"] },
            ),
          ]),
        ],
        { lang: "en" },
      ),
    ],
  });
}
const blockRemoved = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "link",
  "meta",
  "base",
  "form",
  "template",
  "noscript",
]);
const blockAttributes = new Set(["ping", "srcset", "srcdoc", "formaction", "action"]);
function stripAttributes(el: Element, removed: Set<string>) {
  for (const key of Object.keys(el.properties))
    if (/^on/i.test(key) || removed.has(key.toLowerCase())) delete el.properties[key];
}
async function transformBlocks(parent: Root | Element, state: AssetState): Promise<void> {
  const children: ElementContent[] = [];
  for (const node of parent.children) {
    if (node.type === "text") {
      children.push(node);
      continue;
    }
    if (node.type !== "element" || blockRemoved.has(node.tagName.toLowerCase())) continue;
    stripAttributes(node, blockAttributes);
    if (typeof node.properties.style === "string" && /url\s*\(|expression\s*\(/i.test(node.properties.style))
      delete node.properties.style;
    if (node.tagName === "img") {
      const pending = state.reference();
      if (pending) await pending;
      const src = String(node.properties.src ?? "");
      const hash = src.startsWith(MEDIA_URL_PREFIX) ? src.slice(MEDIA_URL_PREFIX.length) : "";
      const asset = /^[0-9a-f]{64}$/.test(hash) ? await state.get(hash) : null;
      if (!asset || !imageTypes.has(asset.mediaType)) continue;
      const uri = state.data(asset);
      if (uri === null) continue;
      node.properties.src = uri;
    }
    if (node.tagName === "a") {
      if (absoluteLink(String(node.properties.href ?? ""))) {
        node.properties.rel = rel;
        delete node.properties.target;
        delete node.properties.download;
      } else {
        node.tagName = "span";
        node.properties = { className: ["em-doc-link"] };
      }
    }
    await transformBlocks(node, state);
    children.push(node);
  }
  parent.children = children;
}
async function blocksContent(blocks: RenderedBlock[], state: AssetState): Promise<ElementContent[]> {
  const children: ElementContent[] = [];
  for (const block of blocks) {
    if (block.kind === "diagram") {
      children.push(
        element(
          "figure",
          [
            element("figcaption", [text("Mermaid diagram")]),
            element("pre", [element("code", [text(block.source ?? block.text)])]),
          ],
          { className: ["em-diagram"] },
        ),
      );
    } else {
      const tree = fromHtml(block.html, { fragment: true });
      await transformBlocks(tree, state);
      children.push(...tree.children.filter((node): node is ElementContent => node.type !== "doctype"));
    }
  }
  return children;
}
export async function buildWriteupDownload(
  input: PageInput & { writeup: RenderedWriteup; topics: TopicMeta[] },
): Promise<string> {
  const state = resolverState(input.resolveMedia, input.inlineBudget, input.pause);
  // Revisions arrive in review order. The reserved Other topic never receives a rank.
  const ranked = input.topics.filter((topic) => topic.slug !== OTHER_TOPIC.slug);
  const bySlug = new Map(ranked.map((topic) => [topic.slug, topic]));
  const groups: { key: string; node: Element }[] = [];
  const written = new Map<string, Element>();
  for (const section of input.writeup.sections) {
    const topic = section.topic ? bySlug.get(section.topic) : undefined;
    const content = await blocksContent(section.blocks, state);
    if (!topic) {
      groups.push({
        key: section.key,
        node: element("section", [
          element("h2", [text(section.key === "decisions" ? "Decisions & drift" : section.label)]),
          ...content,
        ]),
      });
      continue;
    }
    let group = written.get(topic.slug);
    if (!group) {
      group = element("section", [element("h2", [text(topic.title)]), element("p", [text(topic.summary)])], {
        id: `topic-${topic.slug}`,
      });
      if (topic.blastRadius)
        group.children.push(
          element(
            "p",
            [
              text("Blast radius: "),
              element("strong", [text(topic.blastRadius.scope)]),
              text(` — ${topic.blastRadius.note}`),
            ],
            { className: ["em-topic-blast"] },
          ),
        );
      written.set(topic.slug, group);
      groups.push({ key: section.key, node: group });
    }
    const suffix = section.key.slice(section.key.lastIndexOf("-") + 1);
    group.children.push(
      element("h3", [text(suffix === "why" ? "Why" : suffix === "example" ? "Example" : "Details")]),
      ...content,
    );
  }
  if (ranked.length) {
    const intro = ["overview", "tldr", "outOfScope", "whereToLook", "context", "decisions", "glossary"];
    const index = groups.findLastIndex((group) => intro.includes(group.key)) + 1;
    groups.splice(index, 0, {
      key: "topics",
      node: element("section", [
        element("h2", [text("Topics")]),
        element(
          "ol",
          ranked.map((topic, index) =>
            element(
              "li",
              [
                written.has(topic.slug)
                  ? element("a", [text(topic.title)], { href: `#topic-${topic.slug}` })
                  : element("span", [text(topic.title)]),
                element("p", [text(topic.summary)]),
              ],
              { value: String(index + 1) },
            ),
          ),
        ),
      ]),
    });
  }
  return frame(
    input,
    groups.map((group) => group.node),
    state.tooLarge,
  );
}
export async function buildDocDownload(
  input: PageInput & {
    content: { kind: "markdown"; blocks: RenderedBlock[] } | { kind: "source"; lines: SourceContent["lines"] };
  },
): Promise<string> {
  const state = resolverState(input.resolveMedia, input.inlineBudget, input.pause);
  let content: ElementContent[];
  if (input.content.kind === "markdown") content = await blocksContent(input.content.blocks, state);
  else {
    const lines: ElementContent[] = [];
    input.content.lines.forEach((line, index) => {
      if (index) lines.push(text("\n"));
      lines.push(
        element(
          "span",
          line.map((token) => {
            const colors = (["light", "dark"] as const).flatMap((mode) => {
              const color = token[mode];
              return color && /^#[0-9a-fA-F]{3,8}$/.test(color) ? [`--shiki-${mode}:${color}`] : [];
            });
            return element("span", [text(token.text)], colors.length ? { style: colors.join(";") } : {});
          }),
          { className: ["line"] },
        ),
      );
    });
    content = [element("pre", [element("code", lines)], { className: ["shiki", "em-source"] })];
  }
  return frame(input, content, state.tooLarge);
}

/** Resolve once, with browser path semantics, but never let a reference pick an origin. */
function assetPath(ref: string, basePath: string): string | null {
  ref = ref.trim();
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//") || /[\\\p{Cc}]/u.test(ref)) return null;
  try {
    const url = new URL(ref, `https://download.invalid/${basePath.split("/").map(encodeURIComponent).join("/")}`);
    if (url.origin !== "https://download.invalid") return null;
    const segments = url.pathname.slice(1).split("/").map(decodeURIComponent);
    if (segments.some((segment) => /[/\\\p{Cc}]/u.test(segment))) return null;
    return segments.join("/");
  } catch {
    return null;
  }
}
const fragment = (value: string) => /^#[^\s]*$/.test(value);
const referenceFragment = (value: string) => (value.includes("#") ? value.slice(value.indexOf("#")) : "");
const resourceType = (asset: DownloadAsset) => !["text/javascript", "text/css"].includes(asset.mediaType);
const mediaData = /^data:(?:image\/[^;,\s]+|audio\/[^;,\s]+|video\/[^;,\s]+|text\/vtt)(?:;[^,]*)?,/i;
const cssValue = (value: string) => value.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
const cssQuote = (value: string) =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/\r\n|[\r\n\f]/g, "\\a ")}"`;

async function resourceUrl(value: string, basePath: string, state: AssetState, css = false): Promise<string | null> {
  const pending = state.reference();
  if (pending) await pending;
  if (fragment(value)) return value;
  if ((css ? /^data:/i : mediaData).test(value)) return state.take(value.length) ? value : null;
  const path = assetPath(value, basePath);
  const asset = path ? await state.get(path) : null;
  return asset && resourceType(asset) ? state.data(asset, referenceFragment(value)) : null;
}

// Skip strings, comments and nested functions when finding a CSS delimiter.
function cssEnd(css: string, start: number, delimiters: string): number {
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    const char = css.charAt(i);
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      while (++i < css.length) {
        if (css[i] === "\\") i++;
        else if (css[i] === quote) break;
      }
    } else if (css.slice(i, i + 2) === "/*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 1;
    } else if (depth === 0 && delimiters.includes(char)) return i;
    else if (char === "(") depth++;
    else if (char === ")" && depth > 0) depth--;
  }
  return css.length;
}
function importWrappers(conditions: string): string[] {
  const wrappers: string[] = [];
  conditions = conditions.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ").trim();
  if (/^layer\b/i.test(conditions)) {
    conditions = conditions.slice(5).trimStart();
    if (conditions.startsWith("(")) {
      const end = cssEnd(conditions, 1, ")");
      wrappers.push(`@layer ${conditions.slice(1, end).trim()} { `);
      conditions = conditions.slice(end + 1).trimStart();
    } else wrappers.push("@layer { ");
  }
  if (/^supports\s*\(/i.test(conditions)) {
    const start = conditions.indexOf("(");
    const end = cssEnd(conditions, start + 1, ")");
    wrappers.push(`@supports (${conditions.slice(start + 1, end)}) { `);
    conditions = conditions.slice(end + 1).trimStart();
  }
  if (conditions) wrappers.push(`@media ${conditions} { `);
  return wrappers;
}
const importReference =
  /^\s*(?:url\(\s*("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|[^)]*)\s*\)|("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'))/i;
// Unterminated strings, including a final escape, consume the rest instead of retrying at later quotes.
const cssTokens =
  /\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|@import\b|@charset\b|(?:-webkit-)?image-set\s*\(|url\s*\(/gi;
const imageSetTokens =
  /\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|url\s*\(/gi;
async function rewriteCss(
  css: string,
  basePath: string,
  state: AssetState,
  chain: string[] = [],
): Promise<string | null> {
  const inputBytes = state.beginCss(css);
  if (inputBytes === null) return null;
  let tokenized = 0;
  const advance = (end: number) => {
    const bytes =
      inputBytes === css.length ? end - tokenized : new TextEncoder().encode(css.slice(tokenized, end)).byteLength;
    tokenized = end;
    return state.tokenizedCss(bytes);
  };
  const checkpoint = state.used;
  const parts: string[] = [];
  const append = (value: string, charged = 0) => {
    if (!state.take(escapeCssText(value).length - charged)) return false;
    parts.push(value);
    return true;
  };
  const drop = () => {
    state.used = checkpoint;
    return null;
  };
  const appendReference = async (value: string, quoted: boolean, original: string) => {
    const before = state.used;
    const uri = await resourceUrl(value, basePath, state, true);
    const result = uri === value ? original : quoted ? cssQuote(uri ?? "data:,") : `url(${cssQuote(uri ?? "data:,")})`;
    // The resolver charged the URI before allocating it; charge only the rest of the CSS here.
    if (append(result, state.used - before)) return true;
    state.used = before;
    return append(quoted ? '"data:,"' : 'url("data:,")');
  };
  const appendImageSet = async (argument: string) => {
    const references = new RegExp(imageSetTokens);
    let offset = 0;
    for (;;) {
      const match = references.exec(argument);
      if (!match) break;
      if (!append(argument.slice(offset, match.index))) return false;
      let end = references.lastIndex;
      if (/^url\s*\(/i.test(match[0])) {
        end = cssEnd(argument, end, ")");
        const value = cssValue(argument.slice(references.lastIndex, end));
        if (argument[end] === ")") end++;
        if (!(await appendReference(value, false, argument.slice(match.index, end)))) return false;
      } else if (/^['"]/.test(match[0])) {
        if (!(await appendReference(cssValue(match[0]), true, match[0]))) return false;
      } else if (!append(match[0])) return false;
      offset = end;
      references.lastIndex = end;
    }
    return append(argument.slice(offset));
  };
  // Each call owns its cursor; imports recurse with the imported file as their base.
  const tokens = new RegExp(cssTokens);
  let offset = 0;
  for (;;) {
    const match = tokens.exec(css);
    if (!match) break;
    let pending = advance(tokens.lastIndex);
    if (pending) await pending;
    if (!append(css.slice(offset, match.index))) return drop();
    const token = match[0];
    let end = tokens.lastIndex;
    if (/^@(?:import|charset)$/i.test(token)) {
      const isImport = /^@import/i.test(token);
      end = cssEnd(css, end, isImport ? ";{" : ";");
      const rule = css.slice(tokens.lastIndex, end);
      const opensBlock = css[end] === "{";
      if (css[end] === ";") end++;
      pending = advance(end);
      if (pending) await pending;
      // A block cannot belong to an import; leave it for the normal URL rewrite.
      if (isImport && !opensBlock) {
        const ref = importReference.exec(rule);
        const conditions = ref ? rule.slice(ref[0].length) : "";
        const path =
          ref && !/(?:url|image-set)\s*\(|[{}\\]/i.test(conditions)
            ? assetPath(cssValue(ref[1] ?? ref[2] ?? ""), basePath)
            : null;
        if (ref && path && chain.length < 4 && !chain.includes(path)) {
          const asset = await state.stylesheet(path);
          if (asset) {
            const wrappers = importWrappers(conditions);
            const before = state.used;
            const open = wrappers.join("");
            const close = " }".repeat(wrappers.length);
            if (state.take(escapeCssText(open + close).length)) {
              const imported = await rewriteCss(new TextDecoder().decode(asset.bytes), path, state, [...chain, path]);
              if (imported !== null) parts.push(open, imported, close);
              else state.used = before;
            }
          }
        }
      }
    } else if (/^(?:-webkit-)?image-set\s*\(/i.test(token)) {
      end = cssEnd(css, end, ")");
      pending = advance(css[end] === ")" ? end + 1 : end);
      if (pending) await pending;
      const argument = css.slice(tokens.lastIndex, end);
      if (/(?:-webkit-)?image-set\s*\(/i.test(argument)) {
        if (!append("none")) return drop();
      } else {
        if (!append(token) || !(await appendImageSet(argument))) return drop();
        if (css[end] === ")" && !append(")")) return drop();
      }
      if (css[end] === ")") end++;
    } else if (/^url\s*\(/i.test(token)) {
      end = cssEnd(css, end, ")");
      const value = cssValue(css.slice(tokens.lastIndex, end));
      if (css[end] === ")") end++;
      pending = advance(end);
      if (pending) await pending;
      if (!(await appendReference(value, false, css.slice(match.index, end)))) return drop();
    } else if (!append(token)) return drop();
    offset = end;
    tokens.lastIndex = end;
  }
  const pending = advance(css.length);
  if (pending) await pending;
  if (!append(css.slice(offset))) return drop();
  return parts.join("");
}

// Srcset URLs end at whitespace. Commas inside a data URL are part of its payload.
function srcsetCandidates(value: string): { ref: string; descriptors: string[] }[] {
  const candidates: { ref: string; descriptors: string[] }[] = [];
  let offset = 0;
  while (offset < value.length) {
    while (/[\s,]/.test(value[offset] ?? "")) offset++;
    const start = offset;
    const data = /^data:/i.test(value.slice(start, start + 5));
    while (offset < value.length && !/\s/.test(value[offset] ?? "") && (data || value[offset] !== ",")) offset++;
    let urlEnd = offset;
    while (urlEnd > start && value[urlEnd - 1] === ",") urlEnd--;
    const ref = value.slice(start, urlEnd);
    if (!ref) break;
    if (urlEnd < offset || value[offset] === ",") {
      candidates.push({ ref, descriptors: [] });
      if (value[offset] === ",") offset++;
      continue;
    }
    const end = value.indexOf(",", offset);
    const stop = end < 0 ? value.length : end;
    const descriptors = value.slice(offset, stop).trim();
    candidates.push({ ref, descriptors: descriptors ? descriptors.split(/\s+/) : [] });
    offset = stop + 1;
  }
  return candidates;
}

const htmlRemoved = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "base",
  "template",
  "noscript",
]);
const htmlAttributes = new Set(["ping", "srcdoc", "formaction", "action", "integrity", "nonce", "download", "target"]);
const animationTags = new Set(["set", "animate", "animatemotion", "animatetransform"]);
export async function buildHtmlDocDownload(input: {
  html: string;
  docPath: string;
  title: string;
  resolveAsset: DownloadResolver;
  inlineBudget?: number;
  pause?: () => Promise<void>;
}): Promise<string> {
  const tree = fromHtml(input.html);
  const state = resolverState(input.resolveAsset, input.inlineBudget, input.pause);
  const resource = (value: string) => resourceUrl(value, input.docPath, state);
  async function walk(parent: Root | Element): Promise<void> {
    const children: RootContent[] = [];
    for (const node of parent.children) {
      if (node.type !== "element") {
        if (node.type !== "comment") children.push(node);
        continue;
      }
      const tag = node.tagName.toLowerCase();
      const isLink = tag === "a" || tag === "area";
      if (htmlRemoved.has(tag) || (tag === "meta" && ("httpEquiv" in node.properties || "charSet" in node.properties)))
        continue;
      if (animationTags.has(tag)) {
        const attribute = String(node.properties.attributeName ?? "")
          .trim()
          .toLowerCase();
        if (attribute === "href" || attribute.endsWith(":href")) continue;
      }
      if (tag === "form") {
        await walk(node);
        children.push(...node.children);
        continue;
      }
      stripAttributes(node, htmlAttributes);
      if (tag === "link") {
        const rels = String(node.properties.rel ?? "")
          .toLowerCase()
          .split(/[\s,]+/);
        const path = rels.includes("stylesheet") ? assetPath(String(node.properties.href ?? ""), input.docPath) : null;
        const asset = path ? await state.stylesheet(path) : null;
        if (path && asset) {
          const css = await rewriteCss(new TextDecoder().decode(asset.bytes), path, state, [path]);
          if (css !== null) children.push(style(css, node.properties.media ? { media: node.properties.media } : {}));
        }
        continue;
      }
      if (typeof node.properties.style === "string") {
        const css = await rewriteCss(node.properties.style, input.docPath, state);
        if (css === null) delete node.properties.style;
        else node.properties.style = css;
      }
      if (tag === "html") delete node.properties.manifest;
      const resources = [
        "data",
        "background",
        "src",
        ...(tag === "video" ? ["poster"] : []),
        ...(!isLink ? ["href", "xLinkHref"] : []),
      ];
      for (const key of resources) {
        if (!(key in node.properties)) continue;
        if (tag === "use" && (key === "href" || key === "xLinkHref")) {
          if (!fragment(String(node.properties[key]))) delete node.properties[key];
          continue;
        }
        const value = await resource(String(node.properties[key]));
        if (value === null) delete node.properties[key];
        else node.properties[key] = value;
      }
      if ((tag === "img" || tag === "source") && node.properties.srcSet) {
        const candidates: string[] = [];
        for (const { ref, descriptors } of srcsetCandidates(String(node.properties.srcSet))) {
          if (!ref || !descriptors.every((item) => /^\d+(?:\.\d+)?[wxh]$/.test(item))) continue;
          const value = await resource(ref);
          if (value) candidates.push([value, ...descriptors].join(" "));
        }
        if (candidates.length) node.properties.srcSet = candidates.join(", ");
        else delete node.properties.srcSet;
      }
      if (isLink)
        for (const key of ["href", "xLinkHref"]) {
          const value = String(node.properties[key] ?? "");
          if (absoluteLink(value)) node.properties.rel = rel;
          else if (!fragment(value)) delete node.properties[key];
        }
      if (tag === "style") {
        const css = await rewriteCss(hastText(node), input.docPath, state);
        if (css !== null) children.push(style(css, node.properties));
        continue;
      }
      await walk(node);
      children.push(node);
    }
    // A doctype belongs only to the root; fromHtml enforces this when parsing.
    if (parent.type === "root") parent.children = children;
    else parent.children = children.filter((node): node is ElementContent => node.type !== "doctype");
  }
  await walk(tree);
  let html = tree.children.find((node): node is Element => node.type === "element" && node.tagName === "html");
  if (!html) {
    html = element("html");
    tree.children.push(html);
  }
  let head = html.children.find((node): node is Element => node.type === "element" && node.tagName === "head");
  if (!head) {
    head = element("head");
    html.children.unshift(head);
  }
  head.children.unshift(...headMetas());
  if (!head.children.some((node) => node.type === "element" && node.tagName === "title"))
    head.children.push(element("title", [text(input.title)]));
  let body = html.children.find((node): node is Element => node.type === "element" && node.tagName === "body");
  if (!body) {
    body = element("body");
    html.children.push(body);
  }
  if (state.tooLarge) body.children.unshift(note());
  if (!tree.children.some((node) => node.type === "doctype")) tree.children.unshift({ type: "doctype" });
  return serialize(tree);
}
