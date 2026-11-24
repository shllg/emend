import { activateShell, routeShellRequest, SHELL_CACHE_PREFIX, shellResponse } from "./sw-routing.ts";

declare const __RECENSE_SHELL__: string[];
declare const __RECENSE_BUILD_ID__: string;
interface WorkerEvent {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends WorkerEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}
const worker = globalThis as unknown as {
  location: Location;
  caches: CacheStorage;
  fetch: typeof fetch;
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", handler: (event: WorkerEvent) => void): void;
  addEventListener(type: "message", handler: (event: { data?: unknown }) => void): void;
  addEventListener(type: "fetch", handler: (event: FetchEvent) => void): void;
};
const name = `${SHELL_CACHE_PREFIX}${__RECENSE_BUILD_ID__}`;
worker.addEventListener("install", (event) => {
  event.waitUntil(worker.caches.open(name).then((cache) => cache.addAll(__RECENSE_SHELL__)));
});
worker.addEventListener("activate", (event) => {
  event.waitUntil(activateShell(worker.caches, name).then(() => worker.clients.claim()));
});
// A waiting worker activates only when the reviewer asks for it, with exactly this message.
worker.addEventListener("message", (event) => {
  const data = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return;
  const keys = Object.keys(data);
  if (keys.length === 1 && keys[0] === "type" && Reflect.get(data, "type") === "SKIP_WAITING")
    void worker.skipWaiting();
});
worker.addEventListener("fetch", (event) => {
  const route = routeShellRequest(event.request, worker.location.origin, __RECENSE_SHELL__);
  if (route) event.respondWith(shellResponse(event.request, route, name, worker.caches, worker.fetch.bind(worker)));
});
