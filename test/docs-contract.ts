import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

// Resolve through core's declared dependencies. A missing package is a failure, never a skip.
const core = createRequire(new URL("../packages/core/package.json", import.meta.url));

type MdNode = {
  type: string;
  depth?: number;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  url?: string;
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

function textOf(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  if (node.type === "image" && typeof node.alt === "string") return node.alt;
  return (node.children ?? []).map(textOf).join("");
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

type Page = { root: MdNode; lines: string[]; anchors: Set<string>; headings: { node: MdNode; base: string }[] };

function readPage(text: string): Page {
  const root = parser.parse(text);
  const headings: Page["headings"] = [];
  visit(root, (node) => {
    if (node.type === "heading") headings.push({ node, base: slug(textOf(node)) });
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
  return { root, lines: text.split("\n"), anchors, headings };
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
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

export function checkDocs(root: string): string[] {
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
  if (!isFile(manifestPath)) {
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
  const docs = join(root, "docs");
  const expected = ["setup.md", "usage.md"];
  if (existsSync(join(docs, "setup")))
    for (const name of readdirSync(join(docs, "setup")).sort())
      if (name.endsWith(".md")) expected.push(`setup/${name}`);
  for (const path of expected)
    if (!paths.has(path)) manifestViolation("pages", `docs/${path} is a public page but is not listed`);
  for (const { path, index } of listed)
    if (!isFile(join(docs, path)))
      manifestViolation(`pages.${index}.path`, `the listed page docs/${path} does not exist`);

  const cache = new Map<string, Page | null>();
  const pageAt = (rel: string): Page | null => {
    if (!cache.has(rel))
      cache.set(rel, isFile(join(root, rel)) ? readPage(readFileSync(join(root, rel), "utf8")) : null);
    return cache.get(rel) ?? null;
  };
  const inside = (abs: string): boolean => {
    const rel = relative(root, abs);
    return !rel.startsWith("..") && !isAbsolute(rel);
  };

  // Resolves a relative URL found in `file`; reports a violation and returns undefined when it fails.
  const resolveUrl = (file: string, line: number, url: string): { rel: string; fragment: string } | undefined => {
    const hash = url.indexOf("#");
    const rawPath = (hash < 0 ? url : url.slice(0, hash)).split("?")[0] ?? "";
    const rawFragment = hash < 0 ? "" : url.slice(hash + 1);
    if (rawPath.startsWith("/")) {
      add(file, line, `the link "${url}" must be relative, not start with /`);
      return undefined;
    }
    let decoded: string;
    let fragment: string;
    try {
      decoded = decodeURIComponent(rawPath);
      fragment = decodeURIComponent(rawFragment);
    } catch {
      add(file, line, `the link "${url}" has invalid percent-encoding`);
      return undefined;
    }
    const abs = decoded === "" ? join(root, file) : resolve(root, dirname(file), decoded);
    if (!inside(abs) || !existsSync(abs)) {
      add(file, line, `the link "${url}" does not resolve to a file or folder in the repository`);
      return undefined;
    }
    return { rel: relative(root, abs).split(sep).join(posix.sep), fragment };
  };

  const isRelative = (url: string): boolean => !SCHEME.test(url) && !url.startsWith("//");

  for (const { path, title } of listed) {
    const file = `docs/${path}`;
    if (!isFile(join(root, file))) continue;
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

    const checkUrl = (line: number, url: string) => {
      if (!isRelative(url)) return;
      const target = resolveUrl(file, line, url);
      if (target === undefined || target.fragment === "") return;
      if (!target.rel.endsWith(".md")) return;
      const targetPage = pageAt(target.rel);
      if (targetPage !== null && !targetPage.anchors.has(target.fragment))
        add(file, line, `the link "${url}" has no matching heading anchor in ${target.rel}`);
    };
    const checkImage = (line: number, alt: string | null | undefined, src: string) => {
      if (alt === null || alt === undefined || alt.trim() === "") add(file, line, "an image needs alt text");
      if (!isRelative(src)) return add(file, line, `the image "${src}" must have a relative path`);
      if (src.startsWith("/")) return;
      const abs = resolve(root, dirname(file), decodeSafe(src.split("#")[0] ?? ""));
      const images = join(docs, "images");
      if (!abs.startsWith(images + sep) || !abs.endsWith(".png"))
        add(file, line, `the image "${src}" must be a .png file in docs/images/`);
    };

    visit(page.root, (node) => {
      const line = lineOf(node);
      if (node.type === "link" || node.type === "definition" || node.type === "image") checkUrl(line, node.url ?? "");
      if (node.type === "image") checkImage(line, node.alt, node.url ?? "");

      // Rule 6: fences.
      if (node.type === "code") {
        const info = [node.lang, node.meta].filter((part) => part).join(" ");
        const firstLine = (node.value ?? "").split("\n")[0] ?? "";
        if (info === "") add(file, line, "every code block needs an info string");
        else if (info.includes("prompt") && info !== "text prompt")
          add(file, line, `the info string "${info}" must be exactly "text prompt" for a prompt`);
        else if (node.lang === "text" && info !== "text prompt" && firstLine.startsWith("Rules:"))
          add(file, line, 'a prompt starting with "Rules:" must use the info string "text prompt"');
        if (node.lang === "sh")
          (node.value ?? "").split("\n").forEach((codeLine, offset) => {
            if (/^\s*\$ /.test(codeLine))
              add(file, line + 1 + offset, "an sh command line must not start with a $ prompt");
          });
      }

      // Rule 7 and the img parts of rules 5 and 8: raw HTML.
      if (node.type === "html") {
        const fragment = parse5.parseFragment(node.value ?? "", { sourceCodeLocationInfo: true });
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
              const src = attrs.get("src");
              if (src !== undefined) {
                checkUrl(lineIn(child), src);
                checkImage(lineIn(child), attrs.get("alt"), src);
              } else if (!attrs.has("alt")) checkImage(lineIn(child), undefined, "images/x.png");
            } else add(file, lineIn(child), `raw HTML may not use the element ${child.tagName ?? child.nodeName}`);
          }
        };
        walk(fragment.childNodes);
      }
    });
  }

  // Rule 9: screenshots.
  for (const { file, width, height, index } of shots) {
    const path = join(docs, file);
    if (!isFile(path)) {
      manifestViolation(`screenshots.${index}.file`, `the screenshot docs/${file} does not exist`);
      continue;
    }
    const size = pngSize(path);
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

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
