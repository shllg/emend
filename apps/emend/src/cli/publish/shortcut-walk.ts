import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { extname, join } from "node:path";
import { escapeReference } from "../escape.ts";
import { CliError } from "../http.ts";
import { inside, OversizedFile } from "./read.ts";

export const SHORTCUT_LIMITS = { entries: 20000, directories: 2000, warnings: 20 } as const;
// Check only the entry name before any filesystem call on a regular file.
const binaryExtensions = new Set(
  "png jpg jpeg gif webp avif ico bmp tif tiff heic heif woff woff2 ttf otf eot mp4 webm ogg mp3 wav m4a aac flac mov avi mkv pdf zip gz tgz tar bz2 xz zst 7z rar exe dll so dylib o a obj lib class jar wasm sqlite sqlite3 db bin dat npy npz pkl pickle parquet onnx pt pth safetensors gguf h5 docx xlsx pptx odt iso dmg apk whl deb rpm msi pyc".split(
    " ",
  ),
);
export const isBinaryPath = (path: string) => binaryExtensions.has(extname(path).slice(1).toLowerCase());
const secretExtensions = new Set(
  "pem key p12 pfx p8 jks keystore bks ppk der keytab kdbx gpg pgp asc ovpn tfvars tfstate kubeconfig env secret secrets".split(
    " ",
  ),
);
const secretNames = [
  /^id_[a-z0-9_-]+$/i,
  /^(identity|master\.key|htpasswd|_netrc|_pgpass|pgpass\.conf|kubeconfig)$/i,
  /(^|[^a-z])secrets?([^a-z]|$)/i,
  /(^|[^a-z])credentials?([^a-z]|$)/i,
  /(^|[^a-z])passw(or)?ds?([^a-z]|$)/i,
  /(^|[^a-z])private[-_ ]?keys?([^a-z]|$)/i,
  /^token\.json$/i,
  /firebase-adminsdk.*\.json$/i,
  /^client_secret.*\.json$/i,
  /^service[-_]?account.*\.json$/i,
  /_accesskeys\.csv$/i,
  /\.tfstate\.backup$/i,
  /\.tfvars\.json$/i,
];
export const isSecretPath = (name: string) =>
  !/\.(md|markdown|html|htm)$/i.test(name) &&
  (secretExtensions.has(extname(name).slice(1).toLowerCase()) || secretNames.some((pattern) => pattern.test(name)));
export type SkipReason =
  | "binary file"
  | "may hold a secret"
  | "not a text file"
  | "too large"
  | "unreadable"
  | "not a doc or referenced HTML asset";
export function readSkipReason(error: unknown): "too large" | "unreadable" | undefined {
  if (error instanceof OversizedFile) return "too large";
  if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return "unreadable";
  return undefined;
}
export const visible = (name: string) => !name.startsWith(".") && name !== "node_modules";
export interface WalkBudget {
  entries: number;
  directories: number;
}

/** Buffer a bounded listing and verify it before exposing any entry names to the walker. */
async function directoryEntries(folder: string, checked: (file: string) => Promise<string>, visit: () => void) {
  const actual = await checked(folder);
  const before = await lstat(folder);
  if (!before.isDirectory()) throw new Error("changed directory");
  const handle = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("changed directory");
    const descriptor = `${process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd"}/${handle.fd}`;
    if (process.platform === "linux" && (await realpath(descriptor)) !== actual) throw new Error("changed directory");
    const directory = await opendir(descriptor);
    const entries: Dirent[] = [];
    for await (const entry of directory) {
      visit();
      entries.push(entry);
    }
    const after = await lstat(folder);
    if (
      !after.isDirectory() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      (await checked(folder)) !== actual
    )
      throw new Error("changed directory");
    if (process.platform === "linux" && (await realpath(descriptor)) !== actual) throw new Error("changed directory");
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } finally {
    await handle.close();
  }
}

export async function walkDocs(
  folder: string,
  argument: string,
  checked: (file: string) => Promise<string>,
  add: (actual: string, source: string) => void,
  skip: (file: string, reason: SkipReason) => void,
  budget: WalkBudget,
): Promise<void> {
  const argumentPath = escapeReference(argument);
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new CliError(`publishing folders is not supported on this platform yet: ${argumentPath}`);
  const entryLimit = new CliError(
    `published folder ${argumentPath} exceeds the ${SHORTCUT_LIMITS.entries}-entry walk limit`,
  );
  const directoryLimit = new CliError(
    `published folder ${argumentPath} exceeds the ${SHORTCUT_LIMITS.directories}-directory walk limit`,
  );
  const symlinkError = new CliError(`symlink leaves the published folder: ${argumentPath}`);
  // Iteration bounds both live descriptors and JS stack depth, even for deeply nested trees.
  const pending = [folder];
  try {
    while (pending.length) {
      const current = pending.pop();
      if (!current) break;
      if (++budget.directories > SHORTCUT_LIMITS.directories) throw directoryLimit;
      const entries = await directoryEntries(current, checked, () => {
        if (++budget.entries > SHORTCUT_LIMITS.entries) throw entryLimit;
      });
      for (const entry of entries) {
        if (!visible(entry.name)) continue;
        const file = join(current, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            if (!inside(folder, await realpath(file))) throw symlinkError;
          } catch (error) {
            if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          }
          skip(file, "not a doc or referenced HTML asset");
        } else if (entry.isDirectory()) {
          if (/^(secrets?|credentials?)$/i.test(entry.name)) skip(file, "may hold a secret");
          else pending.push(file);
        } else if (entry.isFile()) {
          if (isSecretPath(entry.name)) skip(file, "may hold a secret");
          else if (isBinaryPath(entry.name)) skip(file, "binary file");
          else {
            try {
              const actual = await checked(file);
              if (!(await lstat(file)).isFile()) throw new Error("changed doc");
              add(actual, file);
            } catch (error) {
              const reason = readSkipReason(error);
              if (!reason) throw error;
              skip(file, reason);
            }
          }
        } else skip(file, "not a doc or referenced HTML asset");
      }
    }
  } catch (error) {
    if (error === entryLimit || error === directoryLimit || error === symlinkError) throw error;
    // Only fixed diagnostics known to contain no discovered path may pass through.
    if (
      error instanceof CliError &&
      [
        "too many files in the review",
        "source is outside the allowed doc roots",
        "source is behind a symlink or non-folder",
      ].includes(error.message)
    )
      throw error;
    // Never expose an entry name from an untrusted or swapped listing in a diagnostic.
    throw new CliError(`could not read published folder: ${argumentPath}`);
  }
}
