import { z } from "zod";

export const LINKS = { perRevision: 8, urlChars: 2048, labelChars: 60 } as const;

// Whitespace, control and format characters (bidi marks, zero-width joiners) never belong in a URL or label.
const unsafeChars = /[\s\p{Cc}\p{Cf}]/u;

function parseHttps(value: string): URL | null {
  if (value.length > LINKS.urlChars || unsafeChars.test(value) || !/^https:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hostname === "") return null;
    return url;
  } catch {
    return null;
  }
}

/** An absolute https URL without credentials, as the reviewer's browser should open it. */
export const HttpsUrl = z.string().refine((value) => parseHttps(value) !== null, "expected an https URL");

const host = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;
const segment = /^[A-Za-z0-9._-]+$/;

/** `https://host/owner/name`, nothing else: the base for issue links. */
export const RepoUrl = z.string().refine((value) => {
  const url = parseHttps(value);
  if (url === null) return false;
  if (url.search !== "" || url.hash !== "" || url.host !== url.host.toLowerCase()) return false;
  const [authority = "", ...path] = value.slice("https://".length).split("/");
  if (!host.test(authority) || path.length !== 2) return false;
  return (
    path.every((part) => segment.test(part) && part !== "." && part !== "..") && url.pathname === `/${path.join("/")}`
  );
}, "expected https://host/owner/name");
export type RepoUrl = z.infer<typeof RepoUrl>;

/**
 * Terminal and bidi controls, and characters that render as nothing or reorder text.
 * It matches the CLI's terminal escape set (apps/emend/src/cli/escape.ts), except U+2028 and U+2029,
 * which a whitespace step turns into spaces first.
 */
export const INVISIBLE_CHAR_RANGES: readonly (readonly [number, number])[] = [
  [0, 0x1f],
  [0x7f, 0x9f],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

export const isInvisibleChar = (codePoint: number): boolean =>
  INVISIBLE_CHAR_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);

const hasInvisibleChar = (value: string): boolean =>
  Array.from(value).some((char) => isInvisibleChar(char.codePointAt(0) ?? 0));

const isPlainVisible = (value: string): boolean => value.trim() !== "" && !/[\p{Cc}\p{Cf}]/u.test(value);

const isPlainIssueTitle = (value: string): boolean => isPlainVisible(value) && !hasInvisibleChar(value);

export const PublishLink = z.object({
  url: HttpsUrl,
  label: z.string().min(1).max(LINKS.labelChars).refine(isPlainVisible, "label must be plain visible text"),
  kind: z.enum(["pr", "issue", "other"]).optional(),
});
export type PublishLink = z.infer<typeof PublishLink>;

export const PublishLinks = z.array(PublishLink).max(LINKS.perRevision);
export type PublishLinks = z.infer<typeof PublishLinks>;

export const ISSUE_REFS = { perRevision: 64, titleChars: 256, maxNumber: 9_999_999 } as const;

export const IssueState = z.enum(["open", "closed", "merged"]);
export type IssueState = z.infer<typeof IssueState>;

const issueTitle = z
  .string()
  .min(1)
  .max(ISSUE_REFS.titleChars)
  .refine(isPlainIssueTitle, "title must be plain visible text");

const issueNumber = z.int().min(1).max(ISSUE_REFS.maxNumber);

function issueRefsOf<T extends z.ZodType<{ number: number }>>(entry: T) {
  return z
    .array(entry)
    .max(ISSUE_REFS.perRevision)
    .refine((refs) => new Set(refs.map((ref) => ref.number)).size === refs.length, "each issue number at most once");
}

/** The title and state of one issue or pull request the writeup names as `#123`. */
export const IssueRef = z.object({ number: issueNumber, title: issueTitle, state: IssueState });
export type IssueRef = z.infer<typeof IssueRef>;

export const IssueRefs = issueRefsOf(IssueRef);
export type IssueRefs = z.infer<typeof IssueRefs>;

/**
 * Control and whitespace runs become one space, format characters and characters that render as nothing go,
 * then spaces collapse, and the result is trimmed and cut to the limit.
 */
export function plainIssueTitle(value: string): string {
  const flat = Array.from(value.replace(/[\s\p{Cc}]+/gu, " ").replace(/\p{Cf}/gu, ""))
    .filter((char) => !isInvisibleChar(char.codePointAt(0) ?? 0))
    .join("")
    .replace(/ +/g, " ")
    .trim();
  if (flat.length <= ISSUE_REFS.titleChars) return flat;
  let end = ISSUE_REFS.titleChars;
  const last = flat.charCodeAt(end - 1);
  // Do not end on the high half of a surrogate pair.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return flat.slice(0, end).trim();
}

/** A manifest cleans each title to plain text first; an entry still invalid after that fails the manifest. */
export const ManifestIssueRef = z.object({
  number: issueNumber,
  title: z.preprocess((value) => (typeof value === "string" ? plainIssueTitle(value) : value), issueTitle),
  state: IssueState,
});
export const ManifestIssueRefs = issueRefsOf(ManifestIssueRef);

/** The publish-level fields that ride beside the writeup: in its source blob and its rendered blob. */
export const PublishMeta = z.object({
  links: PublishLinks.optional(),
  repoUrl: RepoUrl.optional(),
  issueRefs: IssueRefs.optional(),
});
export type PublishMeta = z.infer<typeof PublishMeta>;
