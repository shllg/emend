import { promisify } from "node:util";
import { crc32, deflateRaw } from "node:zlib";

const deflate = promisify(deflateRaw);
const uint32 = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 32) throw new Error("ZIP64 is not supported");
  return value;
};

/** A single-disk ZIP with no extras, descriptors or ZIP64 records. */
export async function zipFiles(entries: { name: string; data: Uint8Array }[], modified: Date): Promise<Uint8Array> {
  if (entries.length > 65535) throw new Error("Too many ZIP entries");
  const names = new Set<string>();
  for (const { name, data } of entries) {
    if (
      !name ||
      /[^\x20-\x7e]|\\/.test(name) ||
      name.startsWith("/") ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Invalid ZIP entry name");
    if (name.length > 65535) throw new Error("ZIP entry name too long");
    if (names.has(name)) throw new Error("Duplicate ZIP entry name");
    names.add(name);
    uint32(data.byteLength);
  }
  if (!Number.isFinite(modified.getTime())) throw new Error("Invalid ZIP date");
  const date = new Date(
    Math.max(Date.UTC(1980, 0, 1), Math.min(Date.UTC(2107, 11, 31, 23, 59, 58), modified.getTime())),
  );
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let centralSize = 0;
  for (const { name, data } of entries) {
    const compressed = await deflate(data);
    const method = compressed.byteLength < data.byteLength ? 8 : 0;
    const payload = method === 8 ? compressed : data;
    const size = uint32(payload.byteLength);
    const crc = crc32(data);
    const filename = Buffer.from(name, "ascii");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(data.byteLength, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    // The local header's version, flags, method, date, CRC, sizes and name length.
    header.copy(directory, 6, 4, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, payload);
    central.push(directory, filename);
    offset = uint32(offset + header.length + filename.length + size);
    centralSize = uint32(centralSize + directory.length + filename.length);
    uint32(offset + centralSize + 22);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end], offset + centralSize + end.length);
}
