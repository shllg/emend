import { closeSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";

// Resolve through core's declared dependencies. A missing package is a failure, never a skip.
const core = createRequire(new URL("../packages/core/package.json", import.meta.url));

type MdNode = {
  type: string;
  depth?: number;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  url?: string;
  identifier?: string;
  alt?: string | null;
  children?: MdNode[];
  position?: { start: { line: number } };
};
type MdParser = { parse(text: string): MdNode };
type Unified = () => { use(plugin: unknown): ReturnType<Unified> } & MdParser;

type Attribute = { name: string; value: string };
type Parse5Node = {
  nodeName: string;
  tagName?: string;
  attrs?: Attribute[];
  value?: string;
  childNodes?: Parse5Node[];
  sourceCodeLocation?: { startLine: number } | null;
};
type Parse5 = {
  parseFragment(html: string, options: { sourceCodeLocationInfo: boolean }): { childNodes: Parse5Node[] };
};

const unified = (core("unified") as { unified: Unified }).unified;
const remarkParse = (core("remark-parse") as { default: unknown }).default;
const remarkGfm = (core("remark-gfm") as { default: unknown }).default;
const parse5 = core("parse5") as Parse5;

const parser: MdParser = unified().use(remarkParse).use(remarkGfm);

type Violation = { file: string; line: number; message: string };

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const PAGE_KEYS = ["id", "path", "title", "description"];
const SHOT_KEYS = ["file", "view", "device", "theme", "width", "height"];
const TOP_KEYS = ["schema", "pages", "screenshots"];
const MANIFEST = "docs/site.json";
const SETUP_PAGE = /^docs\/setup\/[^/]+\.md$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Maps a JSON path such as "pages.0.title" to the line where that key or element starts.
function locate(text: string): Map<string, number> {
  const lines = new Map<string, number>();
  let i = 0;
  let line = 1;
  const skip = () => {
    while (i < text.length && /\s/.test(text.charAt(i))) {
      if (text.charAt(i) === "\n") line++;
      i++;
    }
  };
  const string = (): string => {
    const start = i;
    i++;
    while (i < text.length && text.charAt(i) !== '"') i += text.charAt(i) === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (path: string, startLine: number): void => {
    lines.set(path, startLine);
    const first = text.charAt(i);
    if (first === "{") {
      i++;
      skip();
      while (i < text.length && text.charAt(i) !== "}") {
        const keyLine = line;
        const key = string();
        skip();
        i++;
        skip();
        value(path ? `${path}.${key}` : key, keyLine);
        skip();
        if (text.charAt(i) === ",") i++;
        skip();
      }
      i++;
    } else if (first === "[") {
      i++;
      skip();
      let index = 0;
      while (i < text.length && text.charAt(i) !== "]") {
        value(`${path}.${index}`, line);
        index++;
        skip();
        if (text.charAt(i) === ",") i++;
        skip();
      }
      i++;
    } else if (first === '"') {
      string();
    } else {
      while (i < text.length && !/[\s,\]}]/.test(text.charAt(i))) i++;
    }
  };
  skip();
  value("", line);
  return lines;
}

function textOf(node: MdNode, forAnchor = false): string {
  if (forAnchor && (node.type === "image" || node.type === "imageReference" || node.type === "html")) return "";
  if (typeof node.value === "string") return node.value;
  if (node.type === "image" && typeof node.alt === "string") return node.alt;
  return (node.children ?? []).map((child) => textOf(child, forAnchor)).join("");
}

// GitHub's rule: lowercase, drop everything but letters, marks, numbers, connector punctuation,
// hyphens and spaces, then turn each space into a hyphen.
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");

function visit(node: MdNode, callback: (node: MdNode) => void): void {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

const lineOf = (node: MdNode): number => node.position?.start.line ?? 1;

type Page = {
  root: MdNode;
  lines: string[];
  anchors: Set<string>;
  headings: { node: MdNode; base: string }[];
  definitions: Map<string, string>;
};

function readPage(text: string): Page {
  const root = parser.parse(text);
  const headings: Page["headings"] = [];
  const definitions = new Map<string, string>();
  visit(root, (node) => {
    if (node.type === "heading") headings.push({ node, base: slug(textOf(node, true)) });
    if (
      node.type === "definition" &&
      node.identifier !== undefined &&
      node.url !== undefined &&
      !definitions.has(node.identifier)
    )
      definitions.set(node.identifier, node.url);
  });
  const occurrences = new Map<string, number>();
  const anchors = new Set<string>();
  for (const { base } of headings) {
    let result = base;
    while (occurrences.has(result)) {
      const count = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, count);
      result = `${base}-${count}`;
    }
    occurrences.set(result, 0);
    anchors.add(result);
  }
  return { root, lines: text.split("\n"), anchors, headings, definitions };
}

function pngSize(path: string): { width: number; height: number } | string {
  const buffer = Buffer.alloc(24);
  const fd = openSync(path, "r");
  let read: number;
  try {
    read = readSync(fd, buffer, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (read < 24 || !buffer.subarray(0, 8).equals(signature)) return "is not a PNG file (bad signature)";
  if (buffer.toString("latin1", 12, 16) !== "IHDR") return "is not a PNG file (no IHDR chunk first)";
  if (buffer.readUInt32BE(8) !== 13) return "is not a PNG file (IHDR length must be 13)";
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export type TrackedKind = "file" | "link";
type TrackedEntries = ReadonlyMap<string, TrackedKind>;

function publicPages(tracked: TrackedEntries): Set<string> {
  const pages = new Set(["docs/setup.md", "docs/usage.md"]);
  for (const path of tracked.keys()) if (SETUP_PAGE.test(path)) pages.add(path);
  return pages;
}

// A tracked path can have a symlink in its working-tree ancestry, even when its index mode is regular.
function isDirectory(root: string, dir: string): boolean {
  return (
    dir === "." ||
    (isDirectory(root, posix.dirname(dir)) &&
      lstatSync(join(root, dir), { throwIfNoEntry: false })?.isDirectory() === true)
  );
}

function isTrackedFile(root: string, tracked: TrackedEntries, path: string): boolean {
  return (
    tracked.get(path) === "file" &&
    isDirectory(root, posix.dirname(path)) &&
    lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true
  );
}

type PromptFence = { file: string; line: number; text: string };
type Section = { file: string; depth: number; title: string };

export function publicPromptFences(root: string, tracked: TrackedEntries, section?: Section): PromptFence[] {
  const prompts: PromptFence[] = [];
  for (const file of publicPages(tracked)) {
    if ((section && section.file !== file) || !isTrackedFile(root, tracked, file)) continue;
    const page = parser.parse(readFileSync(join(root, file), "utf8"));
    let included = !section;
    for (const block of page.children ?? []) {
      if (section && block.type === "heading" && block.depth !== undefined && block.depth <= section.depth)
        included = block.depth === section.depth && textOf(block) === section.title;
      if (included)
        visit(block, (node) => {
          if (node.type === "code" && node.lang === "text" && node.meta === "prompt")
            prompts.push({ file, line: lineOf(node), text: node.value ?? "" });
        });
    }
  }
  return prompts;
}

export function checkDocs(root: string, tracked: TrackedEntries): string[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const add = (file: string, line: number, message: string) => {
    const key = `${file}:${line}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ file, line, message });
  };
  const finish = (): string[] =>
    violations
      .sort((a, b) =>
        a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.message.localeCompare(b.message),
      )
      .map(({ file, line, message }) => `${file}:${line}: ${message}`);

  const manifestPath = join(root, MANIFEST);
  if (!isTrackedFile(root, tracked, MANIFEST)) {
    add(MANIFEST, 1, "the manifest is missing");
    return finish();
  }
  const manifestText = readFileSync(manifestPath, "utf8");
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    add(MANIFEST, 1, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return finish();
  }
  const places = locate(manifestText);
  const at = (path: string): number => {
    let current = path;
    for (;;) {
      const found = places.get(current);
      if (found !== undefined) return found;
      const cut = current.lastIndexOf(".");
      if (cut < 0) return places.get("") ?? 1;
      current = current.slice(0, cut);
    }
  };
  const manifestViolation = (path: string, message: string) => add(MANIFEST, at(path), message);
  const exactKeys = (value: Record<string, unknown>, keys: string[], path: string) => {
    for (const key of Object.keys(value))
      if (!keys.includes(key)) manifestViolation(path ? `${path}.${key}` : key, `unexpected key "${key}"`);
    for (const key of keys) if (!(key in value)) manifestViolation(path, `missing key "${key}"`);
  };

  // Rule 1: the manifest.
  const listed: { path: string; title: unknown; index: number }[] = [];
  const shots: { file: string; width: unknown; height: unknown; index: number }[] = [];
  if (!isRecord(manifest)) {
    manifestViolation("", "the manifest must be an object");
    return finish();
  }
  exactKeys(manifest, TOP_KEYS, "");
  if (manifest.schema !== 1) manifestViolation("schema", '"schema" must be 1');
  if (!Array.isArray(manifest.pages)) manifestViolation("pages", '"pages" must be an array');
  if (!Array.isArray(manifest.screenshots)) manifestViolation("screenshots", '"screenshots" must be an array');

  const ids = new Set<string>();
  const paths = new Set<string>();
  const expected = publicPages(tracked);
  if (Array.isArray(manifest.pages)) {
    manifest.pages.forEach((page: unknown, index: number) => {
      const base = `pages.${index}`;
      if (!isRecord(page)) {
        manifestViolation(base, "a page entry must be an object");
        return;
      }
      exactKeys(page, PAGE_KEYS, base);
      const { id, path, title, description } = page;
      if (typeof id !== "string" || !ID_PATTERN.test(id)) {
        if ("id" in page) manifestViolation(`${base}.id`, '"id" must be a lowercase slug such as "hub-network"');
      } else if (ids.has(id)) manifestViolation(`${base}.id`, `duplicate page id "${id}"`);
      else ids.add(id);
      if (typeof path !== "string") {
        if ("path" in page) manifestViolation(`${base}.path`, '"path" must be a string');
      } else {
        const problems = (path.endsWith(".md") ? [] : ['must end in ".md"']).concat(
          path.split("/").includes("..") ? ['must not contain a ".." segment'] : [],
          path.startsWith("/") ? ["must not start with /"] : [],
        );
        if (problems.length > 0) manifestViolation(`${base}.path`, `"path" ${problems.join(" and ")}`);
        else if (
          path.includes("\\") ||
          (path !== "usage.md" && path !== "setup.md" && !SETUP_PAGE.test(`docs/${path}`))
        )
          manifestViolation(`${base}.path`, `"${path}" is not a canonical public page path`);
        else if (paths.has(path)) manifestViolation(`${base}.path`, `duplicate page path "${path}"`);
        else {
          paths.add(path);
          listed.push({ path, title, index });
        }
      }
      if (typeof title !== "string" || title === "") {
        if ("title" in page) manifestViolation(`${base}.title`, '"title" must be a non-empty string');
      }
      if (typeof description !== "string") {
        if ("description" in page) manifestViolation(`${base}.description`, '"description" must be a string');
      } else {
        if (description.length < 1 || description.length > 160)
          manifestViolation(
            `${base}.description`,
            `"description" must be 1 to 160 characters, not ${description.length}`,
          );
        if (/[\r\n]/.test(description))
          manifestViolation(`${base}.description`, '"description" must not contain a line break');
        if (!description.endsWith("."))
          manifestViolation(`${base}.description`, '"description" must end with a period');
        if (/[.!?]\s/.test(description)) manifestViolation(`${base}.description`, '"description" must be one sentence');
      }
    });
  }

  const files = new Set<string>();
  if (Array.isArray(manifest.screenshots)) {
    manifest.screenshots.forEach((shot: unknown, index: number) => {
      const base = `screenshots.${index}`;
      if (!isRecord(shot)) {
        manifestViolation(base, "a screenshot entry must be an object");
        return;
      }
      exactKeys(shot, SHOT_KEYS, base);
      const { file, view, device, theme, width, height } = shot;
      const name = typeof file === "string" ? /^images\/([^/]+)\.png$/.exec(file)?.[1] : undefined;
      if (name === undefined) {
        if ("file" in shot) manifestViolation(`${base}.file`, '"file" must be images/<name>.png');
      } else if (files.has(file as string)) manifestViolation(`${base}.file`, `duplicate screenshot file "${file}"`);
      else {
        files.add(file as string);
        shots.push({ file: file as string, width, height, index });
      }
      if (typeof view !== "string" || !ID_PATTERN.test(view)) {
        if ("view" in shot) manifestViolation(`${base}.view`, '"view" must be a lowercase slug such as "review"');
      }
      if (device !== "desktop" && device !== "phone" && "device" in shot)
        manifestViolation(`${base}.device`, '"device" must be "desktop" or "phone"');
      if (theme !== "dark" && theme !== "light" && "theme" in shot)
        manifestViolation(`${base}.theme`, '"theme" must be "dark" or "light"');
      for (const [key, number] of [
        ["width", width],
        ["height", height],
      ] as const)
        if (key in shot && (typeof number !== "number" || !Number.isInteger(number) || number <= 0))
          manifestViolation(`${base}.${key}`, `"${key}" must be a positive integer`);
      if (name !== undefined && typeof view === "string" && typeof device === "string" && typeof theme === "string") {
        const expected = `${view}-${device}${theme === "light" ? "-light" : ""}`;
        if (name !== expected)
          manifestViolation(`${base}.file`, `the file name must be ${expected}.png for this entry`);
      }
    });
  }

  // Rule 2: the page set.
  if (tracked.has("docs/setup")) add("docs/setup", 1, "is not a folder");
  for (const file of expected) {
    if (tracked.get(file) === "link") add(file, 1, "a public page must be a tracked regular file");
    if (!paths.has(file.slice("docs/".length)))
      manifestViolation("pages", `${file} is a public page but is not listed`);
  }
  for (const { path, index } of listed)
    if (!isTrackedFile(root, tracked, `docs/${path}`))
      manifestViolation(`pages.${index}.path`, `the listed page docs/${path} is not a tracked file`);

  const cache = new Map<string, Page | null>();
  const pageAt = (rel: string): Page | null => {
    if (!cache.has(rel))
      cache.set(rel, isTrackedFile(root, tracked, rel) ? readPage(readFileSync(join(root, rel), "utf8")) : null);
    return cache.get(rel) ?? null;
  };
  const folders = new Set<string>();
  for (const path of tracked.keys()) {
    let dir = posix.dirname(path);
    while (!folders.has(dir)) {
      folders.add(dir);
      if (dir === ".") break;
      dir = posix.dirname(dir);
    }
  }

  const resolveUrl = (file: string, line: number, url: string, image: boolean) => {
    const scheme = SCHEME.exec(url)?.[0].toLowerCase();
    if (scheme || url.startsWith("//")) {
      if (image) add(file, line, `the image "${url}" must have a relative path`);
      else if (!scheme)
        add(file, line, `the link "${url}" needs an explicit http:, https: or mailto: scheme, or a relative path`);
      else if (!["http:", "https:", "mailto:"].includes(scheme))
        add(file, line, `the link "${url}" has a disallowed URL scheme`);
      return;
    }
    const hash = url.indexOf("#");
    const pathAndQuery = hash < 0 ? url : url.slice(0, hash);
    const queryStart = pathAndQuery.indexOf("?");
    const rawPath = queryStart < 0 ? pathAndQuery : pathAndQuery.slice(0, queryStart);
    const query = queryStart < 0 ? undefined : pathAndQuery.slice(queryStart + 1);
    let decoded: string;
    let fragment: string | undefined;
    try {
      decoded = decodeURIComponent(rawPath);
      if (hash >= 0) fragment = decodeURIComponent(url.slice(hash + 1));
    } catch {
      add(file, line, `the link "${url}" has invalid percent-encoding`);
      return undefined;
    }
    if (decoded.startsWith("/")) {
      add(file, line, `the link "${url}" must be relative, not start with /`);
      return;
    }
    const rel = decoded === "" ? file : posix.join(posix.dirname(file), decoded).replace(/\/$/, "");
    const folder = folders.has(rel) && isDirectory(root, rel);
    if (!folder && !isTrackedFile(root, tracked, rel)) {
      add(file, line, `the target "${url}" is not a tracked file or a folder containing one`);
      return;
    }
    return { rel, query, fragment, folder };
  };

  for (const { path, title } of listed) {
    const file = `docs/${path}`;
    const page = pageAt(file);
    if (page === null) continue;
    const { lines } = page;
    const blocks = page.root.children ?? [];

    // Rule 3: front matter, H1, lead.
    const first = lines[0] ?? "";
    if (first.startsWith("---") || first.startsWith("+++")) add(file, 1, "a public page has no front matter");
    const h1 = blocks[0];
    if (!(h1?.type === "heading" && h1.depth === 1 && first.startsWith("# ")))
      add(file, 1, "line 1 must be the page's H1, written as # <title>");
    else {
      if (typeof title === "string" && textOf(h1) !== title)
        add(file, 1, `the H1 "${textOf(h1)}" must equal the manifest title "${title}"`);
      if (blocks[1]?.type !== "paragraph")
        add(file, blocks[1] ? lineOf(blocks[1]) : 2, "a paragraph, the lead, must follow the H1");
    }
    for (const { node } of page.headings)
      if (node.depth === 1 && node !== h1) add(file, lineOf(node), "a page has only one H1, on its first line");

    // Rule 4: heading anchors.
    const bases = new Set<string>();
    for (const { node, base } of page.headings) {
      if (bases.has(base)) add(file, lineOf(node), `the heading anchor #${base} is already used by an earlier heading`);
      bases.add(base);
    }

    const checkUrl = (line: number, url: string, image = false) => {
      const target = resolveUrl(file, line, url, image);
      if (image && target && (target.folder || !target.rel.startsWith("docs/images/") || !target.rel.endsWith(".png")))
        add(file, line, `the image "${url}" must be a .png file in docs/images/`);
      if (target?.fragment === undefined) return;
      if (target.folder) add(file, line, `the link "${url}" cannot have a fragment on a folder`);
      else if (target.rel.endsWith(".md") && target.query !== "plain=1") {
        if (target.fragment && !pageAt(target.rel)?.anchors.has(target.fragment))
          add(file, line, `the link "${url}" has no matching heading anchor in ${target.rel}`);
      } else {
        const text = readTextFile(join(root, target.rel));
        if (text === undefined) add(file, line, `a line fragment needs a text file: "${url}"`);
        else if (!validLineFragment(text, target.fragment))
          add(file, line, `the link "${url}" needs a valid line fragment in ${target.rel}`);
      }
    };
    const checkImage = (line: number, alt: string | null | undefined, src: string | undefined) => {
      if (alt === null || alt === undefined || alt.trim() === "") add(file, line, "an image needs alt text");
      if (src !== undefined) checkUrl(line, src, true);
    };

    visit(page.root, (node) => {
      const line = lineOf(node);
      if (node.type === "link" || node.type === "definition") checkUrl(line, node.url ?? "");
      if (node.type === "image") checkImage(line, node.alt, node.url);
      if (node.type === "imageReference") checkImage(line, node.alt, page.definitions.get(node.identifier ?? ""));

      // Rule 6: fences.
      if (node.type === "code") {
        const info = [node.lang, node.meta].filter((part) => part).join(" ");
        const firstLine = (node.value ?? "").split("\n")[0] ?? "";
        if (info === "") add(file, line, "every code block needs an info string");
        if (info.includes("prompt") && info !== "text prompt")
          add(file, line, `the info string "${info}" must be exactly "text prompt" for a prompt`);
        else if (info !== "text prompt" && firstLine.startsWith("Rules:"))
          add(file, line, 'a prompt starting with "Rules:" must use the info string "text prompt"');
        if (node.lang === "sh")
          (node.value ?? "").split("\n").forEach((codeLine, offset) => {
            if (/^\s*\$ /.test(codeLine))
              add(file, line + 1 + offset, "an sh command line must not start with a $ prompt");
          });
      }

      // Rule 7 and the img parts of rules 5 and 8: raw HTML.
      if (node.type === "html") {
        const html = node.value ?? "";
        if (/<(?=[a-zA-Z/!?])(?!(?:p>|\/p>|img[\s/>]))/.test(html))
          add(file, line, "raw HTML contains a disallowed tag");
        const fragment = parse5.parseFragment(html, { sourceCodeLocationInfo: true });
        const lineIn = (child: Parse5Node) => line + (child.sourceCodeLocation?.startLine ?? 1) - 1;
        const walk = (children: Parse5Node[]) => {
          for (const child of children) {
            if (child.nodeName === "#text") {
              if ((child.value ?? "").trim() !== "")
                add(file, lineIn(child), "raw HTML may hold only p and img elements, not text");
            } else if (child.nodeName === "#comment") add(file, lineIn(child), "raw HTML may not hold comments");
            else if (child.tagName === "p") {
              if ((child.attrs ?? []).length > 0) add(file, lineIn(child), "a p element may not have attributes");
              walk(child.childNodes ?? []);
            } else if (child.tagName === "img") {
              const attrs = new Map((child.attrs ?? []).map(({ name, value }) => [name, value]));
              const extra = [...attrs.keys()].filter((name) => !["src", "alt", "width"].includes(name));
              if (extra.length > 0)
                add(file, lineIn(child), `an img element may not have the attribute ${extra.join(", ")}`);
              if (!attrs.has("src") || !attrs.has("alt")) add(file, lineIn(child), "an img element needs src and alt");
              checkImage(lineIn(child), attrs.get("alt"), attrs.get("src"));
            } else add(file, lineIn(child), `raw HTML may not use the element ${child.tagName ?? child.nodeName}`);
          }
        };
        walk(fragment.childNodes);
      }
    });
  }

  // Read each tracked image header once, including images outside the screenshot manifest.
  const imageSizes = new Map<string, ReturnType<typeof pngSize>>();
  for (const path of tracked.keys()) {
    if (!path.startsWith("docs/images/")) continue;
    if (!isTrackedFile(root, tracked, path)) add(path, 1, "an image must be a tracked regular file");
    else if (!path.endsWith(".png")) add(path, 1, "an image file name must end in .png");
    else {
      const size = pngSize(join(root, path));
      imageSizes.set(path, size);
      if (typeof size === "string") add(path, 1, size);
    }
  }

  // Rule 9: screenshots.
  for (const { file, width, height, index } of shots) {
    const path = `docs/${file}`;
    const size = imageSizes.get(path);
    if (size === undefined) {
      manifestViolation(`screenshots.${index}.file`, `the screenshot docs/${file} is not a tracked file`);
      continue;
    }
    if (typeof size === "string") manifestViolation(`screenshots.${index}.file`, `docs/${file} ${size}`);
    else {
      if (typeof width === "number" && size.width !== width)
        manifestViolation(
          `screenshots.${index}.width`,
          `docs/${file} is ${size.width} pixels wide, the manifest says ${width}`,
        );
      if (typeof height === "number" && size.height !== height)
        manifestViolation(
          `screenshots.${index}.height`,
          `docs/${file} is ${size.height} pixels high, the manifest says ${height}`,
        );
    }
  }

  return finish();
}

function readTextFile(path: string): string | undefined {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 8000).includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function validLineFragment(text: string, fragment: string): boolean {
  const range = /^L(\d+)(?:-L(\d+))?$/.exec(fragment);
  if (!range) return false;
  const start = Number(range[1]);
  const end = Number(range[2] ?? start);
  if (start < 1 || end < start) return false;
  const lines = text.split(/\r\n|\n|\r/);
  const count = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  return end <= count;
}
