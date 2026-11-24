import { expect, test } from "vitest";
import { mediaType } from "./media.ts";

test("media types come from an own-property extension map", () => {
  expect(mediaType("page.HTML")).toBe("text/html");
  expect(mediaType("asset.svg")).toBe("image/svg+xml");
  for (const extension of ["__proto__", "constructor", "toString", "unknown"])
    expect(mediaType(`file.${extension}`)).toBe("text/plain");
});
