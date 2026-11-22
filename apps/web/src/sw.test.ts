import { expect, test, vi } from "vitest";
import { activateShell, routeShellRequest, shellResponse } from "./sw-routing.ts";

const origin = "https://hub.example.ts.net";
const shell = [
  "/",
  "/index.html",
  "/theme-boot.js",
  "/assets/app-abcd1234.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
];
const request = (path: string, mode = "navigate", method = "GET") =>
  ({ url: new URL(path, origin).href, mode, method }) as Request;
test("routing never intercepts APIs, content, other paths, foreign origins, or mutations", () => {
  for (const path of [
    "/api/v1/devices",
    "/api/",
    "/content/key/doc.html",
    "/other",
    "/assets/unknown.js",
    "https://other.example/",
    "/manifest.webmanifest?other",
  ])
    expect(routeShellRequest(request(path), origin, shell)).toBeNull();
  expect(routeShellRequest(request("/", "navigate", "POST"), origin, shell)).toBeNull();
  expect(routeShellRequest(request("/assets/app-abcd1234.js", "cors"), origin, shell)).toBe("asset");
  expect(routeShellRequest(request("/theme-boot.js", "no-cors"), origin, shell)).toBe("asset");
  for (const path of ["/", "/devices", "/devices/pair", "/pair", "/r/11111111-1111-4111-8111-111111111111?tab=docs"])
    expect(routeShellRequest(request(path), origin, shell)).toBe("navigation");
});
test("the blocking theme script is served from the shell cache offline", async () => {
  const cached = new Response("theme script");
  const match = vi.fn(async () => cached);
  const caches = { open: vi.fn(async () => ({ match })) } as unknown as CacheStorage;
  const fetcher = vi.fn().mockRejectedValue(new TypeError("offline"));
  const req = request("/theme-boot.js", "no-cors");
  expect(await shellResponse(req, "asset", "emend-shell-new", caches, fetcher)).toBe(cached);
  expect(match).toHaveBeenCalledWith(req);
  expect(fetcher).not.toHaveBeenCalled();
});
test("navigation is network first and offline falls back to cached shell without caching review pages", async () => {
  const cached = new Response("cached shell");
  const match = vi.fn(async () => cached);
  const put = vi.fn();
  const caches = { open: vi.fn(async () => ({ match, put })) } as unknown as CacheStorage;
  const fetcher = vi.fn(async () => new Response("network"));
  const req = request("/devices");
  expect(await (await shellResponse(req, "navigation", "emend-shell-new", caches, fetcher)).text()).toBe("network");
  expect(match).not.toHaveBeenCalled();
  fetcher.mockRejectedValue(new TypeError("offline"));
  expect(await (await shellResponse(req, "navigation", "emend-shell-new", caches, fetcher)).text()).toBe(
    "cached shell",
  );
  expect(match).toHaveBeenCalledWith("/index.html");
  expect(put).not.toHaveBeenCalled();
});
test("activate deletes only old app shell caches", async () => {
  const remove = vi.fn(async () => true);
  await activateShell(
    {
      keys: async () => ["emend-shell-old", "emend-shell-new", "unrelated"],
      delete: remove,
    } as unknown as CacheStorage,
    "emend-shell-new",
  );
  expect(remove.mock.calls).toEqual([["emend-shell-old"]]);
});

test("settings, sample and integrations hard loads use the app shell", () => {
  for (const path of [
    "/settings",
    "/settings/sample",
    "/settings/sample/",
    "/settings/integrations",
    "/settings/integrations/",
  ])
    expect(routeShellRequest(request(path), origin, shell)).toBe("navigation");
  expect(routeShellRequest(request("/settings/unknown"), origin, shell)).toBeNull();
});
