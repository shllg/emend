// Deterministic gzip budgets for each route's static-import closure.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export type Manifest = Record<string, { file: string; imports?: string[]; assets?: string[] }>;
export type Budgets = Record<string, { roots: string[]; gzipBytes: number }>;
export interface BundleSize {
  route: string;
  gzipBytes: number;
  budget: number;
  files: string[];
}

const CLASSIC_SCRIPT_TYPES = new Set([
  "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
  "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
  "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
  "text/x-ecmascript", "text/x-javascript",
]);

export function measureBundles(dist: string, manifest: Manifest, budgets: Budgets): BundleSize[] {
  const root = realpathSync(dist);
  return Object.entries(budgets).map(([route, budget]) => {
    const visited = new Set<string>();
    const files = new Set<string>();
    function buildPath(file: string): string {
      const path = resolve(root, file);
      const contained = (path: string) => {
        const fromRoot = relative(root, path);
        return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
      };
      if (!contained(path)) throw new Error(`${route}: script path outside build folder`);
      const real = realpathSync(path);
      if (!contained(real)) throw new Error(`${route}: script path outside build folder`);
      return real;
    }
    function addFile(file: string): void {
      files.add(relative(root, buildPath(file)));
    }
    function visit(key: string): void {
      if (visited.has(key)) return;
      visited.add(key);
      const chunk = manifest[key];
      if (!chunk) throw new Error(`${route}: missing manifest root or import ${key}`);
      if (/\.[cm]?js$/.test(chunk.file)) addFile(chunk.file);
      for (const asset of chunk.assets ?? []) if (/\.[cm]?js$/.test(asset)) addFile(asset);
      for (const dependency of chunk.imports ?? []) visit(dependency);
    }
    if (!budget.roots.length || !Number.isSafeInteger(budget.gzipBytes) || budget.gzipBytes < 0)
      throw new Error(`${route}: invalid bundle budget`);
    budget.roots.forEach(visit);
    if (budget.roots.includes("index.html")) {
      const html = readFileSync(buildPath("index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
      for (const script of html.matchAll(/<script\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
        const attributes = new Map([...script[1].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
          .map((match) => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]]));
        const type = (attributes.get("type") ?? "").trim().toLowerCase();
        if (type && !CLASSIC_SCRIPT_TYPES.has(type.split(";", 1)[0].trim())) continue;
        const src = attributes.get("src");
        if (src?.startsWith("/") && !src.startsWith("//")) {
          const path = decodeURIComponent(src.split(/[?#]/)[0]);
          addFile(`.${path}`);
        }
      }
    }
    const gzipBytes = [...files].reduce(
      (total, file) => total + gzipSync(readFileSync(join(root, file)), { level: 9 }).length,
      0,
    );
    return { route, gzipBytes, budget: budget.gzipBytes, files: [...files].sort() };
  });
}

export function checkBundles(sizes: BundleSize[]): string {
  const exceeded = sizes.filter((size) => size.gzipBytes > size.budget);
  if (exceeded.length)
    throw new Error(exceeded.map((s) => `${s.route}: ${s.gzipBytes} gzip bytes exceeds budget ${s.budget}`).join("\n"));
  return `Bundles: ${sizes.map((s) => `${s.route} ${s.gzipBytes}/${s.budget} gzip bytes`).join(", ")}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const web = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/web");
    console.log(
      checkBundles(
        measureBundles(
          join(web, "dist"),
          JSON.parse(readFileSync(join(web, "dist/.vite/manifest.json"), "utf8")),
          JSON.parse(readFileSync(join(web, "bundle-budget.json"), "utf8")),
        ),
      ),
    );
  } catch (error) {
    console.error(`check:bundle: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
