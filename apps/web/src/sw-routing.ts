export const SHELL_CACHE_PREFIX = "recense-shell-";
// The cache name before the rename; activation clears it so an old shell does not linger.
const LEGACY_SHELL_CACHE_PREFIX = "emend-shell-";
export type ShellRoute = "navigation" | "asset";

/** Intercept only known app routes and exact build-listed shell files. */
export function routeShellRequest(request: Request, origin: string, shell: readonly string[]): ShellRoute | null {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== origin) return null;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/content/")) return null;
  if (
    request.mode === "navigate" &&
    /^(?:\/|\/index\.html|\/pair\/?|\/devices(?:\/pair)?\/?|\/settings(?:\/sample|\/integrations)?\/?|\/r\/[0-9a-f-]{36}\/?)$/i.test(
      url.pathname,
    )
  )
    return "navigation";
  if (!url.search && shell.includes(url.pathname))
    return request.mode === "navigate" && ["/", "/index.html"].includes(url.pathname) ? "navigation" : "asset";
  return null;
}

export async function shellResponse(
  request: Request,
  route: ShellRoute,
  name: string,
  storage: CacheStorage,
  fetcher: typeof fetch,
): Promise<Response> {
  if (route === "navigation") {
    try {
      return await fetcher(request);
    } catch {
      const response = await (await storage.open(name)).match("/index.html");
      if (response) return response;
      throw new Error("The app shell is unavailable offline.");
    }
  }
  return (await (await storage.open(name)).match(request)) ?? fetcher(request);
}
export async function activateShell(storage: CacheStorage, name: string): Promise<void> {
  await Promise.all(
    (await storage.keys())
      .filter(
        (key) => (key.startsWith(SHELL_CACHE_PREFIX) && key !== name) || key.startsWith(LEGACY_SHELL_CACHE_PREFIX),
      )
      .map((key) => storage.delete(key)),
  );
}
