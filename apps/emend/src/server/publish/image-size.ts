/**
 * Reads an image's displayed pixel size from its first bytes. Pure byte parsing for hostile input:
 * every read is bounds-checked, every loop is capped, and any doubt gives null.
 */

/** The first bytes of a blob that `imageSize` may read. */
export const IMAGE_HEAD_BYTES = 262144;
export const MAX_IMAGE_SIDE = 65535;
export type ImageSize = { width: number; height: number };

const MAX_STEPS = 4096;

const u16be = (b: Uint8Array, at: number) => {
  if (at < 0 || at + 2 > b.length) throw new RangeError("read");
  return ((b[at] as number) << 8) | (b[at + 1] as number);
};
const u16le = (b: Uint8Array, at: number) => {
  if (at < 0 || at + 2 > b.length) throw new RangeError("read");
  return (b[at] as number) | ((b[at + 1] as number) << 8);
};
const u24le = (b: Uint8Array, at: number) => u16le(b, at) | (byte(b, at + 2) << 16);
const u32be = (b: Uint8Array, at: number) => u16be(b, at) * 65536 + u16be(b, at + 2);
const byte = (b: Uint8Array, at: number) => {
  if (at < 0 || at >= b.length) throw new RangeError("read");
  return b[at] as number;
};
const ascii = (b: Uint8Array, at: number, text: string) => {
  if (at < 0 || at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};
const fourcc = (b: Uint8Array, at: number) => {
  if (at < 0 || at + 4 > b.length) throw new RangeError("read");
  return String.fromCharCode(b[at] as number, b[at + 1] as number, b[at + 2] as number, b[at + 3] as number);
};

const valid = (width: number, height: number): ImageSize | null =>
  Number.isInteger(width) &&
  Number.isInteger(height) &&
  width >= 1 &&
  height >= 1 &&
  width <= MAX_IMAGE_SIDE &&
  height <= MAX_IMAGE_SIDE
    ? { width, height }
    : null;

const oriented = (width: number, height: number, orientation: number) =>
  orientation >= 5 && orientation <= 8 ? valid(height, width) : valid(width, height);

/** TIFF orientation (1-8) from a TIFF block, or 1 when the block is malformed or has none. */
function tiffOrientation(b: Uint8Array, start: number, end: number): number {
  try {
    const t = b.subarray(start, end);
    const little = ascii(t, 0, "II");
    if (!little && !ascii(t, 0, "MM")) return 1;
    const u16 = little ? u16le : u16be;
    const u32 = (at: number) => (little ? u16le(t, at) + u16le(t, at + 2) * 65536 : u32be(t, at));
    if (u16(t, 2) !== 42) return 1;
    const ifd = u32(4);
    if (ifd < 8 || ifd + 2 > t.length) return 1;
    const count = u16(t, ifd);
    if (ifd + 2 + count * 12 > t.length) return 1;
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(t, entry) === 0x0112) {
        if (u16(t, entry + 2) !== 3 || u32(entry + 4) !== 1) return 1;
        const value = u16(t, entry + 8);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
  } catch {
    return 1;
  }
  return 1;
}

function png(b: Uint8Array): ImageSize | null {
  if (!ascii(b, 12, "IHDR") || u32be(b, 8) !== 13) return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  let at = 8;
  for (let i = 0; i < MAX_STEPS && at + 8 <= b.length; i++) {
    const length = u32be(b, at);
    const type = fourcc(b, at + 4);
    if (type === "IDAT") break;
    if (type === "eXIf") {
      const end = Math.min(at + 8 + length, b.length);
      if (tiffOrientation(b, at + 8, end) >= 5) return null;
    }
    at += 12 + length;
  }
  return valid(width, height);
}

function gif(b: Uint8Array): ImageSize | null {
  return valid(u16le(b, 6), u16le(b, 8));
}

function webp(b: Uint8Array): ImageSize | null {
  const kind = fourcc(b, 12);
  if (kind === "VP8 ") {
    if (byte(b, 23) !== 0x9d || byte(b, 24) !== 0x01 || byte(b, 25) !== 0x2a) return null;
    return valid(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (kind === "VP8L") {
    if (byte(b, 20) !== 0x2f) return null;
    const b1 = byte(b, 21);
    const b2 = byte(b, 22);
    const b3 = byte(b, 23);
    const b4 = byte(b, 24);
    return valid(1 + (((b2 & 0x3f) << 8) | b1), 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)));
  }
  if (kind === "VP8X") {
    if (byte(b, 20) & 0x08) return null;
    return valid(1 + u24le(b, 24), 1 + u24le(b, 27));
  }
  return null;
}

function jpeg(b: Uint8Array): ImageSize | null {
  let orientation = 1;
  let at = 2;
  for (let i = 0; i < MAX_STEPS; i++) {
    while (at < b.length && b[at] === 0xff && b[at + 1] === 0xff) at++;
    if (byte(b, at) !== 0xff) return null;
    const marker = byte(b, at + 1);
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16be(b, at + 5);
      const width = u16be(b, at + 7);
      return height === 0 ? null : oriented(width, height, orientation);
    }
    if (marker === 0xe1 && ascii(b, at + 4, "Exif\0\0"))
      orientation = tiffOrientation(b, at + 10, Math.min(at + 2 + length, b.length));
    at += 2 + length;
  }
  return null;
}

type Box = { type: string; start: number; body: number; end: number };

/** The boxes in [from, to), in order; stops quietly at the first malformed one. */
function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  for (let i = 0; i < MAX_STEPS && at + 8 <= to; i++) {
    let size = u32be(b, at);
    const type = fourcc(b, at + 4);
    let header = 8;
    if (size === 1) {
      const high = u32be(b, at + 8);
      if (high !== 0) break;
      size = u32be(b, at + 12);
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) break;
    out.push({ type, start: at, body: at + header, end: at + size });
    at += size;
  }
  return out;
}

function avif(b: Uint8Array): ImageSize | null {
  const top = boxes(b, 0, b.length);
  const ftyp = top.find((box) => box.type === "ftyp");
  if (!ftyp) return null;
  const brands = [fourcc(b, ftyp.body)];
  for (let at = ftyp.body + 8, i = 0; at + 4 <= ftyp.end && i < MAX_STEPS; at += 4, i++) brands.push(fourcc(b, at));
  if (!brands.some((brand) => brand === "avif" || brand === "avis")) return null;
  const meta = top.find((box) => box.type === "meta");
  if (!meta) return null;
  const children = boxes(b, meta.body + 4, meta.end);
  const pitm = children.find((box) => box.type === "pitm");
  if (!pitm) return null;
  const primary = byte(b, pitm.body) === 0 ? u16be(b, pitm.body + 4) : u32be(b, pitm.body + 4);
  const iprp = children.find((box) => box.type === "iprp");
  if (!iprp) return null;
  const inner = boxes(b, iprp.body, iprp.end);
  const ipco = inner.find((box) => box.type === "ipco");
  const ipma = inner.find((box) => box.type === "ipma");
  if (!ipco || !ipma) return null;
  const properties = boxes(b, ipco.body, ipco.end);
  const version = byte(b, ipma.body);
  const wide = (byte(b, ipma.body + 3) & 1) === 1;
  const entries = u32be(b, ipma.body + 4);
  let at = ipma.body + 8;
  let indexes: number[] | null = null;
  for (let i = 0; i < Math.min(entries, MAX_STEPS) && at < ipma.end; i++) {
    const id = version < 1 ? u16be(b, at) : u32be(b, at);
    at += version < 1 ? 2 : 4;
    const count = byte(b, at);
    at += 1;
    const found: number[] = [];
    for (let j = 0; j < count; j++) {
      if (wide) {
        found.push(u16be(b, at) & 0x7fff);
        at += 2;
      } else {
        found.push(byte(b, at) & 0x7f);
        at += 1;
      }
    }
    if (at > ipma.end) return null;
    if (id === primary) {
      indexes = found;
      break;
    }
  }
  if (!indexes) return null;
  let size: ImageSize | null = null;
  let swap = false;
  for (const index of indexes) {
    const property = properties[index - 1];
    if (!property) continue;
    if (property.type === "ispe") size = valid(u32be(b, property.body + 4), u32be(b, property.body + 8));
    else if (property.type === "irot") swap = (byte(b, property.body) & 3) % 2 === 1;
    else if (property.type === "clap") return null;
  }
  return size && swap ? valid(size.height, size.width) : size;
}

/** The size a browser shows for the image, or null when the format or the bytes are not understood. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  try {
    const b = bytes;
    if (ascii(b, 0, "\x89PNG\r\n\x1a\n")) return png(b);
    if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return gif(b);
    if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return webp(b);
    if (byte(b, 0) === 0xff && byte(b, 1) === 0xd8) return jpeg(b);
    if (ascii(b, 4, "ftyp")) return avif(b);
    return null;
  } catch {
    return null;
  }
}
