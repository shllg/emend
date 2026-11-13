import { act, screen, waitFor, within } from "@testing-library/react";
import * as reactDom from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const routers = vi.hoisted(() => ({
  initialHashes: [] as string[],
  observedHrefs: [] as string[],
  created: [] as ReturnType<typeof import("./router.tsx").createWebRouter>[],
}));
vi.mock("react-dom/client", async (original) => {
  const actual = await original<typeof import("react-dom/client")>();
  return { ...actual, createRoot: vi.fn(actual.createRoot) };
});

let root: reactDom.Root | undefined;
const nativePushState = window.history.pushState;
const nativeReplaceState = window.history.replaceState;
let removeListeners = () => {};
beforeEach(() => {
  vi.resetModules();
  vi.doMock("./router.tsx", async (original) => {
    const actual = await original<typeof import("./router.tsx")>();
    return {
      ...actual,
      createWebRouter: (...args: Parameters<typeof actual.createWebRouter>) => {
        const router = actual.createWebRouter(...args);
        routers.initialHashes.push(router.latestLocation.hash);
        routers.created.push(router);
        router.history.subscribe(({ location }) => routers.observedHrefs.push(location.href));
        router.subscribe("onBeforeNavigate", ({ toLocation }) => routers.observedHrefs.push(toLocation.href));
        return router;
      },
    };
  });
  routers.initialHashes.length = 0;
  routers.observedHrefs.length = 0;
  routers.created.length = 0;
  const added = vi.spyOn(window, "addEventListener");
  removeListeners = () => {
    for (const [event, listener, options] of added.mock.calls) {
      if (event === "hashchange" || event === "popstate") window.removeEventListener(event, listener, options);
    }
  };
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  for (const router of routers.created.toReversed()) router.history.destroy();
  removeListeners();
  document.getElementById("root")?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.pushState = nativePushState;
  window.history.replaceState = nativeReplaceState;
});
async function boot() {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const actual = await vi.importActual<typeof import("react-dom/client")>("react-dom/client");
  vi.mocked(reactDom.createRoot).mockImplementation((container) => {
    root = actual.createRoot(container);
    return root;
  });
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  await act(async () => {
    await import("./main.tsx");
  });
}
function expectRouterHasNoSecret(secret: string) {
  expect(routers.initialHashes.every((hash) => hash === "")).toBe(true);
  expect(routers.created.every((router) => !router.latestLocation.href.includes(secret))).toBe(true);
  expect(routers.observedHrefs.every((href) => !href.includes(secret))).toBe(true);
}
async function fragment(path: string, event: "hashchange" | "popstate") {
  await act(async () => {
    // Simulate native navigation without invoking Router's patched pushState before the event.
    nativePushState.call(window.history, null, "", path);
    window.dispatchEvent(event === "hashchange" ? new HashChangeEvent(event) : new PopStateEvent(event));
  });
}
test.each(["/pair", "/pair/", "/Pair"])(
  "startup at %s hides the pairing fragment from Router and history, posts it once, and never invokes Function",
  async (path) => {
    const secret = `emp_${"b".repeat(43)}`;
    window.history.replaceState(null, "", `${path}#${secret}`);
    const replaced = vi.spyOn(window.history, "replaceState");
    const dynamicFunction = vi.spyOn(globalThis, "Function").mockImplementation(() => {
      throw new Error("CSP forbids Function");
    });
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      expect(location.hash).toBe("");
      if (path === "/api/v1/session") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ secret });
        return new Response(null, { status: 204 });
      }
      return Response.json({
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date(Date.now()).toISOString(),
        items: [],
      });
    });
    vi.stubGlobal("fetch", fetch);
    await boot();
    expect(location.href).not.toContain(secret);
    await screen.findByRole("heading", { name: "Inbox" });
    expect(location.pathname).toBe("/");
    expect(routers.initialHashes.length).toBeGreaterThan(0);
    expectRouterHasNoSecret(secret);
    expect(replaced).toHaveBeenCalledWith(null, "", "/pair");
    expect(JSON.stringify(replaced.mock.calls)).not.toContain(secret);
    expect(fetch.mock.calls.filter(([path]) => path === "/api/v1/session")).toHaveLength(1);
    for (const [path, init] of fetch.mock.calls) {
      expect(path).not.toContain(secret);
      expect(JSON.stringify(init?.headers ?? {})).not.toContain(secret);
      if (path !== "/api/v1/session") expect(JSON.stringify(init ?? {})).not.toContain(secret);
    }
    expect(dynamicFunction).not.toHaveBeenCalled();
  },
);

test.each([
  ["/pair", "hashchange"],
  ["/pair", "popstate"],
  ["/pair/", "hashchange"],
  ["/pair/", "popstate"],
  ["/Pair", "hashchange"],
  ["/Pair", "popstate"],
] as const)("mounted pairing page strips %s on %s before Router and redeems it once", async (path, event) => {
  const secret = `emp_${"c".repeat(43)}`;
  window.history.replaceState(null, "", "/pair");
  const replaced = vi.spyOn(window.history, "replaceState");
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetch = vi.fn((path: string, init?: RequestInit) => {
    if (path === "/api/v1/session") {
      expect(location.hash).toBe("");
      expect(JSON.parse(String(init?.body))).toEqual({ secret });
      return pending;
    }
    return Promise.resolve(
      Response.json({
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: new Date(Date.now()).toISOString(),
        items: [],
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  await boot();
  await screen.findByRole("heading", { name: "Sign in" });
  await fragment(`${path}#${secret}`, event);
  expect(location.hash).toBe("");
  expect(replaced).toHaveBeenCalledWith(null, "", "/pair");
  expectRouterHasNoSecret(secret);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(within(screen.getByRole("main")).getByRole("status").textContent).toBe("Pairing…");
  expect(screen.queryByLabelText("Pairing code")).toBeNull();
  expect(screen.queryByRole("button", { name: "Pair" })).toBeNull();
  const { takePairingSecret } = await import("./lib/pairing-secret.ts");
  expect(takePairingSecret()).toBeUndefined();
  // A repeated arrival while redemption is pending must also be stripped without another POST.
  await fragment(`${path}#${secret}`, event);
  expect(location.hash).toBe("");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(takePairingSecret()).toBeUndefined();
  await act(async () => finish(new Response(null, { status: 204 })));
  await screen.findByRole("heading", { name: "Inbox" });
  expectRouterHasNoSecret(secret);
  expect(JSON.stringify(replaced.mock.calls)).not.toContain(secret);
  // Both fragment entries were replaced in place; traversing back cannot reveal either secret.
  await act(async () => window.history.back());
  await waitFor(() => expect(location.pathname).toBe("/pair"));
  expect(location.hash).toBe("");
  await act(async () => window.history.back());
  expect(location.hash).toBe("");
  expect(fetch.mock.calls.filter(([path]) => path === "/api/v1/session")).toHaveLength(1);
  expectRouterHasNoSecret(secret);
});

test("a failed secret is not posted again, and a different arriving secret can pair", async () => {
  const first = `emp_${"d".repeat(43)}`;
  const second = `emp_${"e".repeat(43)}`;
  window.history.replaceState(null, "", "/pair");
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/v1/session" && JSON.parse(String(init?.body)).secret === first)
      return Response.json({ error: { code: "unauthorized", message: "Invalid pairing" } }, { status: 401 });
    return path === "/api/v1/session"
      ? new Response(null, { status: 204 })
      : Response.json({
          approvedActiveHours: 12,
          approvedActiveLimit: 5,
          serverTime: new Date(Date.now()).toISOString(),
          items: [],
        });
  });
  vi.stubGlobal("fetch", fetch);
  await boot();
  await screen.findByRole("heading", { name: "Sign in" });
  await fragment(`/pair#${first}`, "hashchange");
  await screen.findByRole("alert");
  await fragment(`/pair#${first}`, "popstate");
  expect(fetch).toHaveBeenCalledTimes(1);
  await fragment(`/pair#${second}`, "hashchange");
  await screen.findByRole("heading", { name: "Inbox" });
  expect(
    fetch.mock.calls.filter(([path]) => path === "/api/v1/session").map(([, init]) => JSON.parse(String(init?.body))),
  ).toEqual([{ secret: first }, { secret: second }]);
  expectRouterHasNoSecret(first);
  expectRouterHasNoSecret(second);
});

test.each(["hashchange", "popstate"] as const)("%s leaves fragments on another path alone", async (event) => {
  window.history.replaceState(null, "", "/devices");
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
    Response.json({
      approvedActiveHours: 12,
      approvedActiveLimit: 5,
      serverTime: new Date(Date.now()).toISOString(),
      items: [],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await boot();
  await screen.findByRole("heading", { name: "Devices" });
  await fragment("/devices#section", event);
  expect(location.hash).toBe("#section");
  expect(fetch.mock.calls.filter(([path, init]) => path === "/api/v1/session" && init?.method === "POST")).toEqual([]);
  const { takePairingSecret } = await import("./lib/pairing-secret.ts");
  expect(takePairingSecret()).toBeUndefined();
});

test.each(["/pairs#x", "/pair/x#y"])("startup and navigation leave %s alone", async (path) => {
  const expectedHash = path.slice(path.indexOf("#"));
  window.history.replaceState(null, "", path);
  const fetch = vi.fn(async () =>
    Response.json({
      approvedActiveHours: 12,
      approvedActiveLimit: 5,
      serverTime: new Date(Date.now()).toISOString(),
      items: [],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await boot();
  await screen.findByRole("heading", { name: "Page not found" });
  const { takePairingSecret } = await import("./lib/pairing-secret.ts");
  expect(location.hash).toBe(expectedHash);
  expect(takePairingSecret()).toBeUndefined();
  for (const event of ["hashchange", "popstate"] as const) {
    await fragment(path, event);
    expect(location.hash).toBe(expectedHash);
    expect(takePairingSecret()).toBeUndefined();
  }
  expect(fetch).not.toHaveBeenCalled();
});

test.each([false, true])("registers the root service worker only in production (%s)", async (production) => {
  vi.stubEnv("PROD", production);
  const registration = { waiting: null, installing: null, update: vi.fn(async () => {}), addEventListener() {} };
  const register = vi.fn(async () => registration);
  vi.stubGlobal("navigator", { serviceWorker: { register, controller: null, addEventListener() {} } });
  window.history.replaceState(null, "", "/pair");
  try {
    await boot();
    expect(register.mock.calls).toEqual(production ? [["/sw.js"]] : []);
    await waitFor(() => expect(registration.update).toHaveBeenCalledTimes(production ? 1 : 0));
  } finally {
    vi.unstubAllEnvs();
  }
});
