import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { run } from "../../main.ts";
import { writeSecretFile } from "../../state/files.ts";
import { commandFixture } from "../test-support.ts";

const id = "11111111-1111-4111-8111-111111111111";
const device = {
  id,
  kind: "browser",
  name: "Synthetic browser",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: null,
  current: false,
};
async function fixture() {
  const f = await commandFixture();
  f.io.isTTY = true;
  await rm(join(f.dir, "agent.token"));
  const admin = `em_${"b".repeat(43)}`;
  writeSecretFile(join(f.dir, "admin.token"), admin);
  return { ...f, admin };
}
test.each(
  [false, undefined].flatMap((isTTY) => [
    { isTTY, args: ["pair"] },
    { isTTY, args: ["pair", "--machine"] },
  ]),
)("$args without a terminal ($isTTY) creates no pairing", async ({ isTTY, args }) => {
  const f = await fixture();
  expect(await run(args, { ...f.io, isTTY })).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["emend: emend pair prints one-time codes only in a terminal.\n"]);
  expect(f.fetcher).not.toHaveBeenCalled();
});
test.each(["pair", "devices"])("%s without a running server prints one line and starts nothing", async (command) => {
  const f = await fixture();
  await rm(join(f.dir, "server.json"));
  expect(await run([command], f.io)).toBe(1);
  expect(f.stderr).toEqual(["emend: emend is not running. Start it with `emend` or `emend serve --tailscale`.\n"]);
  expect(f.stdout).toEqual([]);
  expect(f.fetcher).not.toHaveBeenCalled();
});
test.each(["http://127.0.0.1:3636", "https://hub.example.ts.net", "https://hub.example.ts.net:13636"])(
  "pair prints link, optional hint, code, QR and validity for %s",
  async (origin) => {
    const f = await fixture();
    const url = `${origin}/pair#emp_${"a".repeat(43)}`;
    f.setResponse(async (path, init) => {
      expect(String(path)).toBe("http://127.0.0.1:3636/api/v1/pairings");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${f.admin}`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ purpose: "device" });
      return Response.json({ url, code: "ABCD-EFGH", expiresAt: "2026-01-01T00:10:00.000Z" });
    });
    expect(await run(["pair"], f.io)).toBe(0);
    const output = f.stdout.join("");
    expect(output.startsWith(`${url}\n`)).toBe(true);
    expect(output.includes("This link works only on this machine. To pair a phone, run emend serve --tailscale.")).toBe(
      origin.startsWith("http:"),
    );
    expect(output.indexOf("ABCD-EFGH")).toBeGreaterThan(output.indexOf(url));
    expect(output.slice(output.indexOf("ABCD-EFGH") + 9)).toMatch(/[▀▄█]/);
    expect(output.endsWith("Valid for 10 minutes, once.\n")).toBe(true);
    expect(output.split(url)).toHaveLength(2);
    expect(f.stderr).toEqual([]);
  },
);
test("devices lists and revokes with admin only", async () => {
  const f = await fixture();
  f.setResponse(async (_path, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${f.admin}`);
    return init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ items: [device] });
  });
  expect(await run(["devices"], f.io)).toBe(0);
  expect(f.stdout.join("")).toBe(`Synthetic browser\tbrowser\t2026-01-01\tnever\t${id}\n`);
  f.stdout.length = 0;
  expect(await run(["devices", "--revoke", id], f.io)).toBe(0);
  expect(f.stdout).toEqual(["Revoked Synthetic browser.\n"]);
  expect(
    f.fetcher.mock.calls.some(([url, init]) => String(url).endsWith(`/devices/${id}`) && init?.method === "DELETE"),
  ).toBe(true);
});
test("unknown device exits one without deleting", async () => {
  const f = await fixture();
  f.setResponse(async () => Response.json({ items: [] }));
  expect(await run(["devices", "--revoke", id], f.io)).toBe(1);
  expect(f.stderr).toHaveLength(1);
  expect(f.stdout).toEqual([]);
  expect(f.fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
});

test("devices formats creation and activity dates in UTC", async () => {
  const f = await fixture();
  f.setResponse(async () =>
    Response.json({
      items: [{ ...device, createdAt: "2026-01-01T23:59:59.000Z", lastSeenAt: "2026-01-02T00:00:01.000Z" }],
    }),
  );
  expect(await run(["devices"], f.io)).toBe(0);
  expect(f.stdout).toEqual([`Synthetic browser\tbrowser\t2026-01-01\t2026-01-02\t${id}\n`]);
});
