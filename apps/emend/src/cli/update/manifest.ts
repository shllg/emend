interface InstalledManifest {
  name: "@shllg/emend";
  emendLocalBuild?: string;
}

interface ReleaseManifest extends InstalledManifest {
  version: string;
}

interface PnpmProject {
  dependencies?: Record<string, { version: string; path: string }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isInstalledManifest(value: unknown): value is InstalledManifest {
  return (
    isObject(value) &&
    value.name === "@shllg/emend" &&
    (value.emendLocalBuild === undefined || typeof value.emendLocalBuild === "string")
  );
}

export function isReleaseManifest(value: unknown): value is ReleaseManifest {
  return (
    isInstalledManifest(value) &&
    "version" in value &&
    typeof value.version === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version)
  );
}

export function isPnpmProjects(value: unknown): value is PnpmProject[] {
  return (
    Array.isArray(value) &&
    value.every(
      (project: unknown) =>
        isObject(project) &&
        (project.dependencies === undefined ||
          (isObject(project.dependencies) &&
            Object.values(project.dependencies).every(
              (dependency) =>
                isObject(dependency) && typeof dependency.version === "string" && typeof dependency.path === "string",
            ))),
    )
  );
}
