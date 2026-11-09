import { InboxList } from "@emend/contract";
import { afterEach, expect, test, vi } from "vitest";
import { get } from "./client.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("read requests keep credentials same-origin, parse errors, and send 401 to pairing", async () => {
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ error: { code: "unauthorized", message: "Pair this device." } }, { status: 401 }),
    );
  vi.stubGlobal("fetch", fetch);
  await expect(get("/api/v1/reviews", InboxList)).rejects.toMatchObject({
    status: 401,
    code: "unauthorized",
    message: "Pair this device.",
  });
  expect(assign).toHaveBeenCalledWith("/pair");
  expect(fetch).toHaveBeenCalledWith("/api/v1/reviews", expect.objectContaining({ credentials: "same-origin" }));
});
test("a successful response still has to satisfy its schema", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(Response.json({ serverTime: new Date(Date.now()).toISOString(), items: [{ id: "invalid" }] })),
  );
  await expect(get("/api/v1/reviews", InboxList)).rejects.toThrow();
});
