import { z } from "zod";

export const DIFF_IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
} as const;
export const DiffImageMediaType = z.enum([...new Set(Object.values(DIFF_IMAGE_TYPES))]);
export type DiffImageMediaType = z.infer<typeof DiffImageMediaType>;

export function diffImageType(path: string): DiffImageMediaType | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = name.slice(dot + 1).toLowerCase();
  if (dot <= 0 || !Object.hasOwn(DIFF_IMAGE_TYPES, ext)) return undefined;
  return DIFF_IMAGE_TYPES[ext as keyof typeof DIFF_IMAGE_TYPES];
}

const Sha256 = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
export const DiffImageSide = z.union([
  z.strictObject({ blob: Sha256 }),
  z.strictObject({ flag: z.literal("oversized") }),
]);
export type DiffImageSide = z.infer<typeof DiffImageSide>;
export const DiffImage = z.strictObject({ old: DiffImageSide.nullable(), new: DiffImageSide.nullable() });
export type DiffImage = z.infer<typeof DiffImage>;
export function diffImageBlobs(image: DiffImage | undefined): string[] {
  return image ? [image.old, image.new].flatMap((side) => (side && "blob" in side ? [side.blob] : [])) : [];
}
export const DiffImageSideView = z.strictObject({
  mediaType: DiffImageMediaType,
  flag: z.literal("oversized").nullable(),
});
export type DiffImageSideView = z.infer<typeof DiffImageSideView>;
export const DiffImageView = z.strictObject({
  old: DiffImageSideView.nullable(),
  new: DiffImageSideView.nullable(),
  unchanged: z.literal(true).optional(),
});
export type DiffImageView = z.infer<typeof DiffImageView>;
