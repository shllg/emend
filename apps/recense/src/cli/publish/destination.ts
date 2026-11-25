import { DIFF_IMAGES_FEATURE, type PublishRequest } from "@recense/contract";
import type { BlobSource } from "./upload.ts";

export function publishForDestination(
  request: PublishRequest,
  blobs: Map<string, BlobSource>,
  features: readonly string[],
): { request: PublishRequest; blobs: Map<string, BlobSource> } {
  if (features.includes(DIFF_IMAGES_FEATURE) || !request.files.some((file) => file.image)) return { request, blobs };
  const files = request.files.map(({ image: _image, ...file }) => file);
  const referenced = new Set(files.flatMap((file) => [file.oldBlob, file.newBlob]));
  return { request: { ...request, files }, blobs: new Map([...blobs].filter(([hash]) => referenced.has(hash))) };
}
