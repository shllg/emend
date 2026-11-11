import type { HoursSetting, SettingsView } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
function setup(setting: Partial<HoursSetting> = {}, path = "/settings", patchResponse?: Promise<Response>) {
  let view: SettingsView = { approvedActiveHours: { ...defaultSetting, ...setting } };
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/v1/settings") {
      if (init?.method === "PATCH") {
        if (patchResponse) return patchResponse;
        const override = JSON.parse(String(init.body)).approvedActiveHours as number | null;
        const old = view.approvedActiveHours;
        view = {
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
    delayed.resolve(Response.json({ approvedActiveHours: defaultSetting }));
    await refresh;
  });
  expect(input.value).toBe("0");
  expect(f.client.getQueryData<SettingsView>(["settings"])?.approvedActiveHours).toMatchObject({
    value: 0,
    source: "override",
  });
});
