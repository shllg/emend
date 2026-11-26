import { AGENT_NOTE_QUOTES_FEATURE, DIFF_IMAGES_FEATURE, type PublishRequest } from "@recense/contract";
import { escapeReference } from "../escape.ts";
import { CliError } from "../http.ts";
import type { BlobSource } from "./upload.ts";

export function publishForDestination(
  request: PublishRequest,
  blobs: Map<string, BlobSource>,
  features: readonly string[],
): { request: PublishRequest; blobs: Map<string, BlobSource> } {
  if (!features.includes(AGENT_NOTE_QUOTES_FEATURE)) {
    for (const file of request.files) {
      const index = file.notes?.findIndex((note) => note.quote !== undefined) ?? -1;
      if (index >= 0)
        throw new CliError(
          `Agent note ${index} in ${escapeReference(file.path)}: the recense server needs an update to place note quotes.`,
        );
    }
  }
  if (features.includes(DIFF_IMAGES_FEATURE) || !request.files.some((file) => file.image)) return { request, blobs };
  const files = request.files.map(({ image: _image, ...file }) => file);
  const referenced = new Set(files.flatMap((file) => [file.oldBlob, file.newBlob]));
  return { request: { ...request, files }, blobs: new Map([...blobs].filter(([hash]) => referenced.has(hash))) };
}
