type FileIdentity = { path: string; oldPath: string | null; role: string };

/** Published diffs share base identities; their paths are not transition-relative renames. */
export function revisionTransition(
  before: FileIdentity[],
  after: FileIdentity[],
  beforeBase: string | null = null,
  afterBase: string | null = null,
): Map<string, string | null> {
  const current = new Map(after.filter((f) => f.role === "diff").map((f) => [f.oldPath ?? f.path, f.path]));
  const surviving = new Set(after.filter((f) => f.role === "diff").map((f) => f.path));
  const transition = new Map<string, string | null>();
  for (const file of before)
    if (file.role === "diff") {
      if (surviving.has(file.path)) continue;
      const next = beforeBase === afterBase ? (current.get(file.oldPath ?? file.path) ?? null) : null;
      // Deletion rows still represent files in the review and retain their old sides.
      if (next !== file.path) transition.set(file.path, next);
    }
  return transition;
}
