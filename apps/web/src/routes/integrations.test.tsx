import { KeysSetting, type SettingsView, SHORTCUT_DEFAULTS } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../App.tsx";
import { integrations } from "../lib/integrations.ts";
import { setThemePick } from "../lib/theme.ts";

const clients: QueryClient[] = [];
const settings: SettingsView = {
  approvedActiveHours: { value: 12, default: 12, file: null, override: null, source: "default", fileError: false },
  approvedActiveLimit: { value: 5, default: 5, file: null, override: null, source: "default", fileError: false },
  keys: KeysSetting.parse({
    commands: Object.fromEntries(
      Object.entries(SHORTCUT_DEFAULTS).map(([command, key]) => [
        command,
        { value: key, default: key, source: "default", fileError: false, clashWith: null },
      ]),
    ),
    fileError: false,
  }),
  serverTime: "2026-11-04T10:00:00.000Z",
};

beforeEach(() => {
  vi.stubGlobal("localStorage", new Storage());
  setThemePick("system");
});

afterEach(() => {
  cleanup();
  setThemePick("system");
  delete document.documentElement.dataset.theme;
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(path = "/settings/integrations") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === "/api/v1/settings") return Response.json(settings);
      if (path === "/api/v1/themes") return Response.json({ themes: [], folderError: false });
      if (path === "/api/v1/bin" || path.startsWith("/api/v1/bin?"))
        return Response.json({ items: [], total: 0, more: false, version: "a".repeat(64) });
      if (path === "/api/v1/reviews")
        return Response.json({
          items: [],
          approvedActiveHours: 12,
          approvedActiveLimit: 5,
          serverTime: settings.serverTime,
        });
      throw new Error(`Unexpected request: ${path}`);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const history = createMemoryHistory({ initialEntries: [path] });
  render(
    <StrictMode>
      <App queryClient={client} history={history} />
    </StrictMode>,
  );
  return history;
}

test("Integrations shows the status line's details and copies its exact prompt", async () => {
  const integration = integrations[0];
  if (!integration) throw new Error("Missing status line integration");
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
  setup();
  expect(await screen.findByRole("heading", { name: "Integrations", level: 1 })).toBeTruthy();
  const statusLine = within(screen.getByRole("region", { name: "Status line" }));
  expect(statusLine.getByText(integration.summary)).toBeTruthy();
  expect(statusLine.getByText("Works with Claude Code.")).toBeTruthy();
  expect(statusLine.getByText(/Add emend to my Claude Code status line\./).textContent).toBe(integration.prompt);
  fireEvent.click(statusLine.getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(integration.prompt);
  expect(await statusLine.findByRole("button", { name: "Copied" })).toBeTruthy();
  expect(statusLine.getByRole("status").textContent).toBe("Text copied");
});

test("Settings links to Integrations", async () => {
  const history = setup("/settings");
  const section = within(await screen.findByRole("region", { name: "Integrations" }));
  const link = section.getByRole("link", { name: "Open integrations" });
  expect(link.getAttribute("href")).toBe("/settings/integrations");
  fireEvent.click(link);
  expect(await screen.findByRole("heading", { name: "Integrations", level: 1 })).toBeTruthy();
  expect(history.location.pathname).toBe("/settings/integrations");
});

test("Integrations links back to Settings", async () => {
  const history = setup();
  await screen.findByRole("heading", { name: "Integrations", level: 1 });
  const link = within(screen.getByRole("main")).getByRole("link", { name: "Settings" });
  expect(link.getAttribute("href")).toBe("/settings");
  fireEvent.click(link);
  expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
  expect(history.location.pathname).toBe("/settings");
});
