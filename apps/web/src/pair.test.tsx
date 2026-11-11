import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Window } from "happy-dom";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";

const clients: QueryClient[] = [];
const browser = (window as unknown as Window).happyDOM;
function mount() {
  browser.setURL("https://hub.example.ts.net/pair");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const history = createMemoryHistory({ initialEntries: ["/pair"] });
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
afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  await browser.abort();
  browser.setURL("http://localhost:3000");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("Pair this device explains code entry, requires eight characters, and submits once while busy", async () => {
  const pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn(async (path: string, _init?: RequestInit) =>
    path === "/api/v1/session"
      ? pending.promise
      : Response.json({ approvedActiveHours: 12, serverTime: new Date(Date.now()).toISOString(), items: [] }),
  );
  vi.stubGlobal("fetch", fetcher);
  const { history, client } = mount();
  await screen.findByRole("heading", { name: "Pair this device" });
  expect(
    screen.getByText(
      "On a browser that is already signed in, open Devices, choose Pair a device, and type the code it shows here.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText("The app on your home screen pairs once more with a code, even after Safari has paired."),
  ).toBeTruthy();
  const input = screen.getByLabelText("Pairing code") as HTMLInputElement;
  const form = input.form;
  if (!form) throw new Error("Missing pairing form");
  const button = screen.getByRole("button", { name: "Pair" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.change(input, { target: { value: "abcd-efg" } });
  expect(input.value).toBe("ABCD-EFG");
  expect(button.disabled).toBe(true);
  fireEvent.submit(form);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "abcd-efgh" } });
  expect(button.disabled).toBe(false);
  client.setQueryData(["synthetic-cache-entry"], { value: "cached" });
  fireEvent.click(button);
  expect((await screen.findByText("Pairing…")).getAttribute("role")).toBe("status");
  expect(button.disabled).toBe(true);
  expect(input.disabled).toBe(true);
  fireEvent.click(button);
  fireEvent.submit(form);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/session",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "ABCD-EFGH" }) }),
  );
  pending.resolve(new Response(null, { status: 204 }));
  await waitFor(() => expect(history.location.pathname).toBe("/"));
  expect(client.getQueryData(["synthetic-cache-entry"])).toBeUndefined();
});

test.each([
  [429, "Too many wrong codes. Wait 10 minutes, then try again."],
  [401, "That code did not work. Check it on the hub and try again."],
  [400, "That code did not work. Check it on the hub and try again."],
  [500, "Could not pair. Check your connection and try again."],
])("pairing status %s appears as the accessible field error and allows another attempt", async (status, message) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: { code: "failed", message: "Synthetic failure" } }, { status })),
  );
  mount();
  const input = (await screen.findByLabelText("Pairing code")) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "ABCD-EFGH" } });
  const button = screen.getByRole("button", { name: "Pair" }) as HTMLButtonElement;
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  const error = await screen.findByRole("alert");
  expect(error.textContent).toBe(message);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toBe(error.id);
  expect(input.parentElement?.contains(error)).toBe(true);
  expect(input.disabled).toBe(false);
  expect(button.disabled).toBe(false);
  await waitFor(() => expect(document.activeElement).toBe(input));
  fireEvent.change(input, { target: { value: "ABCD-EFG" } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(input.getAttribute("aria-invalid")).toBeNull();
  expect(input.getAttribute("aria-describedby")).toBeNull();
  expect(document.activeElement).toBe(input);
  expect(button.disabled).toBe(true);
});
