import type { PairingCreated } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { encode } from "uqr";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { takePairingIntent } from "./lib/pairing-intent.ts";

const origin = "https://hub.example.ts.net";
const secret = `emp_${"a".repeat(43)}`;
const loopbackMessage =
  "This hub accepts connections from this computer only. To pair a phone, start emend with --tailscale.";
const clients: QueryClient[] = [];
function pairing(overrides: Partial<PairingCreated> = {}): PairingCreated {
  return {
    url: `${origin}/pair#${secret}`,
    code: "ABCD-EFGH",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...overrides,
  };
}
function mount(path: string | string[] | RouterHistory = "/devices/pair", initialIndex?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const history =
    typeof path === "string" || Array.isArray(path)
      ? createMemoryHistory({ initialEntries: typeof path === "string" ? [path] : path, initialIndex })
      : path;
  return {
    client,
    history,
    ...render(
      <StrictMode>
        <App queryClient={client} history={history} />
      </StrictMode>,
    ),
  };
}
async function createCode() {
  fireEvent.click(await screen.findByRole("button", { name: "Create code" }));
}
function serve(create: () => Response | Promise<Response> = () => Response.json(pairing())) {
  const fetcher = vi.fn(async (path: string) => {
    if (path === "/api/v1/pairings") return create();
    if (path !== "/api/v1/devices") return Response.json({ serverTime: new Date(Date.now()).toISOString(), items: [] });
    return Response.json({
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Synthetic browser",
          kind: "browser",
          current: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: null,
        },
      ],
    });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => {
  cleanup();
  takePairingIntent();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
});

test("a direct dialog load stays idle until Create code is clicked, then POSTs once under StrictMode", async () => {
  const fetcher = serve();
  mount();
  const create = await screen.findByRole("button", { name: "Create code" });
  expect(screen.getByText("Create a code for another browser or phone.")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
  expect(screen.queryByText("Creating pairing…")).toBeNull();
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(0);
  act(() => {
    fireEvent.click(create);
    fireEvent.click(create);
  });
  await screen.findByText("ABCD-EFGH");
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(1);
});

test.each(["Devices link", "Inbox menu", "Devices menu"])(
  "%s creates once under StrictMode, consumes its intent, and does not persist it",
  async (source) => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const fetcher = serve();
    const stored = vi.spyOn(Storage.prototype, "setItem");
    const { unmount, history } = mount(source === "Inbox menu" ? "/" : "/devices");
    await screen.findByRole("heading", { name: source === "Inbox menu" ? "Inbox" : "Devices" });
    if (source === "Devices link") fireEvent.click(screen.getByRole("link", { name: "Pair a device" }), { button: 0 });
    else {
      fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Pair a device" }), { button: 0 });
    }
    await screen.findByText("ABCD-EFGH");
    expect(screen.queryByRole("button", { name: "Create code" })).toBeNull();
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(1);
    expect(takePairingIntent()).toBeUndefined();
    expect(stored).not.toHaveBeenCalled();
    expect(history.location.href).toBe("/devices/pair");
    expect(history.location.state).not.toHaveProperty("devicesIndex");
    const pairIndex = history.location.state.__TSR_index;
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(history.location.state.__TSR_index).toBe(source === "Inbox menu" ? pairIndex : pairIndex - 1),
    );
    unmount();
    // A second app/dialog mount gets no authorization from the earlier click.
    mount();
    await screen.findByRole("button", { name: "Create code" });
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(1);
    expect(stored).not.toHaveBeenCalled();
  },
);

test.each([
  { name: "ctrl", click: { button: 0, ctrlKey: true } },
  { name: "cmd", click: { button: 0, metaKey: true } },
  { name: "shift", click: { button: 0, shiftKey: true } },
  { name: "alt", click: { button: 0, altKey: true } },
  { name: "middle", click: { button: 1 } },
])("a $name-click does not leave an intent for a later history navigation", async ({ click }) => {
  const fetcher = serve();
  const { history } = mount("/devices");
  fireEvent.click(await screen.findByRole("link", { name: "Pair a device" }), click);
  expect(history.location.pathname).toBe("/devices");
  act(() => history.push("/devices/pair"));
  await screen.findByRole("button", { name: "Create code" });
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(0);
});

test.each(["light", "dark"])(
  "pair dialog keeps the list and URL, POSTs once in StrictMode and exposes only a safe QR in %s mode",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const created = pairing();
    const fetcher = serve(() => Response.json(created));
    const stored = vi.spyOn(Storage.prototype, "setItem");
    const logged = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const { client, history } = mount();
    await createCode();
    await screen.findByText(created.code);
    const dialog = screen.getByRole("alertdialog", { name: "Pair a device" });
    const main = screen.getByRole("main", { hidden: true });
    expect(main.textContent).toContain("Synthetic browser");
    expect(within(main).getByRole("heading", { name: "Devices", hidden: true })).toBeTruthy();
    expect(main.contains(dialog)).toBe(false);
    expect(history.location.pathname).toBe("/devices/pair");
    expect(within(dialog).getByText(origin)).toBeTruthy();
    expect(screen.queryByText(loopbackMessage)).toBeNull();
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/pairings",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ purpose: "device" }) }),
    );
    const svg = within(dialog).getByRole("img", { name: "Pairing QR code" });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    const qr = encode(created.url, { border: 4 });
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${qr.size} ${qr.size}`);
    expect(svg.getAttribute("width")).toBe("256");
    expect(svg.getAttribute("height")).toBe("256");
    expect(svg.getAttribute("class")).toContain("w-full");
    expect(svg.getAttribute("class")).toContain("max-w-[256px]");
    expect(svg.getAttribute("class")).toContain("h-auto");
    const background = svg.querySelector("rect");
    expect(background?.getAttribute("fill")).toBe("white");
    expect(background?.getAttribute("width")).toBe(String(qr.size));
    expect(background?.getAttribute("height")).toBe(String(qr.size));
    const cells = Array.from(svg.querySelectorAll('rect[fill="black"]'), (cell) => ({
      x: Number(cell.getAttribute("x")),
      y: Number(cell.getAttribute("y")),
    }));
    expect(cells).toEqual(qr.data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [{ x, y }] : []))));
    expect(cells.length).toBeGreaterThan(50);
    expect(cells.every(({ x, y }) => x >= 4 && y >= 4 && x < qr.size - 4 && y < qr.size - 4)).toBe(true);
    const surfaces = [
      document.documentElement.textContent,
      ...Array.from(document.querySelectorAll("*"), (element) =>
        Array.from(element.attributes, (attribute) => attribute.value).join(" "),
      ),
      window.location.href,
      history.location.href,
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map(({ queryKey, state }) => ({ queryKey, state })),
      ),
      JSON.stringify(client.getMutationCache().getAll()),
      JSON.stringify(stored.mock.calls),
      ...logged.map((log) => JSON.stringify(log.mock.calls)),
    ];
    expect(surfaces.every((surface) => !surface?.includes(secret) && !surface?.includes(created.url))).toBe(true);
  },
);

test.each(["http://127.0.0.1:3636", "http://localhost:3636", "http://[::1]:3636"])(
  "a %s pairing warns above the QR and still shows the code",
  async (hub) => {
    serve(() => Response.json(pairing({ url: `${hub}/pair#${secret}` })));
    mount();
    await createCode();
    await screen.findByText("ABCD-EFGH");
    const banner = screen.getByText(loopbackMessage).closest('[role="status"]');
    if (!banner) throw new Error("Missing loopback banner");
    const qr = screen.getByRole("img", { name: "Pairing QR code" });
    expect(banner.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  },
);

test("expiry follows the clock, announces only expiration, and New code replaces the QR and code once", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  let creates = 0;
  const fetcher = serve(() =>
    Response.json(
      ++creates === 1
        ? pairing({ expiresAt: new Date(Date.now() + 3000).toISOString() })
        : pairing({ code: "JK7P-2MXD", url: `${origin}/pair#emp_${"b".repeat(43)}` }),
    ),
  );
  const { unmount } = mount();
  await createCode();
  const countdown = await screen.findByText("Expires in 0:03");
  expect(countdown.closest('[role="status"], [aria-live]')).toBeNull();
  expect(countdown.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  const originalQr = screen.getByRole("img", { name: "Pairing QR code" }).cloneNode(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByText("Expires in 0:02")).toBeTruthy();
  // A resumed background tab uses the browser clock, not the number of ticks.
  vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByText("This code expired.").getAttribute("role")).toBe("status");
  expect(screen.queryByText(/^Expires in/)).toBeNull();
  expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
  expect(screen.queryByText("ABCD-EFGH")).toBeNull();
  // Once discarded, moving the clock back must not resurrect the old credentials.
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByText("This code expired.")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
  expect(screen.queryByText("ABCD-EFGH")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New code" }));
  await screen.findByText("JK7P-2MXD");
  expect(screen.queryByText("ABCD-EFGH")).toBeNull();
  expect(screen.queryByText("This code expired.")).toBeNull();
  expect(screen.getByText("Expires in 10:00")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Pairing QR code" }).isEqualNode(originalQr)).toBe(false);
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(2);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  [1200, "Expires in 10:00"],
  [-60, "This code expired."],
])("expiry clamps a %s second clock offset", async (offset, expected) => {
  serve(() => Response.json(pairing({ expiresAt: new Date(Date.now() + offset * 1000).toISOString() })));
  mount();
  await createCode();
  expect(await screen.findByText(expected)).toBeTruthy();
  if (offset < 0) {
    expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
  }
});

test("a browser five minutes behind gets one ten-minute deadline on arrival", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  const fetcher = serve(() => Response.json(pairing({ expiresAt: "2026-01-01T00:15:00.000Z" })));
  mount();
  await createCode();
  await screen.findByText("Expires in 10:00");
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText("Expires in 9:59")).toBeTruthy();
  act(() => vi.advanceTimersByTime(598_000));
  expect(screen.getByText("Expires in 0:01")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Pairing QR code" })).toBeTruthy();
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText("This code expired.")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
  expect(screen.queryByText("ABCD-EFGH")).toBeNull();
  expect(screen.getByRole("button", { name: "New code" })).toBeTruthy();
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(1);
});

test.each(["Done", "Escape", "outside"])(
  "closing by %s returns to Devices and refetches, reopening POSTs once",
  async (how) => {
    const fetcher = serve();
    const { history, client } = mount("/devices");
    const opener = await screen.findByRole("link", { name: "Pair a device" });
    const main = screen.getByRole("main");
    // Closing must refetch even when the existing list is considered fresh.
    client.setQueryDefaults(["devices"], { staleTime: Infinity });
    opener.focus();
    fireEvent.click(opener, { button: 0 });
    await screen.findByText("ABCD-EFGH");
    expect(history.location.pathname).toBe("/devices/pair");
    const gets = fetcher.mock.calls.filter(([path]) => path === "/api/v1/devices").length;
    if (how === "Done") fireEvent.click(screen.getByRole("button", { name: "Done" }));
    else if (how === "Escape") fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    else {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const overlay = document.querySelector(".bg-overlay");
      if (!overlay) throw new Error("Missing dialog overlay");
      fireEvent.pointerDown(overlay, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(overlay, { button: 0, pointerType: "mouse" });
      fireEvent.click(overlay);
    }
    await waitFor(() => expect(history.location.pathname).toBe("/devices"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/devices")).toHaveLength(gets + 1),
    );
    expect(screen.getByRole("main")).toBe(main);
    await waitFor(() => expect(document.activeElement).toBe(opener));
    fireEvent.click(opener, { button: 0 });
    await screen.findByText("ABCD-EFGH");
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(2);
  },
);

test.each([false, true])("Back refreshes Devices and Forward requires a new click (reload=%s)", async (reload) => {
  const fetcher = serve();
  const { history, client, unmount } = mount("/devices");
  const opener = await screen.findByRole("link", { name: "Pair a device" });
  client.setQueryDefaults(["devices"], { staleTime: Infinity });
  fireEvent.click(opener, { button: 0 });
  await screen.findByText("ABCD-EFGH");
  const gets = fetcher.mock.calls.filter(([path]) => path === "/api/v1/devices").length;
  act(() => history.back());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(history.location.pathname).toBe("/devices");
  await waitFor(() => expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/devices")).toHaveLength(gets + 1));
  if (reload) {
    // Recreate all app/router state while preserving the tab's history entries.
    unmount();
    mount(history);
    await screen.findByRole("heading", { name: "Devices" });
  }
  await act(async () => history.forward());
  await screen.findByRole("button", { name: "Create code" });
  expect(history.location.pathname).toBe("/devices/pair");
  expect(screen.getByText("Create a code for another browser or phone.")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(1);
  // Choosing Pair a device again is still an explicit, fresh opening.
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(await screen.findByRole("link", { name: "Pair a device" }), { button: 0 });
  await screen.findByText("ABCD-EFGH");
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(2);
});

test.each(["Devices", "direct link", "another page"])(
  "Done from %s uses the right history entry and neither Back nor Forward creates a pairing",
  async (source) => {
    const fetcher = serve();
    const initialEntries =
      source === "Devices" ? ["/", "/devices"] : source === "direct link" ? ["/", "/devices/pair"] : ["/"];
    const { history } = mount(initialEntries);
    if (source === "Devices") {
      fireEvent.click(await screen.findByRole("link", { name: "Pair a device" }), { button: 0 });
    } else if (source === "another page") {
      await screen.findByRole("heading", { name: "Inbox" });
      act(() => history.push("/devices/pair"));
    }
    if (source !== "Devices") await createCode();
    await screen.findByText("ABCD-EFGH");
    const pairIndex = history.location.state.__TSR_index;
    const done = screen.getByRole("button", { name: "Done" });
    act(() => {
      fireEvent.click(done);
      fireEvent.click(done);
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(history.location.state.__TSR_index).toBe(source === "Devices" ? pairIndex - 1 : pairIndex),
    );
    expect(history.location.pathname).toBe("/devices");
    await act(async () => history.back());
    await screen.findByRole("heading", { name: "Inbox" });
    expect(history.location.pathname).toBe("/");
    await act(async () => history.forward());
    await screen.findByRole("heading", { name: "Devices" });
    if (source === "Devices") await act(async () => history.forward());
    expect(history.location.pathname).toBe("/devices");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(1);
  },
);

test("Forward leaving the dialog refreshes Devices and returning Back does not create a pairing", async () => {
  const fetcher = serve();
  const { history } = mount(["/", "/devices/pair", "/devices"], 1);
  await createCode();
  await screen.findByText("ABCD-EFGH");
  const gets = fetcher.mock.calls.filter(([path]) => path === "/api/v1/devices").length;
  act(() => history.forward());
  await screen.findByRole("heading", { name: "Devices" });
  await waitFor(() => expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/devices")).toHaveLength(gets + 1));
  await act(async () => history.back());
  await screen.findByRole("button", { name: "Create code" });
  expect(history.location.pathname).toBe("/devices/pair");
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(1);
});

test("in-app navigation away refreshes the inactive Devices list without creating a pairing on Back", async () => {
  const fetcher = serve();
  const { history, client } = mount();
  await createCode();
  await screen.findByText("ABCD-EFGH");
  const gets = fetcher.mock.calls.filter(([path]) => path === "/api/v1/devices").length;
  client.setQueryDefaults(["devices"], { staleTime: Infinity });
  fireEvent.click(screen.getByRole("link", { name: "emend", hidden: true }), { button: 0 });
  await screen.findByRole("heading", { name: "Inbox" });
  await waitFor(() => expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/devices")).toHaveLength(gets + 1));
  await act(async () => history.back());
  await screen.findByRole("button", { name: "Create code" });
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(1);
});

test("failed create shows the fixed message and Try again can recover", async () => {
  let creates = 0;
  const fetcher = serve(() =>
    ++creates === 1
      ? Response.json({ error: { code: "failed", message: "Synthetic server failure" } }, { status: 500 })
      : Response.json(pairing()),
  );
  mount();
  await createCode();
  expect(await screen.findByText("Could not create a pairing. Try again.")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("ABCD-EFGH");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(2);
});

test("closing a pending create and reopening ignores the old response", async () => {
  const first = Promise.withResolvers<Response>();
  let creates = 0;
  const fetcher = serve(() => (++creates === 1 ? first.promise : Response.json(pairing({ code: "JK7P-2MXD" }))));
  const { history } = mount();
  await createCode();
  await screen.findByText("Creating pairing…");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(history.location.pathname).toBe("/devices"));
  fireEvent.click(screen.getByRole("link", { name: "Pair a device" }), { button: 0 });
  await screen.findByText("JK7P-2MXD");
  await act(async () => {
    first.resolve(Response.json(pairing()));
  });
  expect(screen.queryByText("ABCD-EFGH")).toBeNull();
  expect(screen.getByText("JK7P-2MXD")).toBeTruthy();
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/pairings")).toHaveLength(2);
});
