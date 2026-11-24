import { type FileStatus, OTHER_TOPIC, type PublishManifest } from "@recense/contract";

export type ChangedPath = { path: string; oldPath: string | null; status: FileStatus };
export class UnchangedFilesError extends Error {
  readonly paths: string[];
  constructor(paths: string[]) {
    super(paths.join(", "));
    this.paths = paths;
  }
}
export function withOtherChanges(changed: ChangedPath[], files: PublishManifest["files"]) {
  const changedPaths = new Set(changed.map((file) => file.path));
  const unchanged = files
    .filter((file) => file.role === "diff" && !changedPaths.has(file.path))
    .map((file) => file.path);
  if (unchanged.length) throw new UnchangedFilesError(unchanged);
  const listed = new Set(files.filter((file) => file.role === "diff").map((file) => file.path));
  const other = changed.filter((file) => !listed.has(file.path)).map((file) => file.path);
  return {
    files: [...files, ...other.map((path) => ({ path, role: "diff" as const, topic: OTHER_TOPIC.slug }))],
    other,
  };
}
