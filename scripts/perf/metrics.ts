import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalPath, inside } from "../screenshots/safety.ts";

export const REPETITIONS = 5;
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) throw new Error("No measurement samples");
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
    max: sorted.at(-1) as number,
    spread: (sorted.at(-1) as number) - sorted[0],
  };
}
export function routePattern(url: string): string {
  const pathname = new URL(url, "http://127.0.0.1").pathname;
  return pathname
    .split("/")
    .map((part, index, parts) => {
      if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(part)) return ":id";
      if (index > 2 && /^\d+$/.test(part)) return parts[index - 1] === "revisions" ? ":revision" : ":id";
      if (/^[0-9a-f]{40,64}$/i.test(part)) return ":hash";
      return part;
    })
    .join("/");
}
export interface AssetBytes {
  raw: number;
  gzip: number;
}
export interface Traffic {
  js: { loaded: AssetBytes; transferred: AssetBytes };
  css: { loaded: AssetBytes; transferred: AssetBytes };
  worker: { loaded: AssetBytes; transferred: AssetBytes };
  network: AssetBytes & { files: number };
  sw: AssetBytes & { files: number };
  api: { route: string; count: number; median: number; max: number }[];
}
interface RequestFields { url?: unknown; method?: unknown }
interface ResponseFields {
  url?: unknown;
  status?: unknown;
  fromDiskCache?: unknown;
  fromServiceWorker?: unknown;
  fromPrefetchCache?: unknown;
  timing?: unknown;
}
interface TimingFields { sendStart?: unknown; receiveHeadersEnd?: unknown }
interface Event {
  method?: unknown;
  requestId?: unknown;
  request?: unknown;
  statusCode?: unknown;
  response?: unknown;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** CDP identifies assets/cache provenance only. Byte counts always come from the measured build. */
export class NetworkMeasurement {
  private requests = new Map<
    string,
    { id: string; url: string; method: string; sessionType: string | undefined; cached: boolean; revalidated: boolean; response?: ResponseFields }
  >();
  private timings = new Map<string, number[]>();
  private sizes = new Map<string, AssetBytes>();
  private dist: string;
  private origin: string;
  constructor(dist: string, origin: string) {
    this.dist = canonicalPath(dist);
    this.origin = origin;
  }
  event(event: Event, session: string | undefined, sessionType: string | undefined): void {
    if (typeof event.requestId !== "string") return;
    const key = `${session}:${event.requestId}`;
    if (event.method === "Network.requestWillBeSent") {
      if (!isRecord(event.request)) return;
      const request: RequestFields = event.request;
      if (typeof request.url !== "string" || typeof request.method !== "string") return;
      // Remember the type now: a worker or frame may detach before the sample finishes.
      this.requests.set(key, { id: event.requestId, url: request.url, method: request.method, sessionType, cached: false, revalidated: false });
    } else if (event.method === "Network.requestServedFromCache") {
      const request = this.requests.get(key);
      if (request) request.cached = true;
    } else if (event.method === "Network.responseReceivedExtraInfo") {
      const request = this.requests.get(key);
      if (request && event.statusCode === 304) request.revalidated = true;
    } else if (event.method === "Network.responseReceived") {
      const request = this.requests.get(key);
      if (request && isRecord(event.response)) request.response = event.response;
    }
  }
  private buildFile(pathname: string): string | undefined {
    let path = canonicalPath(resolve(this.dist, `.${decodeURIComponent(pathname)}`));
    if (path !== this.dist && !inside(this.dist, path)) throw new Error("Asset leaves the measured web build");
    if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      path = canonicalPath(resolve(path, "index.html"));
    }
    if (!inside(this.dist, path)) throw new Error("Asset leaves the measured web build");
    return statSync(path, { throwIfNoEntry: false })?.isFile() ? path : undefined;
  }
  private size(path: string): AssetBytes {
    let size = this.sizes.get(path);
    if (!size) {
      const bytes = readFileSync(path);
      size = { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
      this.sizes.set(path, size);
    }
    return size;
  }
  finish(): Traffic {
    const seen = new Set<string>();
    const documentRequests = new Set<string>();
    const pageTreeRequests = new Set<string>();
    const files = new Map<string, "js" | "css" | "worker">();
    const networkFiles = new Set<string>();
    // Requests alone establish who wanted a file, even when Chromium omits the response
    // (notably a dedicated worker's main script). Gather them before classifying any fetches.
    for (const request of this.requests.values()) {
      if (!["page", "iframe", "worker"].includes(request.sessionType ?? "")) continue;
      const url = new URL(request.url);
      if (url.origin !== this.origin) continue;
      const path = this.buildFile(url.pathname);
      if (!path) continue;
      pageTreeRequests.add(path);
      if (request.sessionType !== "worker") documentRequests.add(path);
    }
    for (const request of this.requests.values()) {
      const response = request.response;
      if (!response || typeof response.url !== "string" || typeof response.status !== "number" || !Number.isFinite(response.status)) continue;
      if ([response.fromDiskCache, response.fromServiceWorker, response.fromPrefetchCache]
          .some((flag) => flag !== undefined && typeof flag !== "boolean")) continue;
      const url = new URL(response.url);
      if (url.origin !== this.origin) continue;
      const network =
        !request.cached && !response.fromDiskCache && !response.fromServiceWorker && !response.fromPrefetchCache;
      if (network && !request.revalidated &&
          response.status >= 200 && response.status < 300) {
        const path = this.buildFile(url.pathname);
        if (path) networkFiles.add(path);
      }
      const kind = /\.[cm]?js$/.test(url.pathname) ? "js" : /\.css$/.test(url.pathname) ? "css" : undefined;
      if (kind && response.status >= 200 && response.status < 400) {
        const path = this.buildFile(url.pathname);
        if (path) {
          if (request.sessionType === "page" || request.sessionType === "iframe") files.set(path, kind);
          else if (request.sessionType === "worker" && kind === "js" && !documentRequests.has(path))
            files.set(path, "worker");
        }
      }
      // Deduplicate API timings reported in both creator and worker sessions. Assets above instead
      // merge every session's provenance by file, so neither the page request nor a SW fetch is lost.
      const key = `${request.id}:${response.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const timing: TimingFields | undefined = isRecord(response.timing) ? response.timing : undefined;
      if (
        url.pathname.startsWith("/api/v1/") &&
        network &&
        typeof timing?.sendStart === "number" && Number.isFinite(timing.sendStart) && timing.sendStart >= 0 &&
        typeof timing.receiveHeadersEnd === "number" && Number.isFinite(timing.receiveHeadersEnd) &&
        timing.receiveHeadersEnd >= timing.sendStart
      ) {
        const route = `${request.method} ${routePattern(response.url)}`;
        const values = this.timings.get(route) ?? [];
        values.push(timing.receiveHeadersEnd - timing.sendStart);
        this.timings.set(route, values);
      }
    }
    const empty = () => ({ loaded: { raw: 0, gzip: 0 }, transferred: { raw: 0, gzip: 0 } });
    const result: Traffic = {
      js: empty(), css: empty(), worker: empty(),
      network: { files: networkFiles.size, raw: 0, gzip: 0 }, sw: { files: 0, raw: 0, gzip: 0 }, api: [],
    };
    for (const [path, kind] of files) {
      const size = this.size(path);
      for (const field of ["raw", "gzip"] as const) {
        result[kind].loaded[field] += size[field];
        if (networkFiles.has(path)) result[kind].transferred[field] += size[field];
      }
    }
    for (const path of networkFiles) {
      const size = this.size(path);
      result.network.raw += size.raw;
      result.network.gzip += size.gzip;
      if (!pageTreeRequests.has(path)) {
        result.sw.files++;
        result.sw.raw += size.raw;
        result.sw.gzip += size.gzip;
      }
    }
    result.api = [...this.timings]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([route, values]) => {
        const stats = distribution(values);
        return { route, count: values.length, median: stats.median, max: stats.max };
      });
    return result;
  }
}
