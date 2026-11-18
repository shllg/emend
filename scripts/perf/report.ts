import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Measurement } from "./journeys.ts";
import type { distribution } from "./metrics.ts";
import type { SEED, Skip } from "./seed.ts";
import type { VanishedRequestEvent } from "../screenshots/browser.ts";

export interface PerfRun {
  schemaVersion: 1;
  commit: { sha: string; subject: string; date: string; dirty: boolean };
  date: string;
  ref?: string;
  node: string;
  chromium: string | null;
  /** Absent in historical runs recorded before seal counters were introduced. */
  seal?: {
    vanishedRequests: number;
    vanishedTargets?: number;
    vanishedRequestsByKind?: Readonly<Record<VanishedRequestEvent["kind"], number>>;
    vanishedRequestEvents?: readonly VanishedRequestEvent[];
  };
  cpus: number;
  loadStart: number[];
  loadEnd: number[];
  seed: typeof SEED;
  seededReviews: number;
  repetitions: number;
  measurements: Measurement[];
  publish: { samples: number[]; stats: ReturnType<typeof distribution> } | null;
  skipped: Skip[];
}
export function escape(text: unknown): string {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
type Stats = ReturnType<typeof distribution>;
type Journey = Measurement["journey"];
const JOURNEYS: { key: Journey; title: string }[] = [
  { key: "inbox", title: "Inbox" },
  { key: "review", title: "Large review" },
  { key: "file", title: "Switch and scroll a file" },
  { key: "composer", title: "Comment composer" },
  { key: "pub", title: "Publication" },
];
const GROUPS = [
  { viewport: "laptop", temperature: "cold", label: "Laptop cold" },
  { viewport: "laptop", temperature: "warm", label: "Laptop warm" },
  { viewport: "phone", temperature: "cold", label: "Phone cold" },
  { viewport: "phone", temperature: "warm", label: "Phone warm" },
] as const;
type Group = (typeof GROUPS)[number];
const HEADLINES = [
  "timeMs", "longTasks.count", "longTasks.totalMs", "js.loaded.gzip", "js.transferred.gzip",
  "css.loaded.gzip", "css.transferred.gzip", "worker.loaded.gzip", "worker.transferred.gzip", "network.gzip", "sw.gzip",
];
const RAW_BYTES = ["js.loaded.raw", "js.transferred.raw", "css.loaded.raw", "css.transferred.raw", "worker.loaded.raw", "worker.transferred.raw"];
const LABELS: Record<string, [string, string]> = {
  timeMs: ["Content ready", "ms"], openMs: ["Open publication", "ms"], switchMs: ["Switch document", "ms"],
  "longTasks.count": ["Long tasks", "count"], "longTasks.totalMs": ["Long task time", "ms"],
  "js.loaded.gzip": ["JS loaded · gzip", "bytes"], "js.transferred.gzip": ["JS transferred · gzip", "bytes"],
  "css.loaded.gzip": ["CSS loaded · gzip", "bytes"], "css.transferred.gzip": ["CSS transferred · gzip", "bytes"],
  "js.loaded.raw": ["JS loaded · raw", "bytes"], "js.transferred.raw": ["JS transferred · raw", "bytes"],
  "css.loaded.raw": ["CSS loaded · raw", "bytes"], "css.transferred.raw": ["CSS transferred · raw", "bytes"],
  "worker.loaded.gzip": ["Worker scripts loaded · gzip", "bytes"], "worker.transferred.gzip": ["Worker scripts transferred · gzip", "bytes"],
  "worker.loaded.raw": ["Worker scripts loaded · raw", "bytes"], "worker.transferred.raw": ["Worker scripts transferred · raw", "bytes"],
  "network.gzip": ["Network total · gzip", "bytes"], "network.raw": ["Network total · raw", "bytes"],
  "network.files": ["Network total", "files"],
  "sw.gzip": ["Service worker only · gzip", "bytes"], "sw.raw": ["Service worker only · raw", "bytes"],
  "sw.files": ["Service worker only", "files"],
};
const busy = (run: PerfRun) => [...run.loadStart, ...run.loadEnd].some((value) => value > run.cpus);
const number = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const signed = (value: number) => `${value > 0 ? "+" : ""}${number(value)}`;

function metricLabel(metric: string): [string, string] {
  return Object.hasOwn(LABELS, metric) ? LABELS[metric] : [metric, ""];
}
function stat(run: PerfRun | undefined, journey: Journey, group: Group, metric: string): Stats | undefined {
  const metrics = run?.measurements.find((m) => m.journey === journey && m.viewport === group.viewport &&
    m.temperature === group.temperature)?.metrics;
  return metrics && Object.hasOwn(metrics, metric) ? metrics[metric] : undefined;
}
function cell(current: Stats | undefined, previous: Stats | undefined): string {
  if (!current || !Number.isFinite(current.median)) return '<td class="missing">—<small>No measurement</small></td>';
  let delta = "Δ — (no previous measurement)";
  let direction = "unchanged";
  if (previous && Number.isFinite(previous.median)) {
    const change = current.median - previous.median;
    const percent = previous.median === 0 ? (change === 0 ? "0%" : "percent unavailable: previous is 0") :
      `${signed(change / previous.median * 100)}%`;
    delta = `Δ ${signed(change)} (${percent})`;
    direction = change > 0 ? "increase" : change < 0 ? "decrease" : "unchanged";
  }
  return `<td><strong>${escape(number(current.median))}</strong><small>Spread ${escape(number(current.spread))} · n=${escape(current.count)}</small><small class="${direction}">${escape(delta)}</small></td>`;
}

interface ChartSeries { label: string; className: string; values: (number | undefined)[] }
function chart(runs: PerfRun[], label: string, unit: string, series: ChartSeries[]): string {
  const finite = series.flatMap((line) => line.values).filter((value): value is number =>
    value !== undefined && Number.isFinite(value));
  if (!finite.length) return "";
  const min = Math.min(...finite), max = Math.max(...finite), span = max - min || 1;
  // Keep all commit labels legible; longer histories scroll within the small chart card.
  const width = Math.max(360, 100 + (runs.length - 1) * 72), height = 166;
  const left = 76, right = width - 24, top = 18, bottom = 108;
  const x = (index: number) => runs.length === 1 ? (left + right) / 2 : left + index * (right - left) / (runs.length - 1);
  const lines = series.map((line) => {
    const points = line.values.map((value, index) => value === undefined || !Number.isFinite(value) ? null :
      [x(index), max === min ? (top + bottom) / 2 : bottom - (value - min) / span * (bottom - top)]);
    // Only neighbours connect: missing runs must never look like zeros or interpolated results.
    return `<g class="${line.className}">` + points.map((point, index) => {
      if (!point) return "";
      const previous = points[index - 1];
      return (previous ? `<line x1="${previous[0]}" y1="${previous[1]}" x2="${point[0]}" y2="${point[1]}"/>` : "") +
        `<circle cx="${point[0]}" cy="${point[1]}" r="3"><title>${escape(line.label)}: ${escape(number(line.values[index]))} ${escape(unit)} · ${escape(runs[index].commit.sha.slice(0, 8))}</title></circle>`;
    }).join("") + "</g>";
  }).join("");
  const ticks = runs.map((run, index) => `<g class="tick"><line x1="${x(index)}" y1="${bottom}" x2="${x(index)}" y2="${bottom + 4}"/><text x="${x(index)}" y="128" text-anchor="middle">${escape(run.commit.sha.slice(0, 8))}</text><text x="${x(index)}" y="143" text-anchor="middle">${escape(run.commit.date.slice(0, 10))}</text></g>`).join("");
  return `<figure class="history-chart"><figcaption>${escape(label)} <small>(${escape(unit)})</small></figcaption>
<div class="legend">${series.map((line) => `<span class="${line.className}"><i aria-hidden="true"></i>${escape(line.label)}</span>`).join("")}</div>
<div class="chart-scroll"><svg viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="img" aria-label="${escape(`${label}: median by commit, ${unit}`)}">
<g class="axis"><line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}"/><line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"/>
<text x="${left - 8}" y="${top + 4}" text-anchor="end">${escape(number(max))}</text><text x="${left - 8}" y="${bottom + 4}" text-anchor="end">${escape(number(min))}</text></g>${ticks}${lines}</svg></div></figure>`;
}
function table(headings: readonly string[], rows: string, caption: string, className = ""): string {
  return `<div class="table-scroll"><table class="${className}"><caption>${escape(caption)}</caption><thead><tr>${headings.map((heading) => `<th scope="col">${escape(heading)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function historyTable(journey: Journey, runs: PerfRun[], temperature: Group["temperature"]): string {
  const keys = [...new Set(runs.flatMap((run) => run.measurements
    .filter((measurement) => measurement.journey === journey && measurement.temperature === temperature)
    .flatMap((measurement) => Object.keys(measurement.metrics))))].sort();
  const headings = runs.map((run) => `<th scope="col" title="${escape(run.commit.date)}">${escape(run.commit.sha.slice(0, 8))}</th>`).join("");
  const rows = keys.map((key) => {
    const [label, unit] = metricLabel(key);
    const cells = runs.map((run) => `<td>${["laptop", "phone"].map((viewport) => {
      const group = GROUPS.find((group) => group.viewport === viewport && group.temperature === temperature)!;
      return `<span>${viewport === "laptop" ? "Laptop" : "Phone"}: ${escape(number(stat(run, journey, group, key)?.median))}</span>`;
    }).join("<br>")}</td>`).join("");
    return `<tr data-metric="${escape(key)}"><th scope="row">${escape(label)}${unit ? ` <small>(${escape(unit)})</small>` : ""}</th>${cells}</tr>`;
  }).join("");
  return `<details><summary>History · ${temperature}</summary><div class="table-scroll"><table class="history-table"><caption>All ${temperature} medians · laptop and phone</caption><thead><tr><th scope="col">Metric</th>${headings}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
}
function journeySection(journey: Journey, title: string, runs: PerfRun[], current: PerfRun, previous: PerfRun | undefined): string {
  const headlines = journey === "pub" ? ["timeMs", "openMs", "switchMs", ...HEADLINES.slice(1)] : HEADLINES;
  const keys = new Set(runs.flatMap((run) => run.measurements.filter((m) => m.journey === journey).flatMap((m) => Object.keys(m.metrics))));
  const ordered = [...headlines, ...RAW_BYTES, "network.raw", "network.files", "sw.raw", "sw.files"];
  const extras = [...keys].filter((key) => !key.startsWith("api ") && !ordered.includes(key)).sort();
  const rows = [...ordered, ...extras].map((key) => {
    const [label, unit] = metricLabel(key);
    return `<tr data-metric="${escape(key)}"><th scope="row">${escape(label)}${unit ? ` <small>(${escape(unit)})</small>` : ""}</th>${GROUPS.map((group) => cell(stat(current, journey, group, key), stat(previous, journey, group, key))).join("")}</tr>`;
  }).join("");
  const history = headlines.map((key) => {
    const [label, unit] = metricLabel(key);
    return chart(runs, label, unit, [
      { label: "Laptop cold", className: "laptop", values: runs.map((run) => stat(run, journey, GROUPS[0], key)?.median) },
      { label: "Phone cold", className: "phone", values: runs.map((run) => stat(run, journey, GROUPS[2], key)?.median) },
    ]);
  }).join("");
  const routes = [...keys].filter((key) => key.startsWith("api ") && key.endsWith(" median")).sort();
  const apiRows = routes.map((key) => `<tr><th scope="row"><code>${escape(key.slice(4, -7))}</code></th>${GROUPS.map((group) => cell(stat(current, journey, group, key), stat(previous, journey, group, key))).join("")}</tr>`).join("");
  const readiness = current.measurements.find((m) => m.journey === journey)?.readiness;
  return `<section id="${journey}"><h2>${escape(title)}</h2>${readiness ? `<p class="muted">Ready when: ${escape(readiness)}</p>` : ""}
${table(["Metric", ...GROUPS.map((group) => group.label)], rows, `${title} · current medians and change from previous run`)}
${history ? `<div class="history-grid">${history}</div>` : '<p class="muted">No headline history recorded.</p>'}
${historyTable(journey, runs, "cold")}${historyTable(journey, runs, "warm")}
<h3>API routes</h3>${apiRows ? table(["Route", ...GROUPS.map((group) => group.label)], apiRows, "Median server response time (ms)", "api-table") : '<p class="muted">No API timings recorded.</p>'}</section>`;
}
function skippedSteps(run: PerfRun): string {
  return `<details><summary>${escape(run.commit.sha.slice(0, 12))} · ${escape(run.date)} · ${run.skipped.length} skipped</summary><ul>${run.skipped.length ? run.skipped.map((skip) => `<li><strong>${escape(skip.step)}</strong> — ${escape(skip.reason)}</li>`).join("") : "<li>None</li>"}</ul></details>`;
}
function sealSummary(seal: PerfRun["seal"]): string {
  const kinds = seal?.vanishedRequestsByKind;
  return [
    seal ? `${escape(number(seal.vanishedRequests))} vanished requests tolerated` : "vanished requests not recorded",
    seal?.vanishedTargets === undefined ? "vanished targets not recorded" : `${escape(number(seal.vanishedTargets))} vanished targets tolerated`,
    kinds ? `gone: ${escape(number(kinds.gone))} · invalid-interception: ${escape(number(kinds["invalid-interception"]))}` : "request kinds not recorded",
  ].join(" · ");
}

export function renderReport(input: PerfRun[], current: PerfRun): string {
  const isCurrent = (run: PerfRun) => run.date === current.date && run.commit.sha === current.commit.sha;
  const runs = (input.some(isCurrent) ? [...input] : [...input, current]).sort((a, b) =>
    Date.parse(a.commit.date) - Date.parse(b.commit.date) || a.date.localeCompare(b.date));
  const index = runs.findIndex(isCurrent);
  const previous = index > 0 ? runs[index - 1] : undefined;
  const sections = JOURNEYS.map(({ key, title }) => journeySection(key, title, runs, current, previous)).join("");
  const cli = `<section id="cli-publish"><h2>CLI publish</h2><p class="muted">Wall time from CLI start to exit, after the browser journeys; no viewport or temperature.</p>
${table(["Metric", "CLI"], `<tr><th scope="row">Publication time <small>(ms)</small></th>${cell(current.publish?.stats, previous?.publish?.stats)}</tr>`, "CLI publication · current median and change from previous run")}
<div class="history-grid">${chart(runs, "Publication time", "ms", [{ label: "CLI publish", className: "laptop", values: runs.map((run) => run.publish?.stats.median) }])}</div></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>emend performance history</title>
<style>
:root{color-scheme:light dark;--bg:#f8f9fb;--panel:#fff;--fg:#202a36;--muted:#586574;--line:#d4dbe3;--laptop:#155ca6;--phone:#a6530b;--up:#a22722;--down:#216539;--busy:#fff1df}
*{box-sizing:border-box}body{font:15px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;padding:2rem;max-width:1500px}h1{font-size:1.9rem;margin:0 0 .5rem}h2{font-size:1.4rem}h3{font-size:1rem}header,section{margin-bottom:2rem}section{border-top:2px solid var(--line);padding-top:1rem}p{max-width:100ch}small,.muted,caption{color:var(--muted)}small{font-size:.78rem}td small{display:block;margin-top:.15rem}th small{font-weight:400}.busy{color:var(--up)}.busy-warning{background:var(--busy);border-left:4px solid var(--up);padding:.75rem 1rem}.run-list{padding-left:1.5rem}.run-list li{margin:.45rem 0}.run-status{margin-left:.5rem;font-size:.8rem}code{overflow-wrap:anywhere}.table-scroll,.chart-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--panel);font-variant-numeric:tabular-nums;min-width:740px}caption{text-align:left;padding:.4rem 0;font-size:.85rem}th,td{padding:.65rem .8rem;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}thead th{font-size:.85rem;background:var(--bg)}tbody th{font-weight:500;min-width:170px}td{width:20%}td strong{font-size:1rem;font-weight:600}.increase{color:var(--up)}.decrease{color:var(--down)}.unchanged,.missing{color:var(--muted)}.api-table{font-size:.85rem}.api-table td strong{font-size:.9rem}.history-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin:1rem 0}.history-chart{margin:0;min-width:0;padding:.75rem;border:1px solid var(--line);border-radius:6px;background:var(--panel)}figcaption{font-weight:600}.legend{display:flex;gap:1rem;font-size:.8rem;margin:.3rem 0}.legend i{display:inline-block;vertical-align:middle;width:1.5rem;border-top:2px solid currentColor;margin-right:.4rem}.laptop{color:var(--laptop)}.phone{color:var(--phone)}.legend .phone i{border-top-style:dashed}svg{display:block;width:100%;height:auto;max-height:180px}svg text{font:10px system-ui,sans-serif;fill:var(--muted)}svg .axis line,svg .tick line{stroke:var(--line)}svg .laptop line,svg .phone line{stroke:currentColor;stroke-width:2}svg .phone line{stroke-dasharray:5 3}svg circle{fill:currentColor}details{padding:.6rem 0;border-bottom:1px solid var(--line)}summary{cursor:pointer}details li{margin:.35rem 0}#cli-publish table{min-width:360px}#cli-publish td{width:60%}
@media(prefers-color-scheme:dark){:root{--bg:#111820;--panel:#1b2530;--fg:#e4ebf3;--muted:#a7b5c5;--line:#3c4b5d;--laptop:#86bdff;--phone:#ffc080;--up:#ffaca6;--down:#99d8ac;--busy:#30231f}}
@media(max-width:780px){body{padding:1rem}.history-grid{grid-template-columns:1fr}th,td{padding:.5rem}.legend{flex-wrap:wrap}}
</style></head><body>
<header><h1>emend performance history</h1><p>Current run: <strong>${escape(current.commit.sha.slice(0, 12))}</strong> — ${escape(current.commit.subject)}${current.commit.dirty ? " (dirty tree)" : ""}<br>Commit ${escape(current.commit.date)} · run ${escape(current.date)}${current.ref ? ` · ref ${escape(current.ref)}` : ""}</p>
<p><strong>Machine:</strong> ${escape(current.cpus)} CPUs · load at start ${escape(current.loadStart.join(", "))} · load at end ${escape(current.loadEnd.join(", "))} (1, 5, 15 minutes).<br>Node ${escape(current.node)} · Chromium ${escape(current.chromium ?? "not recorded")}.</p>
${busy(current) ? '<p class="busy busy-warning"><strong>BUSY:</strong> load at start or end was above the CPU count. Treat timing comparisons with care.</p>' : ""}
<p>Cells show the median, spread (max minus min), sample count and delta from ${previous ? `${escape(previous.commit.sha.slice(0, 12))}, the previous run by commit date` : "the previous run by commit date, when available"}. Positive deltas mean larger values. Times are milliseconds; asset sizes are bytes from build files (gzip level 9). Timings vary with machine load and never gate.</p>
<p><strong>Page figures:</strong> JS and CSS files requested by the page and its frames, each counted once. <strong>Transferred:</strong> those with at least one network fetch in the sample, in any session. HTTP cache hits, 304 responses and service worker responses do not count as network fetches. Each file counts once in each set, so transferred never exceeds loaded.</p>
<p><strong>Worker scripts:</strong> JS that only the page's dedicated workers requested, such as the syntax highlighter a new diff worker pool loads. A dedicated worker's own main script is not counted: Chromium reports its request without a response.</p>
<p><strong>Network total:</strong> each build file fetched from the network during the sample, by the page, its workers or the service worker, counted once. A cold sample's total includes the precache.</p>
<p><strong>Service worker only:</strong> files in the network total that neither the page, its frames nor its workers requested; mostly the precache in a cold sample. A file that the page also requested counts in the page figures, whichever fetch reached the network first. Folder paths use index.html; paths without a build file are omitted. Cold samples keep recording until registered workers are activated and the page settles again; this wait is outside all timings.</p>
<p class="muted">${escape(current.repetitions)} repetitions. Cold starts with empty browser storage except sign-in cookies; file and composer prerequisites are outside their measurements. Warm repeats the journey after service worker control. Charts show cold medians for all listed runs in commit order; gaps are missing measurements.</p>
<h2>Runs in commit order</h2><p class="muted">Request-kind counts include all tolerated continues; the run JSON retains the first 50 diagnostic entries.</p><ol class="run-list">${runs.map((run) => `<li><code>${escape(run.commit.sha.slice(0, 12))}</code> · ${escape(run.commit.date)} · ${escape(run.commit.subject)}<span class="run-status${busy(run) ? " busy" : ""}">${run.commit.dirty ? "dirty" : "clean"} · ${busy(run) ? "BUSY" : "quiet"} · ${run.skipped.length} skipped · ${sealSummary(run.seal)}</span></li>`).join("")}</ol></header>
<main>${sections}${cli}<section id="skipped"><h2>Skipped steps</h2><p class="muted">Full step names and reasons for each run.</p>${runs.map(skippedSteps).join("")}</section></main></body></html>`;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const numbers = (value: unknown): value is number[] => Array.isArray(value) && value.every(finite);
const stats = (value: unknown): value is Stats => record(value) &&
  ["count", "median", "min", "max", "spread"].every((key) => finite(value[key]));
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** Validate every field used by the report before accepting a saved run. */
export function isReportRun(value: unknown): value is PerfRun {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.commit) ||
      typeof value.commit.sha !== "string" || !date(value.commit.date) ||
      typeof value.commit.subject !== "string" || typeof value.commit.dirty !== "boolean" ||
      !date(value.date) || typeof value.node !== "string" ||
      (value.chromium !== null && typeof value.chromium !== "string") ||
      (value.ref !== undefined && typeof value.ref !== "string") ||
      !finite(value.cpus) || !numbers(value.loadStart) || !numbers(value.loadEnd) || !finite(value.repetitions) ||
      !Array.isArray(value.measurements) || !Array.isArray(value.skipped)) return false;
  if (!value.measurements.every((measurement: unknown) => record(measurement) &&
      JOURNEYS.some(({ key }) => key === measurement.journey) &&
      (measurement.viewport === "laptop" || measurement.viewport === "phone") &&
      (measurement.temperature === "cold" || measurement.temperature === "warm") &&
      typeof measurement.readiness === "string" && record(measurement.metrics) &&
      Object.values(measurement.metrics).every(stats))) return false;
  if (!value.skipped.every((skip: unknown) => record(skip) &&
      typeof skip.step === "string" && typeof skip.reason === "string")) return false;
  if (value.publish !== null && (!record(value.publish) || !stats(value.publish.stats))) return false;
  if (value.seal !== undefined) {
    if (!record(value.seal) || !finite(value.seal.vanishedRequests) ||
        (value.seal.vanishedTargets !== undefined && !finite(value.seal.vanishedTargets))) return false;
    const kinds = value.seal.vanishedRequestsByKind;
    if (kinds !== undefined && (!record(kinds) || !finite(kinds.gone) || !finite(kinds["invalid-interception"]))) return false;
  }
  return true;
}
function atomic(path: string, data: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}
export function writeReport(out: string, run: PerfRun, warn: (message: string) => void = console.error): string {
  mkdirSync(out, { recursive: true });
  const file = join(
    out,
    `${run.date.replaceAll(":", "-")}-${run.commit.sha.slice(0, 12)}-${randomUUID().slice(0, 8)}.json`,
  );
  atomic(file, `${JSON.stringify(run, null, 2)}\n`);
  const runs: PerfRun[] = [];
  for (const name of readdirSync(out).filter((name) => name.endsWith(".json"))) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(out, name), "utf8"));
      if (!isReportRun(parsed)) throw new Error("Invalid performance run");
      runs.push(parsed);
    } catch {
      warn(`perf: ignoring invalid run file ${JSON.stringify(name)}`);
    }
  }
  atomic(join(out, "report.html"), renderReport(runs, run));
  return file;
}
