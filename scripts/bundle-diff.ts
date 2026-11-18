// Compare route gzip sizes with main; growth is reported, never a command failure.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measureBundles } from "./check-bundle.ts";
import { buildEnvironment, checkBuildResult, exportMainCommit, pnpmExecutable, redactFailure, resolveCommit } from "./perf.ts";
import { createSealedLifecycle } from "./screenshots/sealed.ts";

export interface BundleSizes {
  sizes: Record<string, number>;
  budgets: Record<string, number>;
}
interface BundleRow {
  route: string;
  base: number | null;
  head: number | null;
  delta: number | null;
  status: "grew" | "shrank" | "same" | "new" | "removed";
}
interface CeilingChange {
  route: string;
  old: number | null;
  new: number | null;
  change: "raised" | "lowered" | "added" | "removed";
}
interface BaseCache extends BundleSizes {
  schemaVersion: 1;
  sha: string;
}

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THRESHOLD_BYTES = 5000;
export const USAGE = "Usage: node scripts/bundle-diff.ts [--base <commit>] [--json <file>]";

export function parseArgs(argv: string[]) {
  const options = { base: undefined as string | undefined, json: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--base", "--json"].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith("--"))
      throw new Error(USAGE);
    const value = argv[++i];
    if (flag === "--base") options.base = value;
    else options.json = resolve(value);
  }
  return options;
}

const routes = (base: Record<string, number>, head: Record<string, number>) =>
  [...new Set([...Object.keys(head), ...Object.keys(base)])];
const ownSize = (sizes: Record<string, number>, route: string) => Object.hasOwn(sizes, route) ? sizes[route] : null;

export function compareBundles(base: BundleSizes, head: BundleSizes, thresholdBytes = THRESHOLD_BYTES) {
  const rows: BundleRow[] = routes(base.sizes, head.sizes).map((route) => {
    const old = ownSize(base.sizes, route), current = ownSize(head.sizes, route);
    const delta = old === null || current === null ? null : current - old;
    const status = old === null ? "new" : current === null ? "removed" : current > old ? "grew" : current < old ? "shrank" : "same";
    return { route, base: old, head: current, delta, status };
  });
  const over = rows.filter((row): row is BundleRow & { delta: number } =>
    row.status === "grew" && row.delta !== null && row.delta > thresholdBytes);
  const ceilings: CeilingChange[] = [];
  for (const route of routes(base.budgets, head.budgets)) {
    const old = ownSize(base.budgets, route), current = ownSize(head.budgets, route);
    if (old === current) continue;
    ceilings.push({ route, old, new: current,
      change: old === null ? "added" : current === null ? "removed" : current > old ? "raised" : "lowered" });
  }
  return { rows, over, ceilings };
}

function formatDelta(bytes: number): string {
  const magnitude = Math.abs(bytes);
  return `${bytes < 0 ? "-" : "+"}${magnitude < 100 ? `${magnitude} B` : `${(magnitude / 1000).toFixed(1)} KB`}`;
}

export function formatBundleSummary(result: ReturnType<typeof compareBundles>, baseSha: string): string {
  const items: string[] = [];
  const grouped = new Set<number>();
  for (const row of result.rows) {
    if (row.status === "new") items.push(`${row.route} new ${((row.head as number) / 1000).toFixed(1)} KB`);
    else if (row.status === "removed") items.push(`${row.route} removed (was ${((row.base as number) / 1000).toFixed(1)} KB)`);
    else if (row.delta !== null && row.delta !== 0 && !grouped.has(row.delta)) {
      grouped.add(row.delta);
      const names = result.rows.filter((other) => other.delta === row.delta).map((other) => other.route);
      items.push(`${names.join(", ")} ${formatDelta(row.delta)}`);
    }
  }
  if (items.length && result.rows.some((row) => row.status === "same")) items.push("others unchanged");
  const lines = [`Bundle vs main ${baseSha.slice(0, 7)} (gzip): ${items.length ? items.join("; ") : "no chunk changed size"}.`];
  if (result.over.length) lines.push(`Over 5 KB: ${result.over.map((row) => `${row.route} ${formatDelta(row.delta)}`).join(", ")}`);
  for (const ceiling of result.ceilings) {
    if (ceiling.change === "added") lines.push(`Ceiling added: ${ceiling.route} ${ceiling.new} gzip bytes.`);
    else if (ceiling.change === "removed") lines.push(`Ceiling removed: ${ceiling.route} (was ${ceiling.old} gzip bytes).`);
    else lines.push(`Ceiling ${ceiling.change}: ${ceiling.route} from ${ceiling.old} to ${ceiling.new} gzip bytes.`);
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateBaseCache(value: unknown, sha: string): value is BaseCache {
  const validSizes = (sizes: unknown) => isRecord(sizes) && Object.values(sizes).every(
    (bytes) => typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0,
  );
  return isRecord(value) && value.schemaVersion === 1 && value.sha === sha && /^[a-f0-9]{40}$/.test(sha)
    && validSizes(value.sizes) && validSizes(value.budgets);
}

export function readCache(path: string, sha: string): BaseCache | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return validateBaseCache(value, sha) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeCache(path: string, cache: BaseCache): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function measureCheckout(source: string, allowMissingBudget = false): BundleSizes {
  const web = join(source, "apps/web");
  let budgetText: string;
  try {
    budgetText = readFileSync(join(web, "bundle-budget.json"), "utf8");
  } catch (error) {
    if (allowMissingBudget && (error as NodeJS.ErrnoException).code === "ENOENT") return { sizes: {}, budgets: {} };
    throw error;
  }
  const measured = measureBundles(join(web, "dist"),
    JSON.parse(readFileSync(join(web, "dist/.vite/manifest.json"), "utf8")), JSON.parse(budgetText));
  return {
    sizes: Object.fromEntries(measured.map((row) => [row.route, row.gzipBytes])),
    budgets: Object.fromEntries(measured.map((row) => [row.route, row.budget])),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const out = join(checkout, ".wt/bundle-base");
  const sealed = createSealedLifecycle("bundle-diff");
  const failurePaths: { sealedRoot?: string; refFolder?: string } = {};
  let failure: Error | undefined;
  try {
    const { sealedRoot, env, realStateDirs } = sealed.createRoot(out, { name: "Bundle Diff", email: "bundle@example.test" });
    failurePaths.sealedRoot = sealedRoot;
    const git = (cwd: string, ...args: string[]) =>
      sealed.git(cwd, { ...env, GIT_OPTIONAL_LOCKS: "0" }, ...args);
    // Untracked files can affect the head build, which reads the working tree.
    if (git(checkout, "status", "--porcelain")) throw new Error("The checkout has uncommitted changes; commit first");
    const head = git(checkout, "rev-parse", "HEAD");
    const base = resolveCommit(options.base ?? git(checkout, "merge-base", "origin/main", "HEAD"), (...args) => git(checkout, ...args));
    const pnpm = pnpmExecutable();
    const build = async (source: string) => {
      const result = await sealed.run(pnpm, ["--dir", "apps/web", "build"], {
        cwd: source, env: buildEnvironment(env, pnpm), group: true, timeoutMs: 600_000,
      });
      checkBuildResult(result, `Web build exited with code ${result.code}`, failurePaths);
    };
    await build(checkout);
    const headSizes = measureCheckout(checkout);
    const cachePath = join(out, `${base}.json`);
    let baseSizes: BundleSizes | undefined = readCache(cachePath, base);
    if (!baseSizes) {
      const source = await exportMainCommit({
        sealed, env, sealedRoot, sha: base, keep: false, protectedDirs: realStateDirs, failurePaths, git,
      });
      await build(source);
      baseSizes = measureCheckout(source, true);
      writeCache(cachePath, { schemaVersion: 1, sha: base, ...baseSizes });
    }
    const result = compareBundles(baseSizes, headSizes);
    const summary = formatBundleSummary(result, base);
    if (options.json) {
      mkdirSync(dirname(options.json), { recursive: true });
      writeFileSync(options.json, `${JSON.stringify({ schemaVersion: 1, base, head, thresholdBytes: THRESHOLD_BYTES, ...result, summary }, null, 2)}\n`);
    }
    console.log(summary);
  } catch (error) {
    failure = new Error(redactFailure(error, failurePaths));
  } finally {
    sealed.finish(failure);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`bundle:diff: ${redactFailure(error)}`);
    process.exitCode = 1;
  });
}
