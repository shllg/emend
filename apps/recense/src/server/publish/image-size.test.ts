import { describe, expect, it } from "vitest";
import { imageSize } from "./image-size.ts";

const bytes = (...parts: (number | number[] | string | Uint8Array)[]) => {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "number") out.push(part);
    else if (typeof part === "string") for (const char of part) out.push(char.charCodeAt(0));
    else out.push(...part);
  }
  return Uint8Array.from(out);
};
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const le32 = (n: number) => be32(n).reverse();

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const chunk = (type: string, data: number[]) => [...be32(data.length), ...bytes(type), ...data, 0, 0, 0, 0];
const ihdr = (w: number, h: number) => chunk("IHDR", [...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
const png = (w: number, h: number, ...more: number[][]) => bytes(PNG_SIG, ihdr(w, h), ...more);

/** A TIFF block with one orientation entry. */
const tiff = (orientation: number, little = false) => {
  const u16 = little ? le16 : be16;
  const u32 = little ? le32 : be32;
  return [
    ...bytes(little ? "II" : "MM"),
    ...u16(42),
    ...u32(8),
    ...u16(1),
    ...u16(0x0112),
    ...u16(3),
    ...u32(1),
    ...u16(orientation),
    0,
    0,
    ...u32(0),
  ];
};
const app1 = (tiffBlock: number[]) => {
  const data = [...bytes("Exif\0\0"), ...tiffBlock];
  return [0xff, 0xe1, ...be16(data.length + 2), ...data];
};
const sof = (w: number, h: number) => [
  0xff,
  0xc0,
  ...be16(17),
  8,
  ...be16(h),
  ...be16(w),
  3,
  1,
  0x22,
  0,
  2,
  0x11,
  1,
  3,
  0x11,
  1,
];
const jpeg = (w: number, h: number, ...before: number[][]) => bytes([0xff, 0xd8], ...before, sof(w, h), [0xff, 0xd9]);

describe("imageSize", () => {
  it("reads PNG, with and without orientation data", () => {
    expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(png(3, 2, chunk("eXIf", tiff(6))))).toBeNull();
    expect(imageSize(png(3, 2, chunk("eXIf", tiff(1))))).toEqual({ width: 3, height: 2 });
    expect(imageSize(png(3, 2, chunk("IDAT", [0]), chunk("eXIf", tiff(6))))).toEqual({ width: 3, height: 2 });
  });

  it("reads GIF", () => {
    expect(imageSize(bytes("GIF89a", le16(30), le16(20), [0, 0, 0]))).toEqual({ width: 30, height: 20 });
    expect(imageSize(bytes("GIF87a", le16(1), le16(1)))).toEqual({ width: 1, height: 1 });
  });

  it("reads WebP lossy, lossless and extended", () => {
    const riff = (kind: string, body: number[]) =>
      bytes("RIFF", le32(body.length + 12), "WEBP", kind, le32(body.length), body);
    expect(imageSize(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(50), ...le16(40)]))).toEqual({
      width: 50,
      height: 40,
    });
    const w = 100 - 1;
    const h = 60 - 1;
    const packed = [0x2f, w & 255, ((w >> 8) & 0x3f) | ((h & 3) << 6), (h >> 2) & 255, (h >> 10) & 15];
    expect(imageSize(riff("VP8L", packed))).toEqual({ width: 100, height: 60 });
    const vp8x = (flags: number) => riff("VP8X", [flags, 0, 0, 0, 199, 0, 0, 99, 0, 0]);
    expect(imageSize(vp8x(0))).toEqual({ width: 200, height: 100 });
    expect(imageSize(vp8x(0x08))).toBeNull();
  });

  it("reads JPEG and applies EXIF orientation", () => {
    expect(imageSize(jpeg(40, 30))).toEqual({ width: 40, height: 30 });
    for (const little of [false, true]) {
      expect(imageSize(jpeg(40, 30, app1(tiff(1, little))))).toEqual({ width: 40, height: 30 });
      expect(imageSize(jpeg(40, 30, app1(tiff(3, little))))).toEqual({ width: 40, height: 30 });
      expect(imageSize(jpeg(40, 30, app1(tiff(6, little))))).toEqual({ width: 30, height: 40 });
      expect(imageSize(jpeg(40, 30, app1(tiff(8, little))))).toEqual({ width: 30, height: 40 });
    }
  });

  it("skips other segments before the frame header", () => {
    const app0 = [0xff, 0xe0, ...be16(16), ...new Array(14).fill(0)];
    expect(imageSize(jpeg(8, 9, app0, [0xff, 0xff, 0xff, 0xdb, ...be16(4), 0, 0]))).toEqual({ width: 8, height: 9 });
  });

  it("ignores a malformed EXIF block", () => {
    const entryCountTooBig = tiff(6);
    entryCountTooBig[8] = 0xff;
    entryCountTooBig[9] = 0xff;
    expect(imageSize(jpeg(40, 30, app1(entryCountTooBig)))).toEqual({ width: 40, height: 30 });
    const offsetTooBig = tiff(6);
    offsetTooBig.splice(4, 4, ...be32(0xfffffff0));
    expect(imageSize(jpeg(40, 30, app1(offsetTooBig)))).toEqual({ width: 40, height: 30 });
  });

  const box = (type: string, ...body: (number | number[] | string | Uint8Array)[]) => {
    const inner = bytes(...body);
    return bytes(be32(inner.length + 8), type, inner);
  };
  const full = (version: number, flags: number) => [version, 0, 0, flags];
  const avif = (opts: { irot?: number; clap?: boolean; ispeFor?: number; brand?: string; entries?: number } = {}) => {
    const props = [
      box("ispe", full(0, 0), be32(64), be32(48)),
      ...(opts.irot !== undefined ? [box("irot", opts.irot)] : []),
      ...(opts.clap ? [box("clap", new Array(32).fill(0))] : []),
    ];
    const indexes = props.map((_, i) => i + 1);
    const ipma = box("ipma", full(0, 0), be32(opts.entries ?? 1), be16(opts.ispeFor ?? 1), indexes.length, indexes);
    const meta = box(
      "meta",
      full(0, 0),
      box("pitm", full(0, 0), be16(1)),
      box("iprp", box("ipco", ...props.map((p) => [...p])), [...ipma]),
    );
    return bytes(box("ftyp", opts.brand ?? "avif", be32(0), "mif1"), meta);
  };

  it("reads AVIF", () => {
    expect(imageSize(avif())).toEqual({ width: 64, height: 48 });
    expect(imageSize(avif({ irot: 1 }))).toEqual({ width: 48, height: 64 });
    expect(imageSize(avif({ irot: 2 }))).toEqual({ width: 64, height: 48 });
    expect(imageSize(avif({ clap: true }))).toBeNull();
    expect(imageSize(avif({ ispeFor: 2 }))).toBeNull();
    expect(imageSize(avif({ brand: "heic" }))).toBeNull();
    expect(imageSize(avif({ entries: 0xffffffff }))).toEqual({ width: 64, height: 48 });
  });

  it("rejects hostile AVIF boxes", () => {
    const good = avif();
    for (const size of [
      [0, 0, 0, 0],
      [0, 0, 0, 1],
      [0, 0, 0, 4],
      [0xff, 0xff, 0xff, 0xff],
    ]) {
      const bad = good.slice();
      bad.set(size, 0);
      expect(() => imageSize(bad)).not.toThrow();
      expect(imageSize(bad)).toBeNull();
    }
    const ipmaAt = good.findIndex((_, i) => String.fromCharCode(...good.slice(i, i + 4)) === "ipma");
    const bad = good.slice();
    bad.set(be32(0xffffffff), ipmaAt + 8);
    expect(() => imageSize(bad)).not.toThrow();
  });

  it("rejects bad sizes", () => {
    expect(imageSize(png(0, 5))).toBeNull();
    expect(imageSize(png(70000, 5))).toBeNull();
    expect(imageSize(jpeg(10, 0))).toBeNull();
    expect(imageSize(bytes("GIF89a", le16(0), le16(5)))).toBeNull();
  });

  it("returns null for unknown formats", () => {
    expect(imageSize(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(imageSize(new Uint8Array())).toBeNull();
    expect(imageSize(bytes("hello world, not an image"))).toBeNull();
  });

  it("returns null for truncated headers in every format", () => {
    const samples = [
      png(5, 5),
      bytes("GIF89a", le16(5), le16(5)),
      jpeg(5, 5, app1(tiff(6))),
      avif(),
      bytes("RIFF", le32(30), "WEBPVP8X", le32(10), [0, 0, 0, 0, 1, 0, 0, 1, 0, 0]),
    ];
    for (const sample of samples)
      for (let n = 0; n < sample.length - 1; n++) {
        expect(() => imageSize(sample.slice(0, n))).not.toThrow();
        const size = imageSize(sample.slice(0, n));
        if (size) expect(size.width).toBeGreaterThan(0);
      }
    expect(imageSize(png(5, 5).slice(0, 20))).toBeNull();
    expect(imageSize(jpeg(5, 5).slice(0, 10))).toBeNull();
  });

  it("survives hostile JPEG segments", () => {
    const head = [0xff, 0xd8];
    expect(imageSize(bytes(head, [0xff, 0xe0, 0, 0], sof(5, 5)))).toBeNull();
    expect(imageSize(bytes(head, [0xff, 0xe0, 0, 1], sof(5, 5)))).toBeNull();
    expect(imageSize(bytes(head, [0xff, 0xe0, 0xff, 0xff, 1, 2, 3]))).toBeNull();
    expect(imageSize(bytes(head, [0xff, 0xda, 0, 2], sof(5, 5)))).toBeNull();
    expect(imageSize(bytes(head, [0xff, 0xd9], sof(5, 5)))).toBeNull();
  });

  it("neither throws nor hangs on filler and random bytes", () => {
    expect(imageSize(new Uint8Array(100000).fill(0xff))).toBeNull();
    expect(imageSize(bytes([0xff, 0xd8], new Array(100000).fill(0xff)))).toBeNull();
    let seed = 12345;
    for (let round = 0; round < 200; round++) {
      const data = new Uint8Array(300);
      for (let i = 0; i < data.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i] = seed >> 16;
      }
      for (const prefix of [[], PNG_SIG, bytes("GIF89a"), [0xff, 0xd8], bytes("RIFF....WEBP"), bytes("....ftypavif")]) {
        const input = bytes(prefix, data);
        expect(() => imageSize(input)).not.toThrow();
      }
    }
  });
});
