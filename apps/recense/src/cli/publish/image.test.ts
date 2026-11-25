import { diffImageType } from "@recense/contract";
import { expect, test } from "vitest";
import { recognizesImage } from "./image.ts";

function ftyp(major: string, minor: string, compatible: string, size = 20) {
  const bytes = Buffer.from(`0000ftyp${major}${minor}${compatible}`);
  bytes.writeUInt32BE(size);
  return bytes;
}

test.each([
  ["icons/a.PNG", Buffer.from("89504e470d0a1a0a", "hex")],
  ["a.jpg", Buffer.from("ffd8ff", "hex")],
  ["a.JPEG", Buffer.from("ffd8ff", "hex")],
  ["a.gif", Buffer.from("GIF87a")],
  ["a.gif", Buffer.from("GIF89a")],
  ["a.webp", Buffer.from("RIFF1234WEBP")],
  ["a.avif", ftyp("avif", "0000", "mif1")],
  ["a.avif", ftyp("mif1", "0000", "avis")],
  ["a.svg", Buffer.from("\ufeff<?xml version='1.0'?><svg/>")],
] as const)("recognizes %s from its extension and bytes", (path, bytes) => {
  expect(recognizesImage(diffImageType(path), bytes)).toBe(true);
});

test.each([
  ["a.gif", Buffer.from("GIF88a")],
  ["a.jpeg", Buffer.from("GIF89a")],
  ["a.webp", Buffer.from("RIFFWEBP")],
  ["a.avif", ftyp("mif1", "avif", "mif1")],
  ["a.avif", ftyp("mif1", "0000", "avif", 16)],
  ["a.avif", ftyp("avif", "0000", "avis", 24)],
  ["a.svg", Buffer.from("<svg/>\0")],
  ["a.svg", Buffer.concat([Buffer.from("<svg/>"), Buffer.from([0xff])])],
  ["a.svg", Buffer.from("<svg-other/>")],
  ["a.txt", Buffer.from("GIF89a")],
  ["a.gif/README", Buffer.from("GIF89a")],
  ["gif", Buffer.from("GIF89a")],
  ["a.constructor", Buffer.from("GIF89a")],
] as const)("rejects unsupported or mismatched bytes for %s", (path, bytes) => {
  expect(recognizesImage(diffImageType(path), bytes)).toBe(false);
});
