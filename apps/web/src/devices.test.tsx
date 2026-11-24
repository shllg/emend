import type { DeviceView } from "@recense/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";

const item: DeviceView = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "browser",
  name: "Synthetic browser",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: null,
  current: true,
};
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return {
    client,
    ...render(
      <StrictMode>
        <App queryClient={client} history={createMemoryHistory({ initialEntries: ["/devices"] })} />
      </StrictMode>,
    ),
  };
}
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function responseError(status: number) {
  return Response.json({ error: { code: "failed", message: "Failed" } }, { status });
}

test("devices shows kinds, dates, current tag, relative last seen and literal hostile names", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:05:00.000Z"));
  const hostile = "<img src=x onerror=alert(1)>";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        items: [
          { ...item, lastSeenAt: item.createdAt },
          { ...item, id: "22222222-2222-4222-8222-222222222222", name: hostile, kind: "machine", current: false },
        ],
      }),
    ),
  );
  const { container } = mount();
  await screen.findByText(item.name);
  expect(screen.getByText("This device")).toBeTruthy();
  expect(
    screen.getByText("Browsers and machines that can use this hub. Sign-ins last 30 days and renew while in use."),
  ).toBeTruthy();
  const [browserRow, machineRow] = screen.getAllByRole("listitem");
  if (!browserRow || !machineRow) throw new Error("Missing device rows");
  const date = new Date(item.createdAt).toLocaleDateString();
  expect(within(browserRow).getByText("Browser · paired").textContent).toBe(`Browser · paired ${date}`);
  expect(within(browserRow).getByText("5m")).toBeTruthy();
  expect(within(browserRow).queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(within(browserRow).getByRole("button", { name: "Sign out" })).toBeTruthy();
  expect(within(machineRow).getByText("Machine · attached").textContent).toBe(`Machine · attached ${date}`);
  expect(within(machineRow).getByText("never")).toBeTruthy();
  expect(screen.getByText(hostile)).toBeTruthy();
  expect(container.querySelector("img, [onerror]")).toBeNull();
  expect(screen.getByRole("link", { name: "Pair a device" }).getAttribute("href")).toBe("/devices/pair");
  fireEvent.click(within(machineRow).getByRole("button", { name: "Revoke" }));
  expect(screen.getByRole("alertdialog", { name: `Revoke ${hostile}?` })).toBeTruthy();
  expect(document.querySelector("img, [onerror]")).toBeNull();
});

test.each([
  ["browser", "It signs out now and needs a new code to pair again."],
  ["machine", "It loses access to this hub now and needs a new code to attach again."],
])("revoking a %s names it, explains the effect, and Cancel sends nothing", async (kind, description) => {
  const fetcher = vi.fn(async () => Response.json({ items: [{ ...item, kind, current: false }] }));
  const confirm = vi.fn();
  vi.stubGlobal("confirm", confirm);
  vi.stubGlobal("fetch", fetcher);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  const dialog = screen.getByRole("alertdialog", { name: `Revoke ${item.name}?` });
  expect(within(dialog).getByText(description)).toBeTruthy();
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  const calls = fetcher.mock.calls.length;
  fireEvent.click(cancel);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(calls);
  expect(confirm).not.toHaveBeenCalled();
});

test("confirm sends one DELETE while busy, closes and refetches other devices", async () => {
  let revoked = false;
  const pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      const response = await pending.promise;
      revoked = true;
      return response;
    }
    return Response.json({ items: revoked ? [] : [{ ...item, current: false }] });
  });
  vi.stubGlobal("fetch", fetcher);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  const confirm = within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" });
  act(() => {
    fireEvent.click(confirm);
    fireEvent.click(confirm);
  });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(true));
  const deletes = () => fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE");
  expect(deletes()).toHaveLength(1);
  expect(deletes()[0]).toEqual([`/api/v1/devices/${item.id}`, expect.objectContaining({ method: "DELETE" })]);
  const gets = fetcher.mock.calls.filter(([path]) => path === "/api/v1/devices").length;
  pending.resolve(new Response(null, { status: 204 }));
  await screen.findByText("No paired devices.");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/devices")).toHaveLength(gets + 1);
  expect(deletes()).toHaveLength(1);
});

test.each([false, true])(
  "a 404 closes and refetches without error or sign-out redirect (current=%s)",
  async (current) => {
    let gone = false;
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        gone = true;
        return responseError(404);
      }
      return Response.json({ items: gone ? [] : [{ ...item, current }] });
    });
    vi.stubGlobal("fetch", fetcher);
    mount();
    const action = current ? "Sign out" : "Revoke";
    fireEvent.click(await screen.findByRole("button", { name: action }));
    const gets = fetcher.mock.calls.filter(([path]) => path === "/api/v1/devices").length;
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: action }));
    await screen.findByText("No paired devices.");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/v1/devices")).toHaveLength(gets + 1);
    expect(assign).not.toHaveBeenCalled();
  },
);

test("a failed revoke stays in its dialog and can be retried", async () => {
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return ++attempts === 1 ? responseError(500) : new Response(null, { status: 204 });
      return Response.json({ items: attempts === 2 ? [] : [{ ...item, current: false }] });
    }),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  const dialog = screen.getByRole("alertdialog");
  const confirm = within(dialog).getByRole("button", { name: "Revoke" });
  fireEvent.click(confirm);
  expect((await within(dialog).findByRole("alert")).textContent).toBe("Could not revoke the device. Try again.");
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  expect((confirm as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(confirm);
  await screen.findByText("No paired devices.");
  expect(attempts).toBe(2);
});

test("current device sign-out confirms, sends DELETE, clears cache and assigns /pair", async () => {
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  const fetcher = vi.fn(async (_path: string, init?: RequestInit) =>
    init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ items: [item] }),
  );
  vi.stubGlobal("fetch", fetcher);
  const { client } = mount();
  client.setQueryData(["synthetic-cache-entry"], { value: "cached" });
  const clear = vi.spyOn(client, "clear");
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  const dialog = screen.getByRole("alertdialog", { name: "Sign out of this browser?" });
  expect(within(dialog).getByText("You will need a new code to sign in again.")).toBeTruthy();
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("/pair"));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  expect(clear).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(["synthetic-cache-entry"])).toBeUndefined();
  expect(clear.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0] ?? 0);
});

test("the scrolling main stays outside the centred devices content column", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ items: [] })),
  );
  mount();
  await screen.findByText("No paired devices.");
  const heading = screen.getByRole("heading", { name: "Devices", level: 1 });
  const main = screen.getByRole("main");
  const column = main.firstElementChild;
  expect(main.className).toContain("overflow-y-auto");
  expect(main.classList.contains("relative")).toBe(true);
  expect(main.className).not.toMatch(/max-w-|mx-auto/);
  expect(column?.contains(heading)).toBe(true);
  expect(column?.className).toContain("max-w-[760px]");
  expect(column?.className).toContain("mx-auto");
  expect(column?.className).toContain("w-full");
  expect(column?.className).not.toContain("overflow");
});
