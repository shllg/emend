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
import { parseDocHtml } from "../place/html.ts";
import type { HtmlElement as Element, HtmlRoot as Root } from "./blocks.ts";
import {
  asciiLower,
  type CssContext,
  CssStack,
  CssTextBuffer,
  type CssToken,
  checkDownloadCss,
  closeCss,
  cssCloser,
  cssOpener,
  cssTokenize,
  cssTrivia,
  escapeCssToken,
  isImageFunction,
  isImageSet,
  isIndirectReference,
  utf8Length,
} from "./download-css.ts";
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
const HTML_ELEMENT_LIMIT = 200_000;
const BASE64_CHUNK_BYTES = 3 * 1024 * 1024;

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
  `\uFEFF${unified().use(rehypeStringify, { allowDangerousCharacters: false }).stringify(tree)}`;
const note = () =>
  element("p", [text("Some content was left out of this download because it passed a size or processing limit.")], {
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
async function dataUri(asset: DownloadAsset, pause?: () => Promise<void>): Promise<string> {
  const encoded: string[] = [];
  for (let offset = 0; offset < asset.bytes.length; offset += BASE64_CHUNK_BYTES) {
    if (offset) await pause?.();
    const end = Math.min(offset + BASE64_CHUNK_BYTES, asset.bytes.length);
    const chunks: string[] = [];
    for (let i = offset; i < end; i += 0x8000)
      chunks.push(String.fromCharCode(...asset.bytes.subarray(i, Math.min(i + 0x8000, end))));
    encoded.push(btoa(chunks.join("")));
  }
  return `data:${asset.mediaType};base64,${encoded.join("")}`;
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
  let elementsSincePause = 0;
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
    element(): Promise<void> | undefined {
      if (++elementsSincePause < 1000) return;
      elementsSincePause = 0;
      return pause?.();
    },
    cssAvailable(): boolean {
      if (cssWork < CSS_WORK_BYTES) return true;
      state.tooLarge = true;
      return false;
    },
    beginCss(css: string): number | null {
      if (!state.cssAvailable()) return null;
      const bytes = utf8Length(css);
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
    async data(asset: DownloadAsset, suffix = ""): Promise<string | null> {
      const length =
        utf8Length(`data:${asset.mediaType};base64,`) + 4 * Math.ceil(asset.bytes.length / 3) + utf8Length(suffix);
      return state.take(length) ? (await dataUri(asset, pause)) + suffix : null;
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
    if (node.type !== "element") continue;
    const visited = state.element();
    if (visited) await visited;
    if (blockRemoved.has(node.tagName.toLowerCase())) continue;
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
      const uri = await state.data(asset);
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
      if (!parseDocHtml(block.html, HTML_ELEMENT_LIMIT)) {
        state.tooLarge = true;
        continue;
      }
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
    content:
      | { kind: "markdown"; blocks: RenderedBlock[] }
      | { kind: "source"; lines: SourceContent["lines"]; unrendered?: true };
  },
): Promise<string> {
  const state = resolverState(input.resolveMedia, input.inlineBudget, input.pause);
  let content: ElementContent[];
  if (input.content.kind === "markdown") content = await blocksContent(input.content.blocks, state);
  else if (input.content.unrendered) content = [element("p", [text("This file could not be shown.")])];
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
const resourceType = (asset: DownloadAsset) =>
  /^(?:(?:image|audio|video|font)\/[^;\s]+|text\/vtt)$/i.test(asset.mediaType);
const mediaData = /^data:(?:image\/[^;,\s]+|audio\/[^;,\s]+|video\/[^;,\s]+|text\/vtt)(?:;[^,]*)?,/i;
const cssQuote = (value: string) =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("<", "\\3c ")
    .replaceAll("&", "\\26 ")
    .replace(/\r\n|[\r\n\f]/g, "\\a ")}"`;

async function resourceUrl(value: string, basePath: string, state: AssetState, css = false): Promise<string | null> {
  const pending = state.reference();
  if (pending) await pending;
  if (fragment(value)) return value;
  if ((css ? /^data:/i : mediaData).test(value)) return state.take(utf8Length(value)) ? value : null;
  const path = assetPath(value, basePath);
  const asset = path ? await state.get(path) : null;
  return asset && resourceType(asset) ? state.data(asset, referenceFragment(value)) : null;
}

const CSS_REFERENCE_CONTEXT = 4;
const CSS_IMAGE_SET_CONTEXT = 8;
const IMPORT_PRELUDE_TOKENS = 64;
const IMPORT_PRELUDE_BYTES = 4096;
// Retain only unsafe function offsets, not tokens or bracket objects.
async function nestedImageSets(css: string, state: AssetState): Promise<Set<number>> {
  const nested = new Set<number>();
  const stack = new CssStack();
  const images = new CssStack(true);
  const references = new CssStack(true);
  const indirectStarts = new CssStack(true);
  let indirectCount = 0;
  for (const token of cssTokenize(css)) {
    const pending = state.tokenizedCss(utf8Length(css, token.start, token.end));
    if (pending) await pending;
    const name = token.kind === "function" ? asciiLower(token.value) : "";
    if (isIndirectReference(name)) indirectCount++;
    const opener = cssOpener(token);
    if (opener) {
      const image = isImageSet(name);
      const reference = isImageFunction(name);
      if (image) {
        const parent = images.top();
        if (parent !== undefined) nested.add(parent);
        images.push(token.start);
      }
      if (reference) {
        references.push(token.start);
        indirectStarts.push(indirectCount);
      }
      stack.push(opener | (image ? CSS_IMAGE_SET_CONTEXT : 0) | (reference ? CSS_REFERENCE_CONTEXT : 0));
    } else {
      const closed = closeCss(stack, token);
      if (closed & CSS_IMAGE_SET_CONTEXT) images.pop();
      if (closed & CSS_REFERENCE_CONTEXT) {
        const offset = references.pop();
        if (indirectStarts.pop() !== indirectCount && offset !== undefined) nested.add(offset);
      }
    }
  }
  // CSS closes open functions at EOF as well.
  while (references.length) {
    const offset = references.pop();
    if (indirectStarts.pop() !== indirectCount && offset !== undefined) nested.add(offset);
  }
  return nested;
}
function cssWritten(token: CssToken, css: string): string {
  const raw = css.slice(token.start, token.end);
  if (token.kind === "comment")
    return raw.replaceAll("<", "\\3c ").replaceAll("&", "\\26 ") + (token.unterminated ? "*/" : "");
  if (token.kind === "cdo") return " ";
  if (token.kind === "delim" && token.value === "&") return "&/**/";
  const written = escapeCssToken(raw, token.kind, token.end === css.length);
  return written + (token.kind === "string" && token.unterminated ? raw.charAt(0) : "");
}
const dangerousAfterLessThan = (value: string) => /^[a-z/!?]/i.test(value);

/** Only a bounded import prelude reaches this parser (64 tokens, 4 KiB). */
function cssImport(tokens: CssToken[], css: string): { reference: string; open: string; close: string } | null {
  const ends = new Uint8Array(tokens.length);
  const stack = new CssStack();
  for (const [index, token] of tokens.entries()) {
    if (token.unterminated || token.kind === "bad-string" || token.kind === "bad-url") return null;
    ends[index] = index;
    if (cssOpener(token)) {
      ends[index] = tokens.length;
      stack.push(index);
    } else {
      const open = stack.top();
      const opener = open === undefined ? undefined : tokens[open];
      if (open !== undefined && opener && cssCloser(token) === cssOpener(opener)) {
        ends[open] = index;
        stack.pop();
      }
    }
  }
  const after = (index: number) => Math.min((ends[index] ?? index) + 1, tokens.length);
  const skipTrivia = (index: number, end = tokens.length) => {
    while (index < end) {
      const token = tokens[index];
      if (!token || !cssTrivia(token)) break;
      index++;
    }
    return index;
  };
  let index = skipTrivia(0);
  const ref = tokens[index];
  let reference: string | null = null;
  if (ref?.kind === "string" || ref?.kind === "url") reference = ref.value;
  else if (ref?.kind === "function" && asciiLower(ref.value) === "url") {
    const end = ends[index] ?? tokens.length;
    const arg = skipTrivia(index + 1, end);
    const token = tokens[arg];
    if (token?.kind === "string" && skipTrivia(arg + 1, end) === end) reference = token.value;
  }
  if (reference === null) return null;
  index = after(index);
  for (let i = index; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) break;
    if (
      token.kind === "url" ||
      token.kind === "bad-url" ||
      (token.kind === "function" &&
        ["url", "src", "image", "image-set", "-webkit-image-set"].includes(asciiLower(token.value))) ||
      (token.kind === "punct" && "{}".includes(token.value))
    )
      return null;
  }
  const writtenRange = (start: number, end: number) => {
    const parts: string[] = [];
    let previous = "";
    for (let i = start; i < end; i++) {
      const token = tokens[i];
      if (!token) break;
      let value = token.kind === "comment" ? " " : cssWritten(token, css);
      if (previous === "<" && dangerousAfterLessThan(value)) value = ` ${value}`;
      parts.push(value);
      if (value) previous = value.charAt(value.length - 1);
    }
    return parts.join("");
  };
  const wrappers: string[] = [];
  index = skipTrivia(index);
  let token = tokens[index];
  if (token && asciiLower(token.value) === "layer") {
    if (token.kind === "ident") {
      wrappers.push("@layer { ");
      index++;
    } else if (token.kind === "function") {
      wrappers.push(`@layer ${writtenRange(index + 1, ends[index] ?? tokens.length).trim()} { `);
      index = after(index);
    }
  }
  index = skipTrivia(index);
  token = tokens[index];
  if (token?.kind === "function" && asciiLower(token.value) === "supports") {
    wrappers.push(`@supports (${writtenRange(index + 1, ends[index] ?? tokens.length)}) { `);
    index = after(index);
  }
  const media = writtenRange(index, tokens.length).trim();
  if (media) wrappers.push(`@media ${media} { `);
  return { reference, open: wrappers.join(""), close: " }".repeat(wrappers.length) };
}

async function rewriteCss(
  css: string,
  basePath: string,
  state: AssetState,
  chain: string[] = [],
  context: CssContext = "stylesheet",
): Promise<string | null> {
  // Imported sheets share the work budget; only their final joined text is validated.
  if (state.beginCss(css) === null) return null;
  const nested = await nestedImageSets(css, state);
  const checkpoint = state.used;
  const output = new CssTextBuffer();
  let last = "";
  let sourceStart = -1;
  let sourceEnd = 0;
  const flushSource = () => {
    if (sourceStart < 0) return;
    output.push(css.slice(sourceStart, sourceEnd));
    sourceStart = -1;
  };
  const append = (value: string, charged = 0) => {
    if (last === "<" && dangerousAfterLessThan(value)) value = ` ${value}`;
    if (!state.take(utf8Length(value) - charged)) return false;
    flushSource();
    if (value) last = value.charAt(value.length - 1);
    output.push(value);
    return true;
  };
  // A replacement must not combine its neighbours into a new CSS token.
  const replace = (value: string, charged = 0) => append(`/**/${value}/**/`, charged);
  const boundary = () => append("/**/");
  const appendSource = (token: CssToken) => {
    if (last === "<" && dangerousAfterLessThan(css.charAt(token.start)) && !append(" ")) return false;
    if (!state.take(utf8Length(css, token.start, token.end))) return false;
    if (sourceEnd !== token.start) flushSource();
    if (sourceStart < 0) sourceStart = token.start;
    sourceEnd = token.end;
    last = css.charAt(token.end - 1);
    return true;
  };
  const appendToken = (token: CssToken) => {
    if (token.kind === "delim" && token.value === "&") return append(cssWritten(token, css));
    // These tokens cannot contain an HTML opener internally. Avoid allocating a piece per delimiter.
    if (["punct", "delim", "space", "number", "percentage", "cdc"].includes(token.kind)) return appendSource(token);
    const value = cssWritten(token, css);
    if (value === css.slice(token.start, token.end)) return appendSource(token);
    return token.kind === "cdo" ? replace(value) : append(value);
  };
  const drop = () => {
    state.used = checkpoint;
    return null;
  };
  const appendReference = async (value: string | null, quoted = false) => {
    const before = state.used;
    const uri = value === null ? null : await resourceUrl(value, basePath, state, true);
    const quotedUri = cssQuote(uri ?? "data:,");
    if (replace(quoted ? quotedUri : `url(${quotedUri})`, state.used - before)) return true;
    state.used = before;
    return replace(quoted ? '"data:,"' : 'url("data:,")');
  };
  const tokens = cssTokenize(css);
  let pending: Promise<void> | undefined;
  let tokenBytes = 0;
  const next = (): CssToken | undefined => {
    const result = tokens.next();
    if (result.done) return;
    tokenBytes = utf8Length(css, result.value.start, result.value.end);
    pending = state.tokenizedCss(tokenBytes);
    return result.value;
  };
  // Consume a component value without retaining its tokens. A reference accepts just one string.
  const consumeBlock = async (closer: number, reference = false): Promise<string | null> => {
    const stack = new CssStack();
    stack.push(closer);
    let value: string | null = null;
    let valid = true;
    for (let token = next(); token; token = next()) {
      if (pending) await pending;
      const open = cssOpener(token);
      if (!open && closeCss(stack, token) && !stack.length) break;
      if (reference && !cssTrivia(token)) {
        if (stack.length === 1 && token.kind === "string" && value === null) value = token.value;
        else valid = false;
      }
      if (open) stack.push(open);
    }
    return valid ? value : null;
  };
  const consumeImport = async (): Promise<CssToken[] | null> => {
    const prelude: CssToken[] = [];
    const stack = new CssStack();
    let bytes = 0;
    let oversized = false;
    for (let token = next(); token; token = next()) {
      if (pending) await pending;
      if (!stack.length && token.kind === "punct") {
        if (token.value === ";") break;
        if (token.value === "{") {
          await consumeBlock(3);
          return null;
        }
      }
      bytes += tokenBytes;
      if (!oversized) {
        if (bytes > IMPORT_PRELUDE_BYTES || prelude.length === IMPORT_PRELUDE_TOKENS) {
          oversized = true;
          state.tooLarge = true;
          prelude.length = 0;
        } else prelude.push(token);
      }
      const opener = cssOpener(token);
      if (opener) stack.push(opener);
      else closeCss(stack, token);
    }
    return oversized ? null : prelude;
  };
  const contexts = new CssStack();
  let namespace = false;
  for (let token = next(); token; token = next()) {
    if (pending) await pending;
    if (namespace) {
      if (!contexts.length && token.kind === "punct" && ";{}".includes(token.value)) {
        namespace = false;
      } else {
        if (!appendToken(token)) return drop();
        const opener = cssOpener(token);
        if (opener) contexts.push(opener);
        else closeCss(contexts, token);
        continue;
      }
      // Leave the terminator to the normal token handling below.
    }
    const name = token.kind === "at" || token.kind === "function" ? asciiLower(token.value) : "";
    if (token.kind === "at" && name === "charset") {
      if (!boundary()) return drop();
      for (let part = next(); part; part = next()) {
        if (pending) await pending;
        if (part.kind === "punct" && part.value === ";") break;
      }
      if (!boundary()) return drop();
      continue;
    }
    if (token.kind === "at" && name === "namespace" && context === "stylesheet" && !contexts.length) {
      // Namespace URLs are identifiers, never fetched. Preserve the prelude without buffering it.
      if (!appendToken(token)) return drop();
      namespace = true;
      continue;
    }
    if (token.kind === "at" && name === "import") {
      if (!boundary()) return drop();
      const prelude = await consumeImport();
      const rule = prelude ? cssImport(prelude, css) : null;
      const path = rule ? assetPath(rule.reference, basePath) : null;
      if (path && rule && chain.length < 4 && !chain.includes(path)) {
        const asset = await state.stylesheet(path);
        if (asset) {
          const before = state.used;
          if (state.take(utf8Length(rule.open) + utf8Length(rule.close))) {
            const imported = await rewriteCss(new TextDecoder().decode(asset.bytes), path, state, [...chain, path]);
            if (imported !== null) {
              if (!append(rule.open + imported + rule.close, state.used - before)) return drop();
            } else state.used = before;
          }
        }
      }
      if (!boundary()) return drop();
      continue;
    }
    if (token.kind === "url" || token.kind === "bad-url") {
      if (!(await appendReference(token.kind === "url" ? token.value : null))) return drop();
    } else if (token.kind === "function" && (name === "url" || name === "src")) {
      const reference = await consumeBlock(1, true);
      if (!(await appendReference(reference))) return drop();
    } else if (token.kind === "function" && nested.has(token.start)) {
      if (!replace("none")) return drop();
      await consumeBlock(1);
    } else {
      if (token.kind === "string" && (contexts.top() ?? 0) & CSS_REFERENCE_CONTEXT) {
        if (!(await appendReference(token.value, true))) return drop();
      } else if (!appendToken(token)) return drop();
      const opener = cssOpener(token);
      if (opener) {
        const reference = token.kind === "function" && isImageFunction(name);
        contexts.push(opener | (reference ? CSS_REFERENCE_CONTEXT : 0));
      } else closeCss(contexts, token);
    }
  }
  flushSource();
  return output.finish();
}

/** Check once, after imports and HTML escaping, on exactly the text the file will contain. */
async function finalCss(
  css: string,
  basePath: string,
  state: AssetState,
  chain: string[] = [],
  context: CssContext = "stylesheet",
): Promise<string | null> {
  const checkpoint = state.used;
  const rewritten = await rewriteCss(css, basePath, state, chain, context);
  if (rewritten === null) return null;
  const written = escapeCssText(rewritten);
  if (
    (written !== rewritten && !state.take(utf8Length(written) - utf8Length(rewritten))) ||
    state.beginCss(written) === null
  ) {
    state.used = checkpoint;
    return null;
  }
  const checked = await checkDownloadCss(written, (bytes) => state.tokenizedCss(bytes), context);
  if (checked === null) {
    state.tooLarge = true;
    state.used = checkpoint;
  }
  return checked;
}

// HTML srcset candidates: only whitespace ends a URL; trailing commas end a candidate.
function srcsetCandidates(value: string): { ref: string; descriptors: string[] }[] {
  const candidates: { ref: string; descriptors: string[] }[] = [];
  let offset = 0;
  while (offset < value.length) {
    while (/[\t\n\f\r ,]/.test(value[offset] ?? "")) offset++;
    const start = offset;
    while (offset < value.length && !/[\t\n\f\r ]/.test(value[offset] ?? "")) offset++;
    let urlEnd = offset;
    while (urlEnd > start && value[urlEnd - 1] === ",") urlEnd--;
    const ref = value.slice(start, urlEnd);
    if (!ref) break;
    if (urlEnd < offset || value[offset] === ",") {
      candidates.push({ ref, descriptors: [] });
      if (value[offset] === ",") offset++;
      continue;
    }
    let stop = offset;
    let parentheses = 0;
    while (stop < value.length) {
      const char = value[stop];
      if (char === "," && parentheses === 0) break;
      if (char === "(") parentheses++;
      else if (char === ")" && parentheses > 0) parentheses--;
      stop++;
    }
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
// SVG HAST uses camelCase; HTML elements retain hyphenated or lowercase attribute names.
const cssResourceAttributes = new Set([
  "fill",
  "stroke",
  "filter",
  "clippath",
  "mask",
  "markerstart",
  "markermid",
  "markerend",
  "cursor",
  "values",
  "from",
  "to",
  "by",
  "marker",
]);
export async function buildHtmlDocDownload(input: {
  html: string;
  docPath: string;
  title: string;
  resolveAsset: DownloadResolver;
  inlineBudget?: number;
  pause?: () => Promise<void>;
}): Promise<string> {
  if (!parseDocHtml(input.html, HTML_ELEMENT_LIMIT))
    return serialize({
      type: "root",
      children: [
        { type: "doctype" },
        element(
          "html",
          [
            element("head", [...headMetas(), element("title", [text(input.title)]), style(READING_STYLES)]),
            element("body", [note()]),
          ],
          { lang: "en" },
        ),
      ],
    });
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
      const visited = state.element();
      if (visited) await visited;
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
        const path =
          rels.includes("stylesheet") && !rels.includes("alternate") && !("disabled" in node.properties)
            ? assetPath(String(node.properties.href ?? ""), input.docPath)
            : null;
        const asset = path ? await state.stylesheet(path) : null;
        if (path && asset) {
          const css = await finalCss(new TextDecoder().decode(asset.bytes), path, state, [path]);
          if (css !== null) children.push(style(css, node.properties.media ? { media: node.properties.media } : {}));
        }
        continue;
      }
      if (typeof node.properties.style === "string") {
        const css = await finalCss(node.properties.style, input.docPath, state, [], "attribute");
        if (css === null) delete node.properties.style;
        else node.properties.style = css;
      }
      if (tag === "html") delete node.properties.manifest;
      for (const [key, raw] of Object.entries(node.properties)) {
        if (!cssResourceAttributes.has(key.toLowerCase().replaceAll("-", ""))) continue;
        const value = String(raw);
        if (
          state.beginCss(value) === null ||
          (await checkDownloadCss(value, (bytes) => state.tokenizedCss(bytes), "attribute", "fragment")) === null
        )
          delete node.properties[key];
      }
      const resources = [
        "data",
        "background",
        "src",
        ...(tag === "video" ? ["poster"] : []),
        ...(!isLink ? ["href", "xLinkHref"] : []),
      ];
      for (const key of resources) {
        if (!(key in node.properties)) continue;
        if (!(tag === "image" || tag === "feimage") && (key === "href" || key === "xLinkHref")) {
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
        const css = await finalCss(hastText(node), input.docPath, state);
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
