import type { BinView, HoursSetting, SettingsView } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";

const clients: QueryClient[] = [];
const defaultSetting: HoursSetting = {
  value: 12,
  source: "default",
  default: 12,
  file: null,
  override: null,
  fileError: false,
};
function setup(
  setting: Partial<HoursSetting> = {},
  path = "/settings",
  patchResponse?: Promise<Response>,
  binned: BinView = { items: [], total: 0 },
) {
  let bin = binned;
  let view: SettingsView = {
    approvedActiveHours: { ...defaultSetting, ...setting },
    serverTime: "2026-11-04T10:00:00.000Z",
  };
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/v1/bin") {
      if (init?.method === "DELETE") {
        bin = { items: [], total: 0 };
        return new Response(null, { status: 204 });
      }
      return Response.json(bin);
    }
    if (path.startsWith("/api/v1/reviews/") && (init?.method === "DELETE" || path.endsWith("/restore"))) {
      const reviewId = path.split("/")[4];
      bin = { items: bin.items.filter((item) => item.id !== reviewId), total: bin.total - 1 };
      return new Response(null, { status: 204 });
    }
    if (path === "/api/v1/settings") {
      if (init?.method === "PATCH") {
        if (patchResponse) return patchResponse;
        const override = JSON.parse(String(init.body)).approvedActiveHours as number | null;
        const old = view.approvedActiveHours;
        view = {
          serverTime: view.serverTime,
          approvedActiveHours: {
            ...old,
            override,
            value: override ?? old.file ?? old.default,
            source: override !== null ? "override" : old.file !== null ? "file" : "default",
          },
        };
      }
      return Response.json(view);
    }
    return Response.json({ items: [], approvedActiveHours: 12, serverTime: "2026-11-04T10:00:00.000Z" });
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <StrictMode>
      <App queryClient={client} history={createMemoryHistory({ initialEntries: [path] })} />
    </StrictMode>,
  );
  return {
    client,
    invalidate,
    fetcher,
    patches: () => fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH"),
  };
}
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const field = () => screen.findByRole<HTMLInputElement>("spinbutton", { name: "Keep approved reviews in Active for" });
const save = () => screen.getByRole<HTMLButtonElement>("button", { name: "Save" });

test.each([
  { source: "default", value: 12, input: "", note: "Default." },
  { source: "file", value: 24, input: "24", note: "From the config file.", file: 24 },
  { source: "override", value: 2, input: "2", note: "Set here.", override: 2, file: 24 },
] as const)("renders $source state and disables unchanged Save", async (state) => {
  setup(state);
  const input = await field();
  expect(input.value).toBe(state.input);
  expect(input.placeholder).toBe("12 hours");
  expect(input.min).toBe("0");
  expect(input.max).toBe("720");
  expect(input.step).toBe("1");
  expect(input.inputMode).toBe("numeric");
  expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
  expect(screen.getByText(state.note)).toBeTruthy();
  expect(save().disabled).toBe(true);
  expect(!!screen.queryByRole("button", { name: "Reset" })).toBe(state.source === "override");
  if (state.source === "override") expect(screen.getByText("The config file says 24 hours.")).toBeTruthy();
});
test("shows the file error and singular hour", async () => {
  setup({ source: "override", value: 1, override: 1, file: 1, fileError: true });
  await field();
  expect(screen.getByText("The config file says 1 hour.")).toBeTruthy();
  expect(screen.getByText("hour")).toBeTruthy();
  expect(screen.getByText("The config file's value can't be used, so it is ignored.")).toBeTruthy();
});
test.each([false, true])("Save sends a number and refreshes settings and review caches (submit=%s)", async (submit) => {
  const f = setup();
  const input = await field();
  fireEvent.change(input, { target: { value: "24" } });
  if (submit) fireEvent.submit(input.closest("form") as HTMLFormElement);
  else fireEvent.click(save());
  await screen.findByText("Set here.");
  expect(f.patches()).toHaveLength(1);
  expect(JSON.parse(String(f.patches()[0]?.[1]?.body))).toEqual({ approvedActiveHours: 24 });
  expect(f.client.getQueryData<SettingsView>(["settings"])?.approvedActiveHours.value).toBe(24);
  expect(f.invalidate).toHaveBeenCalledWith({ queryKey: ["inbox"] });
  expect(f.invalidate).toHaveBeenCalledWith({ queryKey: ["review"] });
  expect(save().disabled).toBe(true);
});
test.each(["Save", "Reset"])("%s can clear an override and fall back to the file", async (button) => {
  const f = setup({ source: "override", value: 2, override: 2, file: 24 });
  const input = await field();
  if (button === "Save") fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: button }));
  await screen.findByText("From the config file.");
  expect(input.value).toBe("24");
  expect(JSON.parse(String(f.patches()[0]?.[1]?.body))).toEqual({ approvedActiveHours: null });
});
test("the file value can be pinned as an override", async () => {
  const f = setup({ source: "file", value: 24, file: 24 });
  const input = await field();
  expect(save().disabled).toBe(true);
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.change(input, { target: { value: "24" } });
  expect(save().disabled).toBe(false);
  fireEvent.click(save());
  await screen.findByText("Set here.");
  expect(f.patches()).toHaveLength(1);
  expect(String(f.patches()[0]?.[1]?.body)).toBe('{"approvedActiveHours":24}');
});
test("clearing a file value leaves Save disabled", async () => {
  setup({ source: "file", value: 24, file: 24 });
  fireEvent.change(await field(), { target: { value: "" } });
  expect(save().disabled).toBe(true);
});
test("Reset without a file falls back to an empty default input", async () => {
  setup({ source: "override", value: 2, override: 2 });
  const input = await field();
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  await screen.findByText("Default.");
  expect(input.value).toBe("");
});
test.each(["-1", "721", "1.5", "1e2"])("invalid input %s reports whole hours without sending", async (value) => {
  const f = setup();
  const input = await field();
  fireEvent.change(input, { target: { value } });
  fireEvent.click(save());
  expect(await screen.findByText("Enter whole hours from 0 to 720.")).toBeTruthy();
  expect(f.patches()).toHaveLength(0);
});
test("Save stays disabled while pending and failures remain visible", async () => {
  const pending = Promise.withResolvers<Response>();
  const f = setup({}, "/settings", pending.promise);
  fireEvent.change(await field(), { target: { value: "2" } });
  fireEvent.click(save());
  await waitFor(() => expect(save().disabled).toBe(true));
  expect(f.patches()).toHaveLength(1);
  await act(async () =>
    pending.resolve(Response.json({ error: { code: "internal", message: "Failed" } }, { status: 500 })),
  );
  await screen.findByText("Could not save settings. Try again.");
  expect(save().disabled).toBe(false);
});
test("inbox header links to Settings", async () => {
  setup({}, "/");
  const link = await screen.findByRole("link", { name: "Settings" });
  expect(link.getAttribute("href")).toBe("/settings");
  fireEvent.click(link);
  await screen.findByRole("heading", { name: "Settings", level: 1 });
  await field();
});

test("a delayed background GET cannot overwrite the saved settings view", async () => {
  const f = setup();
  const input = await field();
  const delayed = Promise.withResolvers<Response>();
  f.fetcher.mockImplementationOnce(async () => delayed.promise);
  let refresh: Promise<void> | undefined;
  act(() => {
    refresh = f.client.invalidateQueries({ queryKey: ["settings"] });
  });
  await waitFor(() => expect(f.client.isFetching({ queryKey: ["settings"] })).toBe(1));
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.click(save());
  await screen.findByText("Set here.");
  await act(async () => {
    delayed.resolve(Response.json({ approvedActiveHours: defaultSetting, serverTime: "2026-11-04T10:00:00.000Z" }));
    await refresh;
  });
  expect(input.value).toBe("0");
  expect(f.client.getQueryData<SettingsView>(["settings"])?.approvedActiveHours).toMatchObject({
    value: 0,
    source: "override",
  });
});

const binId = "33333333-3333-4333-8333-333333333333";
const binItem = {
  id: binId,
  title: "Binned review",
  machine: "Workshop",
  binnedAt: "2026-11-04T09:00:00.000Z",
};
const calls = (f: ReturnType<typeof setup>, method: string, path: string) =>
  f.fetcher.mock.calls.filter(([called, init]) => called === path && init?.method === method);

test("the bin lists title, machine and deleted time, and Empty bin is disabled when empty", async () => {
  setup();
  await screen.findByText("The bin is empty.");
  expect(screen.getByRole("heading", { name: "Bin" })).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Empty bin" }).disabled).toBe(true);
});
test("the bin shows each item and says when it is cut short", async () => {
  setup({}, "/settings", undefined, { items: [binItem], total: 3 });
  await screen.findByText("Binned review");
  expect(screen.getByText(/Workshop · Deleted /)).toBeTruthy();
  expect(screen.getByText("Showing the newest 1 of 3.")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Empty bin" }).disabled).toBe(false);
});
test("Restore needs no confirm, calls restore and toasts", async () => {
  const f = setup({}, "/settings", undefined, { items: [binItem], total: 1 });
  fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
  await screen.findByText("Restored “Binned review”");
  expect(calls(f, "POST", `/api/v1/reviews/${binId}/restore`)).toHaveLength(1);
  await screen.findByText("The bin is empty.");
  expect(f.invalidate).toHaveBeenCalledWith({ queryKey: ["inbox"] });
  expect(f.invalidate).toHaveBeenCalledWith({ queryKey: ["bin"] });
});
test("Delete for good asks first, and Cancel calls nothing", async () => {
  const f = setup({}, "/settings", undefined, { items: [binItem], total: 1 });
  fireEvent.click(await screen.findByRole("button", { name: "Delete for good" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Delete “Binned review” for good?" });
  expect(
    within(dialog).getByText("This removes the review, its revisions, comments and Sends. This cannot be undone."),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(f.fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
});
test("Delete for good calls DELETE on the review and toasts", async () => {
  const f = setup({}, "/settings", undefined, { items: [binItem], total: 1 });
  fireEvent.click(await screen.findByRole("button", { name: "Delete for good" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete for good" }));
  await screen.findByText("Deleted “Binned review”");
  expect(calls(f, "DELETE", `/api/v1/reviews/${binId}`)).toHaveLength(1);
  await screen.findByText("The bin is empty.");
});
test("Empty bin asks with the count, and Cancel calls nothing", async () => {
  const f = setup({}, "/settings", undefined, { items: [binItem], total: 1 });
  await screen.findByText("Binned review");
  fireEvent.click(screen.getByRole("button", { name: "Empty bin" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Empty the bin?" });
  expect(
    within(dialog).getByText(
      "This deletes the 1 review in the bin for good, with their revisions, comments and Sends. This cannot be undone.",
    ),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(calls(f, "DELETE", "/api/v1/bin")).toHaveLength(0);
});
test("Empty bin calls DELETE on the bin and toasts", async () => {
  const f = setup({}, "/settings", undefined, { items: [binItem], total: 1 });
  await screen.findByText("Binned review");
  fireEvent.click(screen.getByRole("button", { name: "Empty bin" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Empty bin" }));
  await screen.findByText("Emptied the bin");
  expect(calls(f, "DELETE", "/api/v1/bin")).toHaveLength(1);
});
