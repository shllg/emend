// Public-content checks shared by the local/CI gate and bin/wt. Diagnostics contain locations and
// rule labels only: never echo content, git errors, private terms or the command's arguments.
// In default/push files, a trailing allow comment on a line of at most 300 characters exempts
// generic rules except secrets (a bare private-key header may be exempted). Terms and overlong
// combining-mark runs are never exempted.
import { isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

export interface PrivateTerms {
  terms: { value: string; line: number; source?: "file" | "env" }[];
  allowed: string[];
  notes: string[];
}

export interface PublicResult {
  hits: string[];
  notes: string[];
  newMarkers?: string[];
}

export class PublicCheckError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface Rule {
  label: string;
  pattern: RegExp;
  allowed?: (match: RegExpExecArray) => boolean;
  noLineExemption?: boolean;
  privateKeyHeader?: boolean;
  requireKeyBody?: boolean;
}

// Patterns and synthetic exceptions are assembled from parts so source files do not match themselves.
const HOME_NAMES = new Set(["someone", "user", "runner", "shared", "node"]);
const IP_EXCEPTIONS = new Set(
  [
    [10, 1, 2, 3],
    [100, 64, 0, 1],
    [100, 100, 100, 100],
  ].map((ip) => ip.join(".")),
);
const EMAIL_DOMAINS = new Set(["com", "org", "net"].map((tld) => ["example", tld].join(".")));
const RESERVED_SUFFIXES = ["test", "invalid", "example", "localhost"].map((suffix) => `.${suffix}`);
const ALLOW_MARKER = ["check-public:", " allow"].join("");
const ALLOW_COMMENT = new RegExp(`(?://|#|/\\*|<!--)\\s*${ALLOW_MARKER}\\s*(?:\\*/|-->)?\\s*$`);
const URL_USERINFO = new RegExp(
  [
    "(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31})",
    "://",
    "([^\\s/?#<>\"'`@,;()[\\]]+)@",
    "([^\\s/?#<>\"'`@,;()[\\]:]+)",
  ].join(""),
  "gi",
);
const domainLabel = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const label = `(?:${domainLabel}|<[^<>\\s./]{1,63}>)`;
const KEY_HEADER = new RegExp(
  ["-----", "BEGIN ", "[A-Z0-9 ]*", "PRIVATE", " KEY(?: BLOCK)?", "-----"].join(""),
  "g",
);
const OTHER_KEY_HEADER = new RegExp(
  ["PuTTY-User-", "Key-File-[0-9]+:", "|---- BEGIN SSH2 ENCRYPTED ", "PRIVATE KEY ----"].join(""),
  "g",
);
const BODY_KEY_HEADER = new RegExp(`${KEY_HEADER.source}|${OTHER_KEY_HEADER.source}`, "g");
const RULES: Rule[] = [
  {
    label: "real home path",
    pattern: new RegExp(
      [
        "(?<![A-Za-z0-9._-])(?:/(?:ho",
        "me|Us",
        "ers)/|[A-Za-z]:\\\\{1,2}Us",
        "ers\\\\{1,2})",
        "(<[^<>/\\\\\\s]+>|\\$\\{[^{}/\\\\\\s]+\\}|\\$[A-Za-z_][A-Za-z0-9_]*|~|[^/\\\\\\s\"'`<>,;:!?()\\[\\]{}]+)",
      ].join(""),
      "g",
    ),
    allowed: (match) =>
      HOME_NAMES.has((match[1] ?? "").toLowerCase()) ||
      /^(?:<.*>|\$[\s\S]+|~)$/.test(match[1] ?? ""),
  },
  {
    label: "real home path",
    pattern: /(?<![a-z0-9._~-])~([a-z0-9_-]+)\//gi,
    allowed: (match) => HOME_NAMES.has((match[1] ?? "").toLowerCase()),
  },
  {
    label: "URL password",
    pattern: URL_USERINFO,
    allowed: (match) => {
      const userinfo = match[2] ?? "";
      const colon = userinfo.indexOf(":");
      if (colon < 0 || colon === userinfo.length - 1) return true;
      const password = userinfo.slice(colon + 1);
      const host = (match[3] ?? "").toLowerCase();
      return (
        /^(?:pass|passwd|password|pw|pwd|secret|token|changeme|x+|\*+|<[^<>]+>|\$[a-z_][a-z0-9_]*|\$\{[a-z_][a-z0-9_]*\})$/i.test(
          password,
        ) ||
        host === "example" ||
        host === "localhost" ||
        [...EMAIL_DOMAINS].some((reserved) => host === reserved || host.endsWith(`.${reserved}`)) ||
        RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))
      );
    },
  },
  {
    label: "tailnet host name",
    pattern: new RegExp(
      ["(?<![a-z0-9<>.-])", label, "(?:\\.", label, "){0,8}", "\\.ts", "\\.net", "(?![a-z0-9-])"].join(""),
      "gi",
    ),
    allowed: (match) => {
      const tailnet = match[0].split(".").at(-3) ?? "";
      return tailnet.toLowerCase() === "example" || /^<[^<>]+>$/.test(tailnet);
    },
  },
  {
    label: "private or tailnet IPv4 address",
    pattern: new RegExp(["(?<![\\d.])", "(?:\\d{1,3}\\.){3}", "\\d{1,3}", "(?!\\d|\\.\\d)"].join(""), "g"),
    allowed: (match) => {
      const parts = match[0].split(".").map(Number);
      if (parts.some((part) => part > 255)) return true;
      const [a = -1, b = -1] = parts;
      const privateAddress =
        a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
      return !privateAddress || IP_EXCEPTIONS.has(match[0]);
    },
  },
  {
    label: "tailnet IPv6 address",
    pattern: new RegExp(
      ["(?<![a-f0-9:])", "fd7a", ":115c", ":a1e0", ":(?=[a-f0-9:])", "[a-f0-9:]{1,30}", "(?![a-f0-9:])"].join(""),
      "gi",
    ),
  },
  {
    label: "email address",
    pattern: new RegExp(
      [
        "(?<![a-z0-9._%+-])",
        "(?=[a-z0-9])",
        "[a-z0-9._%+-]{1,64}",
        "@",
        domainLabel,
        "(?:\\.",
        domainLabel,
        "){0,8}",
        "\\.[a-z]{2,63}",
        "(?![a-z0-9-]|\\.[a-z0-9])",
      ].join(""),
      "gi",
    ),
    allowed: (match) => {
      const [local, domain = ""] = match[0].toLowerCase().split("@");
      return (
        (local === "git" && ["github.com", "gitlab.com"].includes(domain)) ||
        [...EMAIL_DOMAINS].some((reserved) => domain === reserved || domain.endsWith(`.${reserved}`)) ||
        RESERVED_SUFFIXES.some((suffix) => domain.endsWith(suffix))
      );
    },
  },
  {
    label: "secret shape",
    noLineExemption: true,
    pattern: new RegExp(
      [
        "gh",
        "[pousr]_",
        "[A-Za-z0-9]{36,}",
        "|github",
        "_pat_",
        "[A-Za-z0-9_]{22,}",
        "|sk",
        "-(?:ant|proj)-",
        "[A-Za-z0-9_-]{20,}",
        "|xo",
        "x[abprs]-",
        "[A-Za-z0-9][A-Za-z0-9-]*",
        "|AK",
        "IA",
        "[0-9A-Z]{16}",
        "|np",
        "m_",
        "[A-Za-z0-9]{36}",
        "|(?<![A-Za-z0-9_])em",
        "[sp]?_",
        "[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])",
        "|\\btskey",
        "-[A-Za-z]+-[A-Za-z0-9_-]+",
        "|AGE-SECRET-", "KEY-1[A-Z0-9]{50,}",
      ].join(""),
      "g",
    ),
  },
  {
    label: "secret shape",
    pattern: KEY_HEADER,
    privateKeyHeader: true,
  },
  {
    label: "secret shape",
    pattern: OTHER_KEY_HEADER,
    privateKeyHeader: true,
    requireKeyBody: true,
  },
];
const EMAIL_RULE = RULES.find((rule) => rule.label === "email address") as Rule;
const IDENTITY_NOREPLY = /^(?:noreply@github\.com|[^@\s]+@users\.noreply\.github\.com)$/i;
const ATTRIBUTION: Rule = {
  label: "attribution",
  pattern: new RegExp(
    [
      "^[ \\t]*(?:Co-Auth",
      "ored|Assisted|Generated)",
      "-By:",
      "|\\bGenerated (?:with|by) ",
      "\\[?",
      "(?:Claude(?: Code)?|Codex|ChatGPT|GPT|Copilot|OpenCode|Gemini)\\b",
    ].join(""),
    "gim",
  ),
};

function git(cwd: string, args: string[], options: { missing?: boolean; input?: string } = {}): Buffer {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, EMEND_PRIVATE_TERMS: undefined, GIT_TERMINAL_PROMPT: "0" };
    // The exempt identity must come from the user's own global or system config.
    for (const key of Object.keys(env))
      if (/^GIT_CONFIG_(?:PARAMETERS|COUNT|GLOBAL|SYSTEM|NOSYSTEM|KEY_.*|VALUE_.*)$/.test(key)) delete env[key];
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_NAMESPACE",
    ]) delete env[key];
    const result = spawnSync(
      "git",
      [
        "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false",
        "-c", "i18n.logOutputEncoding=UTF-8", "-C", cwd, ...args,
      ],
      {
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        env,
        input: options.input,
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (!result.error && result.status === 0) return result.stdout;
    // rev-parse --quiet uses precisely this result for an absent ref (including unborn HEAD).
    if (
      options.missing &&
      !result.error &&
      result.status === 1 &&
      result.stdout.length === 0 &&
      result.stderr.length === 0
    )
      return Buffer.alloc(0);
  } catch {
    // Exceptions and captured stderr may contain private paths or remote credentials.
  }
  throw new PublicCheckError(1, "check:public: could not read git data");
}

function resolves(cwd: string, ref: string): boolean {
  return git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref], { missing: true }).length > 0;
}

/** Same branch base as check-sync: SYNC_BASE, then origin/main, then main. */
function branchRange(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!resolves(cwd, "HEAD")) return undefined;
  const explicit = env.SYNC_BASE;
  const base = explicit
    ? resolves(cwd, explicit)
      ? explicit
      : undefined
    : ["origin/main", "main"].find((ref) => resolves(cwd, ref));
  if (!base)
    throw new PublicCheckError(1, "check:public: cannot find the branch base: set SYNC_BASE to the branch base");
  return `${base}..HEAD`;
}

export interface TermsOptions {
  root?: string;
  requireTerms?: boolean;
}

/** Line numbers are local to each source, including comments and blank lines. */
export function loadPrivateTerms(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: TermsOptions = {},
): PrivateTerms {
  const result: PrivateTerms = { terms: [], allowed: [], notes: [] };
  const sources: { kind: "file" | "env"; text: string }[] = [];
  let root = options.root;
  if (root === undefined) {
    // Explicit text checks also work outside git. Discover that without swallowing a git failure.
    let directory = path.resolve(cwd);
    while (!existsSync(path.join(directory, ".git")) && path.dirname(directory) !== directory)
      directory = path.dirname(directory);
    root = existsSync(path.join(directory, ".git"))
      ? path.dirname(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString("utf8").trim())
      : cwd;
  }
  try {
    const bytes = readFileSync(path.join(root, ".private-terms"));
    if (!isUtf8(bytes) || bytes.includes(0) || utf16Bom(bytes) || utf32Bom(bytes)) throw new Error();
    sources.push({ kind: "file", text: bytes.toString("utf8").replace(/^\ufeff/, "") });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new PublicCheckError(1, "check:public: could not read private terms list");
  }
  if (env.EMEND_PRIVATE_TERMS !== undefined) sources.push({ kind: "env", text: env.EMEND_PRIVATE_TERMS });
  let ignoredAllowed = false;
  for (const source of sources) {
    source.text.split(/\r?\n/).forEach((raw, index) => {
      if (/[\r\u2028\u2029\u0085\v\f]/u.test(raw))
        throw new PublicCheckError(1, `check:public: invalid line separator in ${source.kind === "file" ? "private terms list" : "EMEND_PRIVATE_TERMS"} at line ${index + 1}`);
      // Comment syntax belongs to the raw list, before decoding escapes or stripping invisibles.
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      if (source.kind === "file" && /\s#/u.test(trimmed))
        throw new PublicCheckError(1, `check:public: inline comment in private terms list at line ${index + 1}`);
      const location = `${source.kind === "file" ? "private terms list" : "EMEND_PRIVATE_TERMS"}:${index + 1}`;
      const value = normalizeText(raw, location).text.trim();
      if (!value) return;
      if (value.startsWith("!")) {
        if (source.kind === "env") {
          ignoredAllowed = true;
          return;
        }
        const phrase = value.slice(1).trim();
        if (phrase) result.allowed.push(phrase);
      } else result.terms.push({ value, line: index + 1, source: source.kind });
    });
  }
  if (ignoredAllowed) result.notes.push("check:public: allowed phrases in EMEND_PRIVATE_TERMS are ignored");
  if (!sources.some((source) => source.kind === "file")) {
    if (options.requireTerms)
      throw new PublicCheckError(1,
        "check:public: private terms list required; ask the owner to create <main>/.private-terms; agents never create, read or edit it",
      );
    if (result.terms.length === 0) result.notes.push("check:public: no private terms list; generic rules only");
  }
  if (options.requireTerms && !result.terms.some((term) => term.source === "file"))
    throw new PublicCheckError(1, "check:public: the private terms list holds no terms");
  return result;
}

interface Match {
  start: number;
  end: number;
  label: string;
}

interface Normalized {
  text: string;
  starts: number[];
  ends: number[];
}

const STARTS_WITH_MARK = /^\p{M}/u;
const combiningCodePoints = new Map<string, boolean>();

function countsAsCombining(character: string): boolean {
  let combining = combiningCodePoints.get(character);
  if (combining === undefined) {
    // Normalize only one code point here: its decomposition is bounded, even for an unsafe run.
    combining = STARTS_WITH_MARK.test(character) || STARTS_WITH_MARK.test(character.normalize("NFKD"));
    combiningCodePoints.set(character, combining);
  }
  return combining;
}

/** Reject before text normalization, including term-only checks and location redaction. */
function combiningMarkRuns(text: string): Match[] {
  const runs: Match[] = [];
  let count = 0;
  let start = 0;
  let offset = 0;
  for (const character of text) {
    if (countsAsCombining(character)) {
      if (count === 0) start = offset;
      count++;
    } else {
      if (count > 32) runs.push({ start, end: offset, label: "combining-mark run" });
      count = 0;
    }
    offset += character.length; // Count code points, but retain the source's UTF-16 offsets.
  }
  if (count > 32) runs.push({ start, end: offset, label: "combining-mark run" });
  return runs;
}

/** Decode, strip invisibles, decompose and strip marks, then fold case and quotes, retaining source offsets. */
function normalizeText(input: string, location = "private terms list"): Normalized {
  if (combiningMarkRuns(input).length) throw new PublicCheckError(1, `${location}: combining-mark run`);
  const chunks: string[] = [];
  const result: Normalized = { text: "", starts: [], ends: [] };
  const decoded: Record<string, string> = {
    "%20": " ",
    "&nbsp;": " ",
    "&#32;": " ",
    "&#160;": " ",
    "&#x20;": " ",
    "&#xa0;": " ",
    "&quot;": '"',
    "&#34;": '"',
    "&#x22;": '"',
    "&apos;": "'",
    "&#39;": "'",
    "&#x27;": "'",
  };
  for (const match of input.matchAll(/%20|&(?:nbsp|quot|apos|#(?:32|160|34|39|x20|xa0|x22|x27));|[\s\S]/giu)) {
    const original = match[0];
    const value = (decoded[original.toLowerCase()] ?? original)
      .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "");
    if (!value) {
      // Keep removed trailing marks inside a redacted span as well.
      if (result.ends.length) result.ends[result.ends.length - 1] = match.index + original.length;
      continue;
    }
    chunks.push(value);
    for (let i = 0; i < value.length; i++) {
      result.starts.push(match.index);
      result.ends.push(match.index + original.length);
    }
  }
  const visible = chunks.join("");
  const lower = visible.toLowerCase(); // Whole-string folding preserves contextual final sigma.
  if (lower.length !== visible.length) {
    const starts: number[] = [];
    const ends: number[] = [];
    let at = 0;
    for (const character of visible) {
      for (let i = 0; i < character.toLowerCase().length; i++) {
        starts.push(result.starts[at] ?? at);
        ends.push(result.ends[at + character.length - 1] ?? at + character.length);
      }
      at += character.length;
    }
    result.starts = starts;
    result.ends = ends;
  }
  const folded = lower.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[\u2010-\u2015\u2212]/g, "-");
  const collapsed: Normalized = { text: "", starts: [], ends: [] };
  const characters: string[] = [];
  // Walk each run once. A wrapped comment may contribute one leader after its indentation.
  for (let at = 0; at < folded.length; ) {
    const start = at++;
    let character = folded[start] ?? "";
    if (/\s/u.test(character)) {
      let wrapped = /[\r\n\u2028\u2029]/u.test(character);
      while (at < folded.length && /\s/u.test(folded[at] ?? "")) {
        wrapped ||= /[\r\n\u2028\u2029]/u.test(folded[at] ?? "");
        at++;
      }
      if (wrapped) {
        const leader = ["//", "#", "*", ">", "--", ";"].find((value) => folded.startsWith(value, at));
        if (leader) {
          at += leader.length;
          while (at < folded.length && /\s/u.test(folded[at] ?? "")) at++;
        }
      }
      character = " ";
    }
    characters.push(character);
    collapsed.starts.push(result.starts[start] ?? start);
    collapsed.ends.push(result.ends[at - 1] ?? at);
  }
  collapsed.text = characters.join("");
  return collapsed;
}

function occurrences(text: string, value: string): { start: number; end: number }[] {
  const normalized = normalizeText(value).text.trim();
  if (!normalized) return [];
  const pattern = normalized
    .split(/ +/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s_-]{0,4}");
  return [...text.matchAll(new RegExp(`(?=(${pattern}))`, "gu"))].map((match) => ({
    start: match.index,
    end: match.index + (match[1]?.length ?? 0),
  }));
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return starts;
}

/** Index of the last sorted offset at or before at. */
function preceding(starts: number[], at: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((starts[mid] ?? 0) <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function allowComment(line: string): number {
  const content = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (content.length > 300 || /[\p{Cf}\u2028\u2029]/u.test(content) || /[^\P{Cc}\t]/u.test(content)) return -1;
  return ALLOW_COMMENT.exec(content)?.index ?? -1;
}

/** Scan contiguous body runs once, then move two cursors over each header's twenty-line window. */
function keyBodies(text: string): Map<number, number> {
  const headers = [...text.matchAll(BODY_KEY_HEADER)];
  const bodies = new Map<number, number>();
  if (!headers.length) return bodies;
  const runs: { start: number; end: number; line: number }[] = [];
  const headerLines: number[] = [];
  let headerAt = 0;
  let nonblank = 0;
  const addLine = (start: number, end: number) => {
    while (headerAt < headers.length && (headers[headerAt]?.index ?? Infinity) <= end) {
      headerLines.push(nonblank);
      headerAt++;
    }
    let runStart = start;
    let lower = false, upper = false, digit = false, symbol = false;
    for (let at = start; at <= end; at++) {
      const char = at < end ? (text[at] ?? "") : "";
      const isLower = char >= "a" && char <= "z";
      const isUpper = char >= "A" && char <= "Z";
      const isDigit = char >= "0" && char <= "9";
      const isSymbol = char === "+" || char === "/";
      if (isLower || isUpper || isDigit || isSymbol || char === "=") {
        lower ||= isLower;
        upper ||= isUpper;
        digit ||= isDigit;
        symbol ||= isSymbol;
      } else {
        if (at - runStart >= 40 && (symbol || (lower && upper && digit)))
          runs.push({ start: runStart, end: at, line: nonblank });
        runStart = at + 1;
        lower = upper = digit = symbol = false;
      }
    }
    if (text.slice(start, end).trim()) nonblank++;
  };
  let start = 0;
  for (const newline of text.matchAll(/\r\n?|\n|\\r(?:\\n)?|\\n/g)) {
    addLine(start, newline.index);
    start = newline.index + newline[0].length;
  }
  addLine(start, text.length);
  let first = 0, last = 0;
  for (const [index, header] of headers.entries()) {
    const end = header.index + header[0].length;
    while (first < runs.length && (runs[first]?.start ?? 0) < end) first++;
    last = Math.max(first, last);
    while (last < runs.length && (runs[last]?.line ?? Infinity) <= (headerLines[index] ?? 0) + 20) last++;
    // Redact through the last qualifying run, including every pasted body line in the window.
    if (last > first) bodies.set(header.index, runs[last - 1]?.end ?? end);
  }
  return bodies;
}

function matches(
  text: string,
  terms: PrivateTerms,
  attribution: boolean,
  lineExemptions = false,
  starts = lineStarts(text),
  generic = true,
): Match[] {
  const overlong = combiningMarkRuns(text);
  if (overlong.length) return overlong;
  const found: Match[] = [];
  if (generic) {
    const bodies = keyBodies(text);
    const exempt = new Set<number>();
    if (lineExemptions) {
      for (const [line, start] of starts.entries()) {
        const end = starts[line + 1] === undefined ? text.length : (starts[line + 1] as number) - 1;
        if (allowComment(text.slice(start, end)) >= 0) exempt.add(line);
      }
    }
    // A URL exempts only the email-shaped user-info/host pair in its own authority.
    const urls = [...text.matchAll(URL_USERINFO)].map((url) => ({
      start: url.index + (url[1]?.length ?? 0) + 1,
      end: url.index + url[0].length,
    }));
    let urlIndex = 0;
    for (const rule of attribution ? [...RULES, ATTRIBUTION] : RULES) {
      for (const match of text.matchAll(rule.pattern)) {
        const bodyEnd = rule.privateKeyHeader ? bodies.get(match.index) : undefined;
        if (rule.requireKeyBody && bodyEnd === undefined) continue;
        if (!rule.noLineExemption && bodyEnd === undefined && exempt.has(preceding(starts, match.index))) continue;
        if (rule.label === "email address") {
          while (urlIndex < urls.length && (urls[urlIndex]?.end ?? 0) <= match.index) urlIndex++;
          const url = urls[urlIndex];
          if (url && match.index >= url.start && match.index + match[0].length <= url.end) continue;
        }
        if (!rule.allowed?.(match))
          found.push({ start: match.index, end: bodyEnd ?? match.index + match[0].length, label: rule.label });
      }
    }
  }
  if (terms.terms.length) {
    const normalized = normalizeText(text);
    const allowed = terms.allowed
      .flatMap((value) => occurrences(normalized.text, value))
      .sort((a, b) => a.start - b.start);
    const allowedStarts = allowed.map((span) => span.start);
    const allowedEnds: number[] = [];
    for (const span of allowed) allowedEnds.push(Math.max(allowedEnds.at(-1) ?? 0, span.end));
    for (const term of terms.terms) {
      for (const span of occurrences(normalized.text, term.value)) {
        if ((allowedEnds[preceding(allowedStarts, span.start)] ?? -1) >= span.end) continue;
        found.push({
          start: normalized.starts[span.start] ?? span.start,
          end: normalized.ends[span.end - 1] ?? span.end,
          label: `private term (${term.source ?? "file"} line ${term.line})`,
        });
      }
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

// A filename itself can contain private content or terminal controls. Redact it as well.
function safeLocation(location: string, terms: PrivateTerms): string {
  // An overlong run prevents term normalization; redact the whole location, not just its marks.
  if (combiningMarkRuns(location).length) return "<redacted path>";
  const spans = matches(location, { ...terms, allowed: [] }, true, false);
  let out = "";
  let end = 0;
  for (const span of spans) {
    if (span.end <= end) continue;
    out += location.slice(end, Math.max(end, span.start)) + "[redacted]";
    end = span.end;
  }
  return (out + location.slice(end)).replace(/[\p{Cc}\p{Cf}]/gu, "?");
}

/** These inputs cannot safely use partial, line-by-line diagnostic disclosure. */
export function diagnosticBlockReason(text: string): string | undefined {
  if (combiningMarkRuns(text).length) return "combining-mark run";
  if (new RegExp(BODY_KEY_HEADER.source).test(text) || text.includes(["AGE-SECRET-", "KEY-1"].join("")))
    return "secret shape";
  return undefined;
}

/** Original source spans for diagnostics that must withhold every line touched by a hit. */
export function checkTextSpans(text: string, terms: PrivateTerms): Match[] {
  return matches(text, terms, true);
}

export function checkText(
  text: string,
  location: string,
  terms: PrivateTerms,
  options: { attribution?: boolean; lines?: boolean; columns?: boolean; lineExemptions?: boolean; generic?: boolean } = {},
): string[] {
  const safe = safeLocation(location, terms);
  const starts = lineStarts(text);
  return matches(text, terms, options.attribution ?? true, options.lineExemptions, starts, options.generic).map(
    (match) => {
      const index = preceding(starts, match.start);
      const line = options.lines || options.columns ? `:${index + 1}` : "";
      const column = options.columns ? `:${match.start - (starts[index] ?? 0) + 1}` : "";
      return `${safe}${line}${column}: ${match.label}`;
    },
  );
}

function checkPath(file: Buffer, terms: PrivateTerms, seen: Set<string>): string[] {
  const hits = checkPathText(file.toString("utf8"), terms, seen);
  if (!isUtf8(file)) hits.push(...checkPathText(file.toString("latin1"), terms, seen, false));
  return hits;
}

function checkPathText(file: string, terms: PrivateTerms, seen: Set<string>, generic = true): string[] {
  const hits: string[] = [];
  const parts = file.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const key = `${generic}:${prefix}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const match of matches(prefix, terms, true, false, undefined, generic))
      hits.push(`<redacted path>: ${match.label} (path)`);
  }
  return hits;
}

function pathLocation(file: Buffer | string, terms: PrivateTerms): string {
  if (Buffer.isBuffer(file) && !isUtf8(file)) {
    if (matches(file.toString("latin1"), { ...terms, allowed: [] }, false, false, undefined, false).length)
      return "<redacted path>";
  }
  return file.toString();
}

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FONT_MAGIC = [
  Buffer.from([0, 1, 0, 0]), // TTF
  Buffer.from("true"), // Apple TrueType
  Buffer.from("OTTO"),
];
const BINARY_MAGIC: Record<string, Buffer[]> = {
  ".png": [PNG_MAGIC],
  ".woff": [Buffer.from("wOFF")],
  ".woff2": [Buffer.from("wOF2")],
  ".ttf": FONT_MAGIC,
  ".otf": FONT_MAGIC,
};

function knownBinary(buffer: Buffer, file: string): boolean {
  const magic = BINARY_MAGIC[path.extname(file).toLowerCase()] ?? [];
  return magic.some((prefix) => buffer.subarray(0, prefix.length).equals(prefix));
}

/** PNG text chunks are small documents, including their keywords and translated keywords. */
function checkPng(buffer: Buffer, file: string, terms: PrivateTerms): string[] {
  const hits: string[] = [];
  try {
    for (let at = PNG_MAGIC.length; at < buffer.length; ) {
      if (buffer.length - at < 12) throw new Error();
      const size = buffer.readUInt32BE(at);
      if (size > buffer.length - at - 12) throw new Error();
      const kind = buffer.toString("ascii", at + 4, at + 8);
      const data = buffer.subarray(at + 8, at + 8 + size);
      at += size + 12; // length, type, data and CRC
      if (kind === "eXIf") hits.push(`${safeLocation(file, terms)}: binary metadata`);
      if (!["tEXt", "zTXt", "iTXt"].includes(kind)) continue;
      const separator = data.indexOf(0);
      if (separator < 1 || separator > 79) throw new Error();
      const parts = [data.subarray(0, separator).toString("latin1")];
      let text = data.subarray(separator + 1);
      if (kind === "zTXt") {
        if (text[0] !== 0) throw new Error();
        text = inflateSync(text.subarray(1), { maxOutputLength: 1024 * 1024 });
      } else if (kind === "iTXt") {
        const compressed = text[0];
        if ((compressed !== 0 && compressed !== 1) || text[1] !== 0) throw new Error();
        const languageEnd = text.indexOf(0, 2);
        const translatedEnd = languageEnd < 0 ? -1 : text.indexOf(0, languageEnd + 1);
        if (languageEnd < 0 || translatedEnd < 0) throw new Error();
        parts.push(text.subarray(2, languageEnd).toString("utf8"));
        parts.push(text.subarray(languageEnd + 1, translatedEnd).toString("utf8"));
        text = text.subarray(translatedEnd + 1);
        if (compressed) text = inflateSync(text, { maxOutputLength: 1024 * 1024 });
      }
      parts.push(text.toString(kind === "iTXt" ? "utf8" : "latin1"));
      hits.push(...checkText(parts.join("\n"), file, terms, { attribution: true }));
    }
  } catch {
    hits.push(`${safeLocation(file, terms)}: invalid PNG text metadata`);
  }
  return hits;
}

function utf32Bom(buffer: Buffer): boolean {
  return buffer.length >= 4 && [0x0000feff, 0xfffe0000].includes(buffer.readUInt32LE(0));
}

function utf16Bom(buffer: Buffer): boolean {
  return buffer.length >= 2 && [0xfeff, 0xfffe].includes(buffer.readUInt16LE(0));
}

function rawBomViews(buffer: Buffer, file: string, terms: PrivateTerms): string[] {
  return (["utf8", "latin1"] as const).flatMap((encoding) =>
    checkText(buffer.toString(encoding), file, terms, { lines: true, attribution: true }),
  );
}

function checkBuffer(
  buffer: Buffer,
  file: string,
  terms: PrivateTerms,
  attribution: boolean,
  lineExemptions = true,
): string[] {
  const unknown = `${safeLocation(file, terms)}: binary file of unknown type`;
  if (utf32Bom(buffer)) return [...new Set([unknown, ...rawBomViews(buffer, file, terms)])];
  if (utf16Bom(buffer)) {
    const encoding = buffer[0] === 0xff ? "utf-16le" : "utf-16be";
    const decoded = new TextDecoder(encoding).decode(buffer);
    return [...new Set([
      ...(decoded.includes("\0") ? [unknown] : []),
      ...checkText(decoded, file, terms, {
        attribution: true,
        lines: true,
        lineExemptions: false,
      }),
      ...rawBomViews(buffer, file, terms),
    ])];
  }
  // NUL-free data is always text. Only recognized images/fonts exempt NUL-bearing raw bytes.
  if (buffer.includes(0)) {
    const binary = knownBinary(buffer, file);
    const hits = binary ? [] : [unknown];
    const decoded = [buffer.toString("utf8"), buffer.toString("latin1")];
    for (const offset of [0, 1]) {
      const bytes = buffer.subarray(offset, offset + Math.floor((buffer.length - offset) / 2) * 2);
      decoded.push(bytes.toString("utf16le"), Buffer.from(bytes).swap16().toString("utf16le"));
    }
    hits.push(...decoded.flatMap((text) => checkText(text, file, terms, { lines: true, generic: false })));
    if (buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) hits.push(...checkPng(buffer, file, terms));
    return [...new Set(hits)];
  }
  const hits = checkText(buffer.toString("utf8"), file, terms, { attribution, lines: true, lineExemptions });
  if (!isUtf8(buffer)) {
    const utf8Hits = new Set(hits);
    hits.push(
      ...checkText(buffer.toString("latin1"), file, terms, { lines: true, generic: false }).filter(
        (hit) => !utf8Hits.has(hit),
      ),
    );
  }
  return hits;
}

function rejectNul(input: Buffer | string): void {
  if (typeof input === "string" ? input.includes("\0") : input.includes(0))
    throw new PublicCheckError(1, "check:public: explicit input contains a NUL byte");
}

function checkFile(cwd: string, file: string | Buffer, terms: PrivateTerms, explicit: boolean): string[] {
  if (explicit && combiningMarkRuns(file.toString()).length)
    return ["<redacted path>: combining-mark run (path)"];
  try {
    const full = Buffer.isBuffer(file) ? Buffer.concat([Buffer.from(`${cwd}/`), file]) : path.resolve(cwd, file);
    const location = pathLocation(file, terms);
    const stat = lstatSync(full);
    // Scan a symlink's stored target, never the file it points at.
    if (stat.isSymbolicLink()) {
      if (explicit) throw new PublicCheckError(1, "check:public: could not read a file");
      return checkBuffer(readlinkSync(full, { encoding: "buffer" }), location, terms, false);
    }
    if (stat.isFile()) {
      const buffer = readFileSync(full);
      if (explicit && !utf16Bom(buffer) && !utf32Bom(buffer)) rejectNul(buffer);
      return checkBuffer(buffer, location, terms, explicit, !explicit);
    }
    if (!explicit && stat.isDirectory()) return []; // Gitlinks have no file content in this repository.
  } catch (error) {
    if (error instanceof PublicCheckError) throw error;
    if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") return []; // Deleted working-tree file.
  }
  throw new PublicCheckError(1, "check:public: could not read a file");
}

function nulBuffers(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let at = buffer.indexOf(0); at !== -1; at = buffer.indexOf(0, start)) {
    if (at > start) parts.push(buffer.subarray(start, at));
    start = at + 1;
  }
  return parts;
}

function commits(cwd: string, range: string): string[] {
  if (!range || range.startsWith("-")) throw new PublicCheckError(2, "check:public: invalid commit range");
  return git(cwd, ["rev-list", "--end-of-options", range, "--"]).toString("utf8").split("\n").filter(Boolean);
}

function checkIdentity(value: string, own: string, email: boolean, location: string, terms: PrivateTerms): string[] {
  if (value === own) return [];
  const hits = checkText(value, location, terms, { generic: false, columns: true });
  if (email && !IDENTITY_NOREPLY.test(value)) {
    for (const match of value.matchAll(EMAIL_RULE.pattern))
      if (!EMAIL_RULE.allowed?.(match)) hits.push(`${location}:1:${match.index + 1}: email address`);
  }
  return hits;
}

function checkMergeTags(
  raw: string,
  location: string,
  terms: PrivateTerms,
  ownName: string,
  ownEmail: string,
): string[] {
  const hits: string[] = [];
  const end = raw.indexOf("\n\n");
  const headers = raw.slice(0, end < 0 ? raw.length : end).split("\n");
  for (let at = 0; at < headers.length; at++) {
    const line = headers[at] ?? "";
    if (!line.startsWith("mergetag ")) continue;
    const block = [line.slice("mergetag ".length)];
    while (headers[at + 1]?.startsWith(" ")) block.push((headers[++at] ?? "").slice(1));
    const message = block.indexOf("");
    const generic = [...block];
    const privateText = [...block];
    for (let index = 0; index < (message < 0 ? block.length : message); index++) {
      const header = block[index] ?? "";
      const tagger = /^tagger ([^<\n]*) <([^<>\n]*)>/.exec(header);
      if (!tagger) continue;
      const name = tagger[1] ?? "";
      const email = tagger[2] ?? "";
      const mask = (value: string, exempt: boolean) => exempt ? " ".repeat(value.length) : value;
      const prefix = `tagger ${mask(name, name === ownName)} <`;
      const suffix = `>${header.slice(tagger[0].length)}`;
      // Blank only identity exemptions; all other header and message text receives every rule.
      // Spaces keep the reported offsets within the original embedded block.
      privateText[index] = `${prefix}${mask(email, email === ownEmail)}${suffix}`;
      generic[index] = `${prefix}${mask(email, email === ownEmail || IDENTITY_NOREPLY.test(email))}${suffix}`;
    }
    hits.push(
      ...checkText(generic.join("\n"), `${location} mergetag`, { ...terms, terms: [] }, { columns: true }),
      ...checkText(privateText.join("\n"), `${location} mergetag`, terms, { columns: true, generic: false }),
    );
  }
  return hits;
}

function checkMessages(cwd: string, shas: string[], terms: PrivateTerms, identities = false): string[] {
  const ownName = git(cwd, ["config", "--get", "user.name"], { missing: true }).toString("utf8").replace(/\n$/, "");
  const ownEmail = git(cwd, ["config", "--get", "user.email"], { missing: true }).toString("utf8").replace(/\n$/, "");
  return shas.flatMap((sha) => {
    const location = `commit ${sha.slice(0, 7)}`;
    const hits = checkText(
      git(cwd, ["show", "--no-show-signature", "-s", "--format=%B", sha]).toString("utf8"),
      `${location} message`,
      terms,
      { columns: true },
    );
    hits.push(...checkMergeTags(git(cwd, ["cat-file", "commit", sha]).toString("utf8"), location, terms, ownName, ownEmail));
    if (identities) {
      const fields = git(cwd, ["show", "--no-show-signature", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", sha])
        .toString("utf8")
        .replace(/\n$/, "")
        .split("\0");
      for (const [i, value] of fields.entries()) {
        const identityLocation = `${location} ${i < 2 ? "author" : "committer"} ${i % 2 ? "email" : "name"}`;
        hits.push(...checkIdentity(value, i % 2 ? ownEmail : ownName, Boolean(i % 2), identityLocation, terms));
      }
    }
    return hits;
  });
}

export function checkPublic(
  options: TermsOptions & {
    cwd: string;
    files?: string[];
    texts?: (string | { field: string; text: string })[];
    commits?: string;
    env?: NodeJS.ProcessEnv;
  },
): PublicResult {
  const { cwd, files, texts } = options;
  const env = options.env ?? process.env;
  const terms = loadPrivateTerms(cwd, env, options);
  const hits: string[] = [];
  const explicit = files !== undefined || texts !== undefined;
  if (options.commits !== undefined && explicit)
    throw new PublicCheckError(2, "check:public: commit and text modes cannot be combined");
  if (explicit) {
    for (const file of files ?? []) hits.push(...checkFile(cwd, file, terms, true));
    for (const [i, value] of (texts ?? []).entries()) {
      const text = typeof value === "string" ? value : value.text;
      rejectNul(text);
      hits.push(...checkText(text, typeof value === "string" ? `--text #${i + 1}` : value.field, terms, { columns: true }));
    }
  } else {
    if (options.commits === undefined) {
      const root = git(cwd, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
      const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
      const paths = new Set<string>();
      for (const file of nulBuffers(listed)) {
        hits.push(...checkPath(file, terms, paths), ...checkFile(root, file, terms, false));
      }
    }
    const range = options.commits ?? branchRange(cwd, env);
    if (range !== undefined) hits.push(...checkMessages(cwd, commits(cwd, range), terms));
  }
  return { hits, notes: terms.notes };
}

export interface PushRemote {
  remote: "origin";
  /** Retained only to detect a changed destination; git commands still use the remote name. */
  url: string;
}

export interface PushDestination extends PushRemote {
  refs: Map<string, string>;
}

/** A named remote must have one push URL, identical to the URL used to fetch and advertise refs. */
export function readPushRemote(cwd: string): PushRemote {
  try {
    const urls = git(cwd, ["remote", "get-url", "--push", "--all", "origin"]).toString("utf8").trimEnd().split("\n");
    if (urls.length !== 1 || !urls[0]) throw new Error();
    const fetchUrl = git(cwd, ["remote", "get-url", "origin"]).toString("utf8").trimEnd();
    if (urls[0] !== fetchUrl) throw new Error();
    return { remote: "origin", url: fetchUrl };
  } catch {
    throw new PublicCheckError(69, "check:public: could not read destination refs");
  }
}

/** Read origin's advertised refs without sending repository content. */
export function readPushDestination(cwd: string): PushDestination {
  try {
    const { remote, url } = readPushRemote(cwd);
    const lines = git(cwd, ["ls-remote", "--quiet", "--", remote]).toString("utf8").split("\n").filter(Boolean);
    const refs = new Map<string, string>();
    for (const line of lines) {
      const match = /^([0-9a-f]{40,64})\t(HEAD|refs\/[^\s]+)$/.exec(line);
      if (!match?.[1] || !match[2]) throw new Error();
      refs.set(match[2], match[1]);
    }
    return { remote, url, refs };
  } catch {
    throw new PublicCheckError(69, "check:public: could not read destination refs");
  }
}

/** Check all history that this destination does not already advertise, independent of tracking refs. */
export function checkPublicPush(
  cwd: string,
  head: string,
  options: TermsOptions & { destination?: PushDestination; branch?: string } = {},
): PublicResult {
  const terms = loadPrivateTerms(cwd, process.env, options);
  const destination = options.destination ?? readPushDestination(cwd);
  const pinned = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${head}^{commit}`])
    .toString("utf8")
    .trim();
  const advertised = [...new Set(destination.refs.values())];
  const exclusions: string[] = [];
  if (advertised.length) {
    // Missing objects and non-commit tags are not exclusions. Peeled advertised tags supply their commits.
    const objects = git(cwd, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      input: `${advertised.join("\n")}\n`,
    });
    for (const line of objects.toString("utf8").split("\n")) {
      const match = /^([0-9a-f]{40,64}) commit$/.exec(line);
      if (match?.[1]) exclusions.push(`^${match[1]}`);
    }
  }
  const shas = git(cwd, ["rev-list", "--stdin"], { input: [pinned, ...exclusions, ""].join("\n") })
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  const hits = checkMessages(cwd, shas, terms, true);
  const seen = new Set<string>();
  const paths = new Set<string>();
  const notes = [...terms.notes];
  const newMarkers: string[] = [];
  const branch = options.branch ?? git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { missing: true }).toString("utf8").trim();
  const baseline = markerBaseline(cwd, destination, branch);
  for (const sha of shas) {
    const locations: string[] = [];
    hits.push(...checkChanged(cwd, ["--root", "-m", sha], terms, seen, paths, { locations, baseline }));
    newMarkers.push(...locations);
    for (const location of locations)
      notes.push(`note: new check-public allow marker at ${location} in commit ${sha.slice(0, 12)}`);
  }
  return { hits, notes, newMarkers };
}

/** Check the exact tree difference before land creates its squash commit. */
export function checkPublicChange(cwd: string, base: string, tree: string, options: TermsOptions = {}): PublicResult {
  const terms = loadPrivateTerms(cwd, process.env, options);
  return { hits: checkChanged(cwd, [base, tree], terms), notes: terms.notes };
}

function markerLines(buffer: Buffer): { text: string; key: string }[] {
  if (utf32Bom(buffer) || (buffer.includes(0) && !utf16Bom(buffer))) return [];
  if (utf16Bom(buffer)) {
    const encoding = buffer[0] === 0xff ? "utf-16le" : "utf-16be";
    return new TextDecoder(encoding).decode(buffer).split("\n").map((text) => ({ text, key: `${encoding}:${text}` }));
  }
  // Keep invalid UTF-8 bytes distinct: replacement characters must not make changed lines look approved.
  return buffer.toString("latin1").split("\n").map((bytes) => ({
    text: Buffer.from(bytes, "latin1").toString("utf8"),
    key: `bytes:${bytes}`,
  }));
}

function treeBlobs(cwd: string, tip: string): Map<string, string> {
  const tree = new Map<string, string>();
  for (const entry of nulBuffers(git(cwd, ["ls-tree", "-r", "-z", "--full-tree", tip]))) {
    const tab = entry.indexOf(9);
    const header = /^\d+ blob ([0-9a-f]{40,64})$/.exec(entry.subarray(0, tab).toString("ascii"));
    if (tab >= 0 && header?.[1]) tree.set(entry.subarray(tab + 1).toString("hex"), header[1]);
  }
  return tree;
}

/** Only the two advertised trees establish owner-approved marker lines, never local tracking refs.
 * A marker already present in that file on origin counts as known wherever it moves within the file.
 */
function markerBaseline(cwd: string, destination: PushDestination, branch: string): (file: Buffer) => Set<string> {
  let trees: Map<string, string>[] | undefined;
  const files = new Map<string, Set<string>>();
  return (file) => {
    const key = file.toString("hex");
    const cached = files.get(key);
    if (cached) return cached;
    if (!trees) {
      trees = [];
      const tips = [
        ["main", destination.refs.get("refs/heads/main")],
        ["branch", destination.refs.get(`refs/heads/${branch}`)],
      ] as const;
      const seen = new Set<string>();
      for (const [role, tip] of tips) {
        if (!tip || seen.has(tip)) continue;
        seen.add(tip);
        const object = git(cwd, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: `${tip}\n` }).toString("utf8").trim();
        if (object === `${tip} missing`) {
          try {
            git(cwd, ["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", "--", destination.remote, tip]);
          } catch {
            throw new PublicCheckError(69, `check:public: could not fetch origin's ${role} tip for the marker check`);
          }
        }
        trees.push(treeBlobs(cwd, tip));
      }
    }
    const lines = new Set<string>();
    for (const oid of new Set(trees.map((tree) => tree.get(key)))) {
      if (oid)
        for (const line of markerLines(git(cwd, ["cat-file", "blob", oid])))
          if (allowComment(line.text) >= 0) lines.add(line.key);
    }
    files.set(key, lines);
    return lines;
  };
}

function newAllowMarkers(
  buffer: Buffer,
  file: string,
  terms: PrivateTerms,
  approved: () => Set<string>,
): { key: string; location: string }[] {
  const candidates = markerLines(buffer).flatMap((line, index) =>
    allowComment(line.text) >= 0 ? [{ key: line.key, number: index + 1 }] : [],
  );
  if (!candidates.length) return [];
  const baseline = approved();
  const location = safeLocation(file, terms);
  return candidates.filter((line) => !baseline.has(line.key)).map((line) => ({ key: line.key, location: `${location}:${line.number}` }));
}

function checkChanged(
  cwd: string,
  revisions: string[],
  terms: PrivateTerms,
  seen = new Set<string>(),
  paths = new Set<string>(),
  markers?: { locations: string[]; baseline: (file: Buffer) => Set<string> },
): string[] {
  const entries = nulBuffers(
    git(cwd, [
      "diff-tree",
      "--raw",
      "-z",
      "--no-commit-id",
      "--no-abbrev",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "-r",
      "-t",
      ...revisions,
      "--",
    ]),
  );
  // Each changed commit counts its markers against origin's baseline, never against old blobs.
  const counted = new Set<string>();
  const hits: string[] = [];
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const [, mode, , oid = ""] = (entries[i]?.toString("utf8") ?? "").split(" ");
    const file = entries[i + 1] as Buffer;
    if (mode === "000000") continue;
    hits.push(...checkPath(file, terms, paths));
    if (mode === "040000" || mode === "160000") continue;
    if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new PublicCheckError(1, "check:public: could not read changed files");
    const key = `${oid}:${file.toString("hex")}`;
    const buffer = git(cwd, ["cat-file", "blob", oid]);
    const location = pathLocation(file, terms);
    if (markers) {
      const pathKey = file.toString("hex");
      for (const marker of newAllowMarkers(buffer, location, terms, () => markers.baseline(file))) {
        const markerKey = `${pathKey}:${marker.key}`;
        if (!counted.has(markerKey)) {
          counted.add(markerKey);
          markers.locations.push(marker.location);
        }
      }
    }
    if (!seen.has(key)) {
      seen.add(key);
      hits.push(...checkBuffer(buffer, location, terms, false));
    }
  }
  return hits;
}

function main(args: string[]): number {
  try {
    const files: string[] = [];
    const texts: string[] = [];
    let range: string | undefined;
    let head: string | undefined;
    let root: string | undefined;
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i] ?? "";
      const value = args[i + 1];
      if (
        value === undefined ||
        !["--file", "--text", "--commits", "--push", "--root"].includes(flag) ||
        (flag !== "--text" && (!value || value.startsWith("--")))
      ) {
        throw new PublicCheckError(
          2,
          "usage: node scripts/check-public.ts [--root <dir>] [--file <path> | --text <text>]... | --commits <range> | --push <head>",
        );
      }
      if (flag === "--file") files.push(value);
      if (flag === "--text") texts.push(value);
      if (flag === "--root") {
        if (root !== undefined) throw new PublicCheckError(2, "check:public: duplicate root option");
        root = path.resolve(value);
      }
      if (flag === "--commits" || flag === "--push") {
        if (range !== undefined || head !== undefined)
          throw new PublicCheckError(2, "check:public: expected one revision mode");
        if (flag === "--commits") range = value;
        else head = value;
      }
    }
    const explicit = files.length > 0 || texts.length > 0;
    if (explicit && (range !== undefined || head !== undefined))
      throw new PublicCheckError(2, "check:public: commit and text modes cannot be combined");
    const result =
      head !== undefined
        ? checkPublicPush(process.cwd(), head, { root, requireTerms: true })
        : checkPublic({
            cwd: process.cwd(),
            root,
            requireTerms: explicit,
            ...(explicit ? { files, texts } : {}),
            commits: range,
          });
    for (const note of result.notes) process.stderr.write(`${note}\n`);
    for (const hit of result.hits) process.stderr.write(`${hit}\n`);
    return result.hits.length > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof PublicCheckError ? error.message : "check:public: check failed"}\n`);
    return error instanceof PublicCheckError ? error.code : 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
