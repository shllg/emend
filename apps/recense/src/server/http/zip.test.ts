import { crc32, deflateRaw, inflateRawSync } from "node:zlib";
import { expect, test, vi } from "vitest";
import { ZipWriter, zipFiles } from "./zip.ts";

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return { ...actual, deflateRaw: vi.fn(actual.deflateRaw) };
});

const modified = new Date("2026-11-13T12:34:57Z");
function readZip(bytes: Uint8Array) {
  const zip = Buffer.from(bytes);
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  expect(zip.readUInt32LE(end + 4)).toBe(0);
  expect(zip.readUInt16LE(end + 20)).toBe(0);
  const count = zip.readUInt16LE(end + 10);
  expect(zip.readUInt16LE(end + 8)).toBe(count);
  const start = zip.readUInt32LE(end + 16);
  expect(start + zip.readUInt32LE(end + 12)).toBe(end);
  const entries = [];
  let offset = start;
  let localEnd = 0;
  for (let index = 0; index < count; index++) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    expect(zip.readUInt16LE(offset + 4)).toBe(20);
    expect(zip.readUInt16LE(offset + 6)).toBe(20);
    expect(zip.readUInt16LE(offset + 8)).toBe(0);
    for (const field of [30, 32, 34, 36]) expect(zip.readUInt16LE(offset + field)).toBe(0);
    expect(zip.readUInt32LE(offset + 38)).toBe(0);
    const method = zip.readUInt16LE(offset + 10);
    expect([0, 8]).toContain(method);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameSize = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 46, offset + 46 + nameSize);
    const local = zip.readUInt32LE(offset + 42);
    expect(local).toBe(localEnd);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    expect(zip.subarray(local + 4, local + 28)).toEqual(zip.subarray(offset + 6, offset + 30));
    expect(zip.readUInt16LE(local + 28)).toBe(0);
    expect(zip.subarray(local + 30, local + 30 + nameSize)).toEqual(name);
    const payload = zip.subarray(local + 30 + nameSize, local + 30 + nameSize + compressedSize);
    const data = method === 8 ? inflateRawSync(payload) : payload;
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(zip.readUInt32LE(offset + 16));
    entries.push({
      name: name.toString("ascii"),
      data,
      method,
      time: zip.readUInt16LE(offset + 12),
      date: zip.readUInt16LE(offset + 14),
    });
    localEnd = local + 30 + nameSize + compressedSize;
    offset += 46 + nameSize;
  }
  expect(localEnd).toBe(start);
  expect(offset).toBe(end);
  return entries;
}

test("ZIP local and central records round-trip deflated, stored and empty files in order", async () => {
  const input = [
    { name: "base.html", data: Buffer.from("repeated content ".repeat(200)) },
    { name: "docs/raw.html", data: Uint8Array.of(1, 2, 3, 4) },
    { name: "docs/empty.html", data: new Uint8Array() },
  ];
  const writer = new ZipWriter(modified);
  for (const { name, data } of input) await writer.add(name, data);
  const entries = readZip(writer.finish());
  expect(entries.map(({ name, data }) => ({ name, data }))).toEqual(
    input.map(({ name, data }) => ({ name, data: Buffer.from(data) })),
  );
  expect(entries.map(({ method }) => method)).toEqual([8, 0, 0]);
  for (const entry of entries) {
    expect(entry.time).toBe((12 << 11) | (34 << 5) | 28);
    expect(entry.date).toBe((46 << 9) | (11 << 5) | 13);
  }
  expect(readZip(await zipFiles([], modified))).toEqual([]);
});

test.each(["", "é.html", "a\u007f", "a\u0000", "a\n", "a\\b", "/a", "a//b", "a/", ".", "..", "a/./b", "a/../b"])(
  "refuses unsafe entry name %j",
  async (name) => {
    await expect(zipFiles([{ name, data: new Uint8Array() }], modified)).rejects.toThrow("Invalid ZIP entry name");
  },
);

test("refuses duplicate names, long names, excess entries and ZIP64 sizes", async () => {
  const entry = { name: "a.html", data: new Uint8Array() };
  await expect(zipFiles([entry, entry], modified)).rejects.toThrow("Duplicate");
  await expect(zipFiles([{ ...entry, name: "a".repeat(65536) }], modified)).rejects.toThrow("name too long");
  await expect(
    zipFiles(
      Array.from({ length: 65536 }, () => entry),
      modified,
    ),
  ).rejects.toThrow("Too many");
  // A synthetic length checks the boundary before any CRC, allocation or compression.
  const data = new Uint8Array();
  Object.defineProperty(data, "byteLength", { value: 2 ** 32 });
  await expect(zipFiles([{ ...entry, data }], modified)).rejects.toThrow("ZIP64");
});

test.each([
  ["1970-01-01T00:00:00Z", 33, 0],
  ["2200-01-01T00:00:00Z", 65439, 49021],
] as const)("clamps %s to the DOS date range", async (date, expectedDate, time) => {
  const [entry] = readZip(await zipFiles([{ name: "a", data: new Uint8Array() }], new Date(date)));
  expect(entry?.date).toBe(expectedDate);
  expect(entry?.time).toBe(time);
});

test.each([2 ** 32 - 31, 2 ** 32 - 100])(
  "refuses ZIP64 offsets and archive sizes before allocation: %i",
  async (length) => {
    const data = new Uint8Array();
    Object.defineProperty(data, "byteLength", { value: length });
    // Simulate incompressible large input without allocating four GiB.
    vi.mocked(deflateRaw).mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback !== "function") throw new Error("Missing compression callback");
      callback(null, data);
    });
    await expect(zipFiles([{ name: "a", data }], modified)).rejects.toThrow("ZIP64");
  },
);

test("refuses invalid dates", async () => {
  await expect(zipFiles([], new Date(Number.NaN))).rejects.toThrow("Invalid ZIP date");
});

test("incremental additions own stored and deflated bytes after add returns", async () => {
  const writer = new ZipWriter(modified);
  const raw = Uint8Array.of(1, 2, 3);
  const compressible = Buffer.from("repeat ".repeat(100));
  await writer.add("raw", raw);
  raw.fill(0);
  await writer.add("compressed", compressible);
  compressible.fill(0);
  const entries = readZip(writer.finish());
  expect(entries[0]?.data).toEqual(Buffer.from([1, 2, 3]));
  expect(entries[1]?.data.toString()).toBe("repeat ".repeat(100));
  await expect(writer.add("late", raw)).rejects.toThrow("not ready");
  expect(() => writer.finish()).toThrow("not ready");
});

test("the writer refuses concurrent additions and finishing before compression settles", async () => {
  const writer = new ZipWriter(modified);
  const adding = writer.add("first", Uint8Array.of(1));
  await expect(writer.add("second", Uint8Array.of(2))).rejects.toThrow("not ready");
  expect(() => writer.finish()).toThrow("not ready");
  await adding;
  await writer.add("second", Uint8Array.of(2));
  expect(readZip(writer.finish()).map((entry) => entry.name)).toEqual(["first", "second"]);
});
