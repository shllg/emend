import { promisify } from "node:util";
import { crc32, deflateRaw } from "node:zlib";

const deflate = promisify(deflateRaw);
const uint32 = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 32) throw new Error("ZIP64 is not supported");
  return value;
};

/** A single-disk ZIP with no extras, descriptors or ZIP64 records. Add entries sequentially. */
export class ZipWriter {
  private readonly names = new Set<string>();
  private readonly local: Uint8Array[] = [];
  private readonly central: Uint8Array[] = [];
  private readonly dosTime: number;
  private readonly dosDate: number;
  private offset = 0;
  private centralSize = 0;
  private adding = false;
  private finished = false;

  constructor(modified: Date) {
    if (!Number.isFinite(modified.getTime())) throw new Error("Invalid ZIP date");
    const date = new Date(
      Math.max(Date.UTC(1980, 0, 1), Math.min(Date.UTC(2107, 11, 31, 23, 59, 58), modified.getTime())),
    );
    this.dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
    this.dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  }

  async add(name: string, data: Uint8Array): Promise<void> {
    if (this.finished || this.adding) throw new Error("ZIP writer is not ready");
    if (this.names.size >= 65535) throw new Error("Too many ZIP entries");
    if (
      !name ||
      /[^\x20-\x7e]|\\/.test(name) ||
      name.startsWith("/") ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Invalid ZIP entry name");
    if (name.length > 65535) throw new Error("ZIP entry name too long");
    if (this.names.has(name)) throw new Error("Duplicate ZIP entry name");
    const originalSize = uint32(data.byteLength);
    this.adding = true;
    try {
      const compressed = await deflate(data);
      const method = compressed.byteLength < originalSize ? 8 : 0;
      const size = uint32(method === 8 ? compressed.byteLength : originalSize);
      const nextOffset = uint32(this.offset + 30 + name.length + size);
      const nextCentralSize = uint32(this.centralSize + 46 + name.length);
      uint32(nextOffset + nextCentralSize + 22);
      // Own stored bytes too, so the caller may release or reuse its input after add.
      const payload = method === 8 ? compressed : Buffer.from(data);
      const crc = crc32(data);
      const filename = Buffer.from(name, "ascii");
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(method, 8);
      header.writeUInt16LE(this.dosTime, 10);
      header.writeUInt16LE(this.dosDate, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(size, 18);
      header.writeUInt32LE(originalSize, 22);
      header.writeUInt16LE(filename.length, 26);
      const directory = Buffer.alloc(46);
      directory.writeUInt32LE(0x02014b50, 0);
      directory.writeUInt16LE(20, 4);
      // The local header's version, flags, method, date, CRC, sizes and name length.
      header.copy(directory, 6, 4, 28);
      directory.writeUInt32LE(this.offset, 42);
      this.local.push(header, filename, payload);
      this.central.push(directory, filename);
      this.names.add(name);
      this.offset = nextOffset;
      this.centralSize = nextCentralSize;
    } finally {
      this.adding = false;
    }
  }

  finish(): Buffer<ArrayBuffer> {
    if (this.finished || this.adding) throw new Error("ZIP writer is not ready");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.names.size, 8);
    end.writeUInt16LE(this.names.size, 10);
    end.writeUInt32LE(this.centralSize, 12);
    end.writeUInt32LE(this.offset, 16);
    const result = Buffer.concat([...this.local, ...this.central, end], this.offset + this.centralSize + end.length);
    this.finished = true;
    this.local.length = 0;
    this.central.length = 0;
    return result;
  }
}

export async function zipFiles(
  entries: { name: string; data: Uint8Array }[],
  modified: Date,
): Promise<Buffer<ArrayBuffer>> {
  if (entries.length > 65535) throw new Error("Too many ZIP entries");
  const writer = new ZipWriter(modified);
  for (const { name, data } of entries) await writer.add(name, data);
  return writer.finish();
}
