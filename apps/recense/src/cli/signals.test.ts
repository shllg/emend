import { expect, test, vi } from "vitest";
import { run } from "../main.ts";

vi.mock("../main.ts", () => ({ run: vi.fn() }));

test.each([129, 130, 143])("the executable exits with %s even if stdout is still blocked", async (code) => {
  const previous = process.exitCode;
  vi.resetModules();
  vi.mocked(run).mockResolvedValue(code);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("synthetic exit");
  });
  try {
    await expect(import("../cli.ts")).rejects.toThrow("synthetic exit");
    expect(exit).toHaveBeenCalledWith(code);
  } finally {
    process.exitCode = previous;
    exit.mockRestore();
  }
});
