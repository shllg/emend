// Public-content checks shared by the local/CI gate and bin/wt. Diagnostics contain locations and
// rule labels only: never echo content, git errors, private terms or the command's arguments.
// In default/push files, a trailing allow comment on a line of at most 300 characters exempts
// generic rules except secrets (a bare private-key header may be exempted). Terms and overlong
// combining-mark runs are never exempted.
// Scope: the gate finds private data that tools and people write by accident, in the encodings they
// use (plain text, percent and entity encoding with semicolons, CSS and JSON escapes, base64 data
// URIs, image and font metadata, compressed streams). It does not defeat a writer who chooses an
// encoding or escape to dodge it.
// Authorization headers are matched in raw text, not the percent-decoded view; percent-encoded headers are out of scope.
import { isAscii, isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { brotliDecompressSync, inflateSync } from "node:zlib";

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
  code: number | "PRIVATE_TERMS_MISSING";
  exitCode: number;
  constructor(exitCode: number, message: string, code: number | "PRIVATE_TERMS_MISSING" = exitCode) {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
  }
}

interface Rule {
  label: string;
  pattern: RegExp;
  joinedPattern?: RegExp;
  piecePattern?: RegExp;
  allowed?: (match: RegExpExecArray, hostArguments?: Set<number>) => boolean;
  noLineExemption?: boolean;
  privateKeyHeader?: boolean;
  requireKeyBody?: boolean;
}

// Patterns and synthetic exceptions are assembled from parts so source files do not match themselves.
const HOME_NAMES = new Set(["someone", "user", "runner", "shared", "node", "me", "settings"]);
const ADDRESS_HELP = " (use 192.0.2.x or 2001:db8:: for documentation)";
const IP_EXCEPTIONS = new Set(
  [
    [10, 1, 2, 3],
    [100, 64, 0, 1],
    [100, 100, 100, 100],
    [192, 168, 0, 1],
    [192, 168, 1, 1],
    [10, 0, 0, 1],
    [172, 16, 0, 1],
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
const HOME_USER = "(<[^<>/\\\\\\s]+>|\\$\\{[^{}/\\\\\\s]+\\}|\\$[A-Za-z_][A-Za-z0-9_]*|~|[^/\\\\\\s\"'`<>,;:!?()\\[\\]{}]+)";
function homePlaceholder(match: RegExpExecArray): boolean {
  const name = (match[1] ?? "").replace(/[.,;:\-_)"']+$/, "");
  return HOME_NAMES.has(name.toLowerCase()) || /^\d+$/.test(name) || /^(?:<.*>|\$[\s\S]+|~)$/.test(name);
}

/** Tokenize each command line once, retaining positions that can be host arguments. */
function commandHostArguments(text: string, budget: ScanBudget): Set<number> {
  budget.spend(Buffer.byteLength(text));
  const positions = new Set<number>();
  let active = false, argument = false, end = 0;
  for (let at = 0; at < text.length;) {
    while (at < text.length && /\s/u.test(text[at] ?? "")) at++;
    if (at === text.length) break;
    const start = at;
    if (/[\r\n\u2028\u2029]/u.test(text.slice(end, start))) active = argument = false;
    let quote = "";
    while (at < text.length) {
      const char = text[at] ?? "";
      if (/[\r\n\u2028\u2029]/u.test(char) || (!quote && /\s/u.test(char))) break;
      if (char === "\\" && at + 1 < text.length && !/[\r\n\u2028\u2029]/u.test(text[at + 1] ?? "")) at += 2;
      else {
        if (quote === char) quote = "";
        else if (!quote && active && (char === '"' || char === "'")) quote = char;
        at++;
      }
    }
    const word = text.slice(start, at);
    if (active) positions.add(start);
    const command = /^["'`]?(?:Host|HostName|ssh|ping|curl|scp|rsync|mosh|server|ProxyJump)(?::(.*))?$/i.exec(word);
    if (command) {
      if (command[1]) positions.add(start + word.indexOf(":") + 1);
      active = !command[1];
      argument = false;
    } else if (active && !argument && word.startsWith(":")) {
      if (word.length > 1) positions.add(start + 1);
      active = word === ":";
    } else if (active && word === "--") argument = false;
    else if (active && /^--?[a-z0-9]/i.test(word)) {
      // Attached short values and --option=value are already part of this token.
      argument = !word.includes("=") && (word.startsWith("--") || word.length === 2);
    } else if (active && argument && (/^[a-z0-9./~:=@,+_-]+$/i.test(word) || /["']/.test(word))) argument = false;
    else active = argument = false;
    end = at;
  }
  return positions;
}
const RULES: Rule[] = [
  {
    label: "real home path",
    pattern: new RegExp(
      [
        "(?<![A-Za-z0-9._-])(?:/(?:usr/ho",
        "me|export/ho",
        "me|var/ho",
        "me|ho",
        "me|Us",
        "ers)/)", HOME_USER,
      ].join(""),
      "g",
    ),
    allowed: homePlaceholder,
  },
  {
    label: "real home path",
    pattern: new RegExp(
      [
        "(?<![A-Za-z0-9._-])(?:/mnt/[a-z]/Us",
        "ers/|/System/Volumes/Data/Us",
        "ers/|[A-Za-z]:\\\\{1,2}Us",
        "ers\\\\{1,2}|\\\\{2,4}wsl\\.localhost\\\\{1,2}[^\\\\\\s]+\\\\{1,2}ho",
        "me\\\\{1,2})", HOME_USER,
      ].join(""),
      "gi",
    ),
    allowed: homePlaceholder,
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
    label: "LAN host name",
    pattern: new RegExp(
      ["(?<![a-z0-9_.$-])", domainLabel, "(?:\\.", domainLabel, "){0,8}",
        "\\.(?:lan|local|internal|home\\.arpa|corp)(?![a-z0-9_-]|\\.(?![\\s/:\\x22\\x27)\\x60]|$))"].join(""),
      "gi",
    ),
    allowed: (match, hostArguments) => {
      if (match[0].split(".")[0]?.toLowerCase() === "example") return true;
      if (!/\.(?:local|internal)$/i.test(match[0])) return false;
      if (/[-0-9]/.test(match[0])) return false;
      const text = match.input;
      const after = text.slice(match.index + match[0].length);
      const quote = text[match.index - 1];
      const hostWord = hostArguments?.has(match.index);
      const hostContext = text.slice(Math.max(0, match.index - 3), match.index) === "://" || quote === "@" || quote === "=" ||
        /^\.?:([0-9]+(?:\b|$)|[\/~])/.test(after) ||
        ((quote === '"' || quote === "'" || quote === "`") && (after.startsWith(quote) || after.startsWith("." + quote))) ||
        hostWord;
      return !hostContext;
    },
  },
  {
    label: "private or tailnet IPv4 address" + ADDRESS_HELP,
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
    label: "private or tailnet IPv6 address" + ADDRESS_HELP,
    pattern: new RegExp(
      ["(?:(?<![a-z0-9_:])", "(?:f[cd][a-f0-9]{2}|fe[89ab][a-f0-9])",
        ":[a-f0-9:]+(?:(?:\\.[0-9]{1,3}){3})?", "(?![a-z0-9_:]|\\.[0-9])|(?<![a-f0-9:])", ["fd7a", "115c", "a1e0", ""].join(":"), ")"].join(""),
      "gi",
    ),
    allowed: (match) => !match[0].toLowerCase().startsWith(["fd7a", "115c", "a1e0", ""].join(":")) &&
      [match[0], match[0].replace(/:+$/, ""), match[0].replace(/:\d{1,5}$/, "")].every((value) => isIP(value) !== 6),
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
        "|\\btskey",
        "-[A-Za-z]+-[A-Za-z0-9_-]+",
        "|AGE-SECRET-", "KEY-1[A-Z0-9]{50,}",
        "|age-secret-", "key-1[a-z0-9]{50,}",
      ].join(""),
      "g",
    ),
  },
  {
    label: "secret shape",
    noLineExemption: true,
    pattern: new RegExp(["(?<![A-Za-z0-9_])em", "[sp]?_", "[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])"].join(""), "g"),
    // Joining lines must not erase token boundaries supplied by a newline.
    joinedPattern: new RegExp(["em", "[sp]?_", "[A-Za-z0-9_-]{43}"].join(""), "g"),
    // A token can cross one piece boundary and end at another. Keep its exact data length.
    piecePattern: new RegExp(["(?<![A-Za-z0-9_])e\\n*m\\n*(?:[sp]\\n*)?_\\n*",
      "[A-Za-z0-9_-](?:\\n*[A-Za-z0-9_-]){42}(?![A-Za-z0-9_-])"].join(""), "g"),
  },
  {
    label: "secret shape",
    noLineExemption: true,
    pattern: /\bauthorization["'`]?[ \t]*:[ \t]*["'`]?bearer[ \t]+["'`]?(?=[A-Za-z0-9._~+/-]{24})([A-Za-z0-9._~+/-]+=*)/gi,
    allowed: (match) => !literalToken(match[1] ?? ""),
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

/** Repeated test values and symbolic placeholders carry no literal credential entropy. */
function literalToken(value: string): boolean {
  // Very large header values are literal; do not run placeholder repetitions on unbounded input.
  if (value.length > 4096) return true;
  if (value.length < 24 || /^(?:<[^<>]*>|\$\{[^{}]*\}|\$[a-z_][a-z0-9_]*)$/i.test(value) ||
    /^(?:(?:redacted|placeholder|your|example|dummy|sample|token|api|access|bearer|key|secret|here)[_-]*)+$/i.test(value)) return false;
  // A period must repeat the first half. Native substring search avoids a per-character table.
  const period = value.indexOf(value.slice(0, Math.ceil(value.length / 2)), 1);
  if (period > 0 && period <= value.length / 2 && value.slice(period) === value.slice(0, -period)) return false;
  // A single-class alphabetic or decimal sequence is a documentation placeholder.
  if (/^(?:[a-z]+|[A-Z]+|[0-9]+)$/.test(value)) {
    const alphabet = /^[0-9]/.test(value) ? "0123456789" : "abcdefghijklmnopqrstuvwxyz";
    const folded = value.toLowerCase();
    if ([alphabet, [...alphabet].reverse().join("")].some((sequence) => {
      const at = sequence.indexOf(folded[0] ?? "");
      for (let index = 0; index < folded.length; index++)
        if (folded[index] !== sequence[(at + index) % sequence.length]) return false;
      return true;
    })) return false;
  }
  return true;
}
const EMAIL_RULE = RULES.find((rule) => rule.label === "email address") as Rule;
const IDENTITY_NOREPLY = new RegExp(["^(?:noreply", "@github\\.com|[^@\\s]+@users\\.noreply\\.github\\.com)$"].join(""), "i");
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
    if (["fetch", "ls-remote"].includes(args[0] ?? "")) delete env.GIT_NO_LAZY_FETCH;
    else env.GIT_NO_LAZY_FETCH = "1";
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
        "PRIVATE_TERMS_MISSING",
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
  start: (at: number) => number;
  end: (at: number) => number;
}

const STARTS_WITH_MARK = /^\p{M}/u;
const combiningCodePoints = new Map<string, boolean>();

function countsAsCombining(character: string): boolean {
  let combining = combiningCodePoints.get(character);
  if (combining === undefined) {
    combining = STARTS_WITH_MARK.test(character) || STARTS_WITH_MARK.test(character.normalize("NFKD"));
    combiningCodePoints.set(character, combining);
  }
  return combining;
}

/** Reject before normalization; ASCII runs cannot contain combining marks. */
function combiningMarkRuns(text: string): Match[] {
  const runs: Match[] = [];
  let count = 0, start = 0, end = 0;
  const flush = () => {
    if (count > 32) runs.push({ start, end, label: "combining-mark run" });
    count = 0;
  };
  for (const match of text.matchAll(/[^\x00-\x7f]/gu)) {
    if (match.index !== end) flush();
    if (countsAsCombining(match[0])) {
      if (!count) start = match.index;
      count++;
    } else flush();
    end = match.index + match[0].length;
  }
  flush();
  return runs;
}

interface TextEdit {
  start: number;
  end: number;
  value: string;
}

/** Store only transformations, never a pair of offsets for every source character. */
function rewrite(input: Normalized, changes: Iterable<TextEdit>): Normalized {
  const edits: { start: number; end: number; sourceStart: number; sourceEnd: number }[] = [];
  const chunks: string[] = [];
  let pieces: string[] = [];
  let pieceSize = 0;
  const append = (text: string) => {
    if (!text) return;
    pieces.push(text);
    pieceSize += text.length;
    if (pieces.length >= 4096 || pieceSize >= 64 * 1024) {
      chunks.push(pieces.join(""));
      pieces = [];
      pieceSize = 0;
    }
  };
  let sourceAt = 0, outputAt = 0;
  let changed = false;
  for (const change of changes) {
    if (input.text.slice(change.start, change.end) === change.value) continue;
    changed = true;
    const unchanged = input.text.slice(sourceAt, change.start);
    append(unchanged);
    append(change.value);
    outputAt += unchanged.length;
    const previous = edits.at(-1);
    if (!change.value && previous?.sourceEnd === change.start && previous.start === previous.end) {
      previous.sourceEnd = change.end;
    } else if (change.end - change.start !== change.value.length || change.end - change.start > 1) {
      edits.push({ start: outputAt, end: outputAt + change.value.length, sourceStart: change.start, sourceEnd: change.end });
    }
    outputAt += change.value.length;
    sourceAt = change.end;
  }
  if (!changed) return input;
  append(input.text.slice(sourceAt));
  if (pieces.length) chunks.push(pieces.join(""));
  const starts = edits.map((edit) => edit.start);
  const offset = (at: number, end: boolean): number => {
    const edit = edits[preceding(starts, at)];
    if (!edit) return at;
    if (at < edit.end) return end && at > edit.start ? edit.sourceEnd : edit.sourceStart;
    return at + edit.sourceEnd - edit.end;
  };
  return {
    text: chunks.join(""),
    start: (at) => input.start(offset(at, false)),
    end: (at) => input.end(offset(at, true)),
  };
}

const TERM_ESCAPE = /(?:%[a-f0-9]{2})+|&(?:nbsp|quot|apos|#(?:32|160|34|39|x20|xa0|x22|x27));/i;
const TERM_NORMALIZATION = new RegExp(`${TERM_ESCAPE.source}|[^\\x00-\\x7f]`, "giu");
const MAIN_TERM_NORMALIZATION = /%20|&(?:nbsp|quot|apos|#(?:32|160|34|39|x20|xa0|x22|x27));|[^\x00-\x7f]/giu;

/** Optionally decode, strip invisibles and marks, then fold case, quotes and whitespace. */
function normalizeText(input: string, location = "private terms list", budget = new ScanBudget(), decodeEscapes: boolean | "main" = true, binaryView = false): Normalized {
  if (!binaryView && combiningMarkRuns(input).length) throw new PublicCheckError(1, location + ": combining-mark run");
  const decoded: Record<string, string> = {
    "%20": " ", "&nbsp;": " ", "&#32;": " ", "&#160;": " ", "&#x20;": " ", "&#xa0;": " ",
    "&quot;": '"', "&#34;": '"', "&#x22;": '"', "&apos;": "'", "&#39;": "'", "&#x27;": "'",
  };
  function* decode(): Generator<TextEdit> {
    let sourceAt = 0;
    const pattern = decodeEscapes === "main" ? MAIN_TERM_NORMALIZATION : decodeEscapes ? TERM_NORMALIZATION : /[^\x00-\x7f]/gu;
    for (const match of input.matchAll(pattern)) {
      const original = match[0];
      let plain = decoded[original.toLowerCase()] ?? original;
      if (original[0] === "%" && plain === original) {
        if (original.length === 3) {
          const byte = Number.parseInt(original.slice(1), 16);
          plain = byte < 128 ? String.fromCharCode(byte) : "\ufffd";
        } else {
          // Reserve the byte buffer and its worst-case UTF-8 replacement view before allocation.
          budget.spend(original.length / 3 * 4);
          const bytes = Buffer.allocUnsafe(original.length / 3);
          for (let at = 0; at < bytes.length; at++) bytes[at] = Number.parseInt(original.slice(at * 3 + 1, at * 3 + 3), 16);
          plain = bytes.toString("utf8");
        }
      }
      const value = plain
        .replace(/\p{Default_Ignorable_Code_Point}/gu, "").normalize("NFKD").replace(/\p{M}/gu, "");
      // Reserve the normalized bytes before rewrite allocates the expanded view or its offsets.
      budget.spend(Buffer.byteLength(input.slice(sourceAt, match.index)) + Buffer.byteLength(value.toLowerCase()));
      sourceAt = match.index + original.length;
      yield { start: match.index, end: match.index + original.length, value };
    }
    // Pure ASCII text is charged in full by design, as is the tail after the final decoded character.
    budget.spend(Buffer.byteLength(input.slice(sourceAt)));
  }
  let result = rewrite({ text: input, start: (at) => at, end: (at) => at }, decode());
  const lower = result.text.toLowerCase(); // Preserve contextual final sigma.
  if (lower.length !== result.text.length) {
    const before = result.text;
    function* fold(): Generator<TextEdit> {
      for (const match of before.matchAll(/[^\x00-\x7f]/gu))
        yield { start: match.index, end: match.index + match[0].length, value: match[0].toLowerCase() };
    }
    result = rewrite(result, fold());
  }
  result = { ...result, text: lower.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[\u2010-\u2015\u2212]/g, "-") };
  const folded = result.text;
  function* whitespace(): Generator<TextEdit> {
    const spaces = /\s+/gu;
    for (let match = spaces.exec(folded); match; match = spaces.exec(folded)) {
      let end = match.index + match[0].length;
      if (/[\r\n\u2028\u2029]/u.test(match[0])) {
        const leader = ["//", "#", "*", ">", "--", ";"].find((value) => folded.startsWith(value, end));
        if (leader) {
          end += leader.length;
          while (end < folded.length && /\s/u.test(folded[end] ?? "")) end++;
        }
      }
      spaces.lastIndex = end;
      yield { start: match.index, end, value: " " };
    }
  }
  return rewrite(result, whitespace());
}
function occurrences(text: string, value: string, budget: ScanBudget, decodeEscapes: boolean | "main" = true): { start: number; end: number }[] {
  const spellings = [normalizeText(value, undefined, budget).text.trim()];
  // Keep encoded configuration working on plain text; literal views also retain exact escaped phrases.
  if (!decodeEscapes && TERM_ESCAPE.test(value)) spellings.push(normalizeText(value, undefined, budget, false).text.trim());
  if (decodeEscapes === "main" && TERM_ESCAPE.test(value)) spellings.push(normalizeText(value, undefined, budget, "main").text.trim());
  return [...new Set(spellings)].filter(Boolean).flatMap((normalized) => {
    const pattern = normalized
      .split(/ +/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s_-]{0,4}");
    return [...text.matchAll(new RegExp(`(?=(${pattern}))`, "gu"))].map((match) => ({
      start: match.index,
      end: match.index + (match[1]?.length ?? 0),
    }));
  });
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
  const escape = /\\\/|\\u002[bf]|&#(?:x2[bf]|43|47);|&(?:sol|plus);/giy;
  const addLine = (start: number, end: number) => {
    while (headerAt < headers.length && (headers[headerAt]?.index ?? Infinity) <= end) {
      headerLines.push(nonblank);
      headerAt++;
    }
    let runStart = start;
    let runLength = 0;
    let lower = false, upper = false, digit = false, symbol = false;
    for (let at = start; at <= end; at++) {
      let char = at < end ? (text[at] ?? "") : "";
      let width = 1;
      if (char === "\\" || char === "&") {
        escape.lastIndex = at;
        const encoded = escape.exec(text)?.[0];
        if (encoded && at + encoded.length <= end) {
          char = /(?:\/|f|47|sol)/i.test(encoded) ? "/" : "+";
          width = encoded.length;
        }
      }
      const isLower = char >= "a" && char <= "z";
      const isUpper = char >= "A" && char <= "Z";
      const isDigit = char >= "0" && char <= "9";
      const isSymbol = char === "+" || char === "/";
      if (isLower || isUpper || isDigit || isSymbol || char === "=") {
        runLength++;
        lower ||= isLower;
        upper ||= isUpper;
        digit ||= isDigit;
        symbol ||= isSymbol;
      } else {
        if (runLength >= 40 && (symbol || (lower && upper && digit)))
          runs.push({ start: runStart, end: at, line: nonblank });
        runStart = at + 1;
        runLength = 0;
        lower = upper = digit = symbol = false;
      }
      at += width - 1;
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

/** Each alphabet run is visited once, including arbitrarily long JWT claims in joined diagnostics. */
function* jwtMatches(text: string, joined: boolean): Generator<Match> {
  let candidate: { start: number; end: number; claim: boolean } | undefined;
  for (const run of text.matchAll(/[A-Za-z0-9_-]+/g)) {
    const value = run[0];
    const end = run.index + value.length;
    if (candidate && run.index === candidate.end + 1 && text[candidate.end] === ".") {
      if (candidate.claim && value.length >= 16) {
        yield { start: candidate.start, end, label: "secret shape" };
        candidate = undefined;
        continue;
      }
      if (!candidate.claim && value.startsWith("eyJ") && value.length >= 7) {
        candidate = { ...candidate, end, claim: true };
        continue;
      }
    }
    const prefix = joined ? value.indexOf("eyJ") : value.startsWith("eyJ") ? 0 : -1;
    candidate = prefix >= 0 && value.length - prefix >= 7 ? { start: run.index + prefix, end, claim: false } : undefined;
  }
}

function matches(
  text: string,
  terms: PrivateTerms,
  attribution: boolean,
  lineExemptions = false,
  starts = lineStarts(text),
  generic = true,
  joinedSecrets = false,
  budget = new ScanBudget(),
  decodedView?: Normalized | false,
  sourceExempt?: (at: number) => boolean,
  pieceSecrets = false,
  binaryView = false,
): Match[] {
  const overlong = binaryView ? [] : combiningMarkRuns(text);
  if (overlong.length) return overlong;
  const found: Match[] = [];
  if (generic) {
    let hostArguments: Set<number> | undefined;
    const bodies = keyBodies(text);
    const exempt = new Set<number>();
    if (lineExemptions) {
      for (const [line, start] of starts.entries()) {
        const end = starts[line + 1] === undefined ? text.length : (starts[line + 1] as number) - 1;
        if (allowComment(text.slice(start, end)) >= 0) exempt.add(line);
      }
    }
    const isExempt = sourceExempt ?? ((at: number) => exempt.has(preceding(starts, at)));
    // A URL exempts only the email-shaped user-info/host pair in its own authority.
    const urls = [...text.matchAll(URL_USERINFO)].map((url) => ({
      start: url.index + (url[1]?.length ?? 0) + 1,
      end: url.index + url[0].length,
    }));
    let urlIndex = 0;
    for (const rule of attribution ? [...RULES, ATTRIBUTION] : RULES) {
      // Line joins erase word boundaries; retain each secret rule's token alphabet and length.
      const pattern = pieceSecrets ? rule.piecePattern ?? rule.pattern : joinedSecrets && rule.label === "secret shape"
        ? rule.joinedPattern ?? new RegExp(rule.pattern.source.replaceAll("\\b", ""), rule.pattern.flags)
        : rule.pattern;
      for (const match of text.matchAll(pattern)) {
        if (rule.label === "LAN host name") hostArguments ??= commandHostArguments(text, budget);
        const bodyEnd = rule.privateKeyHeader ? bodies.get(match.index) : undefined;
        if (rule.requireKeyBody && bodyEnd === undefined) continue;
        if (!rule.noLineExemption && bodyEnd === undefined && isExempt(match.index)) continue;
        if (rule.label === "email address") {
          while (urlIndex < urls.length && (urls[urlIndex]?.end ?? 0) <= match.index) urlIndex++;
          const url = urls[urlIndex];
          if (url && match.index >= url.start && match.index + match[0].length <= url.end) continue;
        }
        // A line fragment may already be literal; a joined placeholder must not expose its suffix.
        if ((joinedSecrets && rule.label === "secret shape") || !rule.allowed?.(match, hostArguments))
          found.push({ start: match.index, end: bodyEnd ?? match.index + match[0].length, label: rule.label });
      }
    }
    found.push(...jwtMatches(text, joinedSecrets));
    for (const hit of decodedHomeMatches(text))
      if (!isExempt(hit.start)) found.push(hit);
    const decoded = decodedView === undefined ? decodedEscapeView(text, budget) : decodedView;
    if (decoded) {
      // Exemptions belong to the source line; decoded markers cannot introduce new exemptions.
      for (const hit of matches(decoded.text, terms, attribution, false, undefined, true, joinedSecrets, budget, false,
        (at) => isExempt(decoded.start(at)), pieceSecrets, binaryView)) {
        found.push({ ...hit, start: decoded.start(hit.start), end: decoded.end(hit.end) });
      }
    }
  }
  // Preserve main's %20/entity normalization as well as literal and fully decoded readings.
  // All views share the budget; without escapes in text or configuration they are identical.
  const views: (boolean | "main")[] = TERM_ESCAPE.test(text) || terms.terms.some((term) => TERM_ESCAPE.test(term.value)) ||
    terms.allowed.some((value) => TERM_ESCAPE.test(value)) ? [false, "main", true] : [false];
  for (const decodeEscapes of views) {
    const normalized = normalizeText(text, undefined, budget, decodeEscapes, binaryView);
    if (!terms.terms.length) continue;
    const allowed = terms.allowed
      .flatMap((value) => occurrences(normalized.text, value, budget, decodeEscapes))
      .sort((a, b) => a.start - b.start);
    const allowedStarts = allowed.map((span) => span.start);
    const allowedEnds: number[] = [];
    for (const span of allowed) allowedEnds.push(Math.max(allowedEnds.at(-1) ?? 0, span.end));
    for (const term of terms.terms) {
      for (const span of occurrences(normalized.text, term.value, budget, decodeEscapes)) {
        if ((allowedEnds[preceding(allowedStarts, span.start)] ?? -1) >= span.end) continue;
        found.push({
          start: normalized.start(span.start),
          end: normalized.end(span.end),
          label: `private term (${term.source ?? "file"} line ${term.line})`,
        });
      }
    }
  }
  return [...new Map(found.map((hit) => [`${hit.start}:${hit.end}:${hit.label}`, hit])).values()].sort((a, b) => a.start - b.start);
}

/** Decode small overlapping windows, retaining source offsets without whole-file edit arrays. */
function* decodedHomeMatches(text: string): Generator<Match> {
  // Whitespace escapes in large inline assets cannot introduce a home-path root.
  if (!/%(?:2f|5c)|&(?:sol|bsol|#(?:0*47|0*92|x0*2f|x0*5c));|[\/\\][a-z0-9._-]{0,64}(?:%[a-f0-9]{2}|&#)/i.test(text)) return;
  const escapes = /%[a-f0-9]{2}|&(?:#(?:x[a-f0-9]+|[0-9]+)|sol|bsol|colon|period);/gi;
  let covered = 0;
  for (const escape of text.matchAll(escapes)) {
    if (escape.index < covered) continue;
    const start = Math.max(0, escape.index - 512);
    const end = Math.min(text.length, escape.index + 4096);
    const source = text.slice(start, end);
    covered = end - (end < text.length ? 512 : 0);
    function* edits(): Generator<TextEdit> {
      for (const match of source.matchAll(/(?:%[a-f0-9]{2})+|&(?:#(?:x[a-f0-9]+|[0-9]+)|sol|bsol|colon|period);/gi)) {
        let value: string;
        if (match[0].startsWith("%")) {
          try { value = decodeURIComponent(match[0]); }
          catch { value = Buffer.from(match[0].replaceAll("%", ""), "hex").toString("latin1"); }
        } else {
          const entity = match[0].slice(1, -1).toLowerCase();
          const named: Record<string, string> = { sol: "/", bsol: "\\", colon: ":", period: "." };
          const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
          value = named[entity] ?? (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match[0]);
        }
        yield { start: match.index, end: match.index + match[0].length, value };
      }
    }
    const decoded = rewrite({ text: source, start: (at) => at, end: (at) => at }, edits());
    for (const rule of RULES.filter((rule) => rule.label === "real home path"))
      for (const match of decoded.text.matchAll(rule.pattern))
        if (!rule.allowed?.(match)) yield {
          start: start + decoded.start(match.index), end: start + decoded.end(match.index + match[0].length), label: rule.label,
        };
  }
}

// A filename itself can contain private content or terminal controls. Redact it as well.
function safeLocation(location: string, terms: PrivateTerms): string {
  // An overlong run prevents term normalization; redact the whole location, not just its marks.
  if (combiningMarkRuns(location).length) return "<redacted path>";
  let spans: Match[];
  try { spans = matches(location, { ...terms, allowed: [] }, true, false); }
  catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    return "<redacted path>";
  }
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
  if (new RegExp(BODY_KEY_HEADER.source).test(text) || new RegExp(["AGE-SECRET-", "KEY-1"].join(""), "i").test(text))
    return "secret shape";
  return undefined;
}

/** Original source spans for diagnostics that must withhold every line touched by a hit. */
export function checkTextSpans(text: string, terms: PrivateTerms, joinedSecrets = false, budget = new ScanBudget()): Match[] {
  try { return matches(text, terms, true, false, undefined, true, joinedSecrets, budget); }
  catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    return [{ start: 0, end: text.length, label: "scan expansion budget exceeded" }];
  }
}

export function checkText(
  text: string,
  location: string,
  terms: PrivateTerms,
  options: { attribution?: boolean; lines?: boolean; columns?: boolean; lineExemptions?: boolean; generic?: boolean; imageDepth?: number; budget?: ScanBudget; pieceSecrets?: boolean; binaryView?: boolean } = {},
): string[] {
  if (!options.budget) {
    try { return checkText(text, location, terms, { ...options, budget: new ScanBudget() }); }
    catch (error) {
      if (!(error instanceof BudgetExceeded)) throw error;
      return [safeLocation(location, terms) + ": scan expansion budget exceeded"];
    }
  }
  const safe = safeLocation(location, terms);
  const starts = lineStarts(text);
  const decoded = options.generic === false ? undefined : decodedEscapeView(text, options.budget);
  const hits = matches(text, terms, options.attribution ?? true, options.lineExemptions, starts, options.generic, false, options.budget, decoded ?? false, undefined, options.pieceSecrets, options.binaryView).map(
    (match) => {
      const index = preceding(starts, match.start);
      const line = options.lines || options.columns ? `:${index + 1}` : "";
      const column = options.columns ? `:${match.start - (starts[index] ?? 0) + 1}` : "";
      return `${safe}${line}${column}: ${match.label}`;
    },
  );
  if (options.generic !== false) hits.push(...checkInlineImages(text, safe, terms, options.imageDepth ?? 0, options.budget, decoded));
  return hits;
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

/** Payload signatures select parsers even when the MIME declaration is generic or misleading. */
function inlineAssetType(buffer: Buffer, budget: ScanBudget): string | undefined {
  for (const [extension, signatures] of Object.entries(BINARY_MAGIC))
    if (signatures.some((prefix) => buffer.subarray(0, prefix.length).equals(prefix))) return extension.slice(1);
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  const prefix = buffer.subarray(0, 12).toString("latin1");
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "gif";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return "webp";
  const header = buffer.subarray(0, 4096);
  budget.spend(header.length);
  if (/<svg(?:[\s/>])/i.test(header.toString("latin1"))) return "svg";
  return undefined;
}

/** Recognize early ends, not arbitrary corrupt bytes with an image signature. Bounded to small examples. */
function truncatedInlineImage(bytes: Buffer, budget: ScanBudget): { extension: string; complete: number } | undefined {
  if (!bytes.length || bytes.length >= 192) return undefined;
  budget.spend(bytes.length * 2);
  const prefix = (signature: Buffer) => bytes.subarray(0, signature.length).equals(signature.subarray(0, bytes.length));
  if (prefix(PNG_MAGIC)) {
    const truncated = (complete: number) => ({ extension: "png", complete });
    if (bytes.length < 8) return truncated(0);
    let at = 8;
    while (at < bytes.length) {
      const remaining = bytes.length - at;
      // A PNG starts with a 13-byte IHDR; reject impossible lengths/types even if its data is short.
      if (at === 8 && !bytes.subarray(at, at + 4).equals(Buffer.from([0, 0, 0, 13]).subarray(0, remaining))) return undefined;
      const kind = bytes.toString("latin1", at + 4, Math.min(at + 8, bytes.length));
      if (!/^[A-Za-z]*$/.test(kind) || (at === 8 && !"IHDR".startsWith(kind))) return undefined;
      if (remaining < 8) return truncated(at);
      const size = bytes.readUInt32BE(at);
      if (size > 0x7fffffff) return undefined;
      if (size + 12 > remaining) return truncated(at);
      if (kind === "IEND") return undefined; // Complete images keep every existing structural check.
      at += size + 12;
    }
    return truncated(at);
  }
  const truncated = (extension: string) => ({ extension, complete: 0 });
  if (prefix(Buffer.from([255, 216, 255]))) {
    if (bytes.length < 3) return truncated("jpg");
    let at = 2;
    while (at < bytes.length) {
      if (bytes[at++] !== 255) return undefined;
      while (bytes[at] === 255) at++;
      if (at === bytes.length) return truncated("jpg");
      const marker = bytes.readUInt8(at++);
      if (marker === 0xd9 || marker === 0xd8 || marker < 0xc0) return undefined;
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      if (bytes.length - at < 2) return truncated("jpg");
      const size = bytes.readUInt16BE(at);
      if (size < 2) return undefined;
      if (size > bytes.length - at) return truncated("jpg");
      at += size;
      // Once the scan begins, only an early end inside a segment qualifies here.
      if (marker === 0xda) return undefined;
    }
    return truncated("jpg");
  }
  if (prefix(Buffer.from("GIF87a")) || prefix(Buffer.from("GIF89a"))) {
    if (bytes.length < 6) return truncated("gif");
    if ((bytes.length >= 8 && !bytes.readUInt16LE(6)) || (bytes.length >= 10 && !bytes.readUInt16LE(8))) return undefined;
    if (bytes.length < 13) return truncated("gif");
    const colors = (packed: number) => packed & 128 ? 3 * (2 << (packed & 7)) : 0;
    let at = 13 + colors(bytes.readUInt8(10));
    if (at > bytes.length) return truncated("gif");
    while (at < bytes.length) {
      const kind = bytes[at++];
      if (kind === 0x3b) return undefined;
      if (kind === 0x21) {
        if (at === bytes.length) return truncated("gif");
        at++; // Extension label, followed by length-prefixed sub-blocks.
      } else if (kind === 0x2c) {
        if (bytes.length - at < 9) return truncated("gif");
        if (!bytes.readUInt16LE(at + 4) || !bytes.readUInt16LE(at + 6)) return undefined;
        at += 9 + colors(bytes.readUInt8(at + 8));
        if (at >= bytes.length) return truncated("gif");
        const codeSize = bytes.readUInt8(at++);
        if (codeSize < 2 || codeSize > 8) return undefined;
      } else return undefined;
      for (;;) {
        if (at >= bytes.length) return truncated("gif");
        const size = bytes[at++];
        if (!size) break;
        if (size > bytes.length - at) return truncated("gif");
        at += size;
      }
    }
    return truncated("gif");
  }
  if (prefix(Buffer.from("RIFF"))) {
    if (bytes.length < 8) return truncated("webp");
    const end = bytes.readUInt32LE(4) + 8;
    if (end < 12 || !bytes.subarray(8, 12).equals(Buffer.from("WEBP").subarray(0, bytes.length - 8))) return undefined;
    if (bytes.length < 12) return truncated("webp");
    if (end <= bytes.length) return undefined;
    let at = 12;
    while (at < bytes.length) {
      if (!/^[A-Za-z0-9 ]*$/.test(bytes.toString("latin1", at, Math.min(at + 4, bytes.length)))) return undefined;
      if (bytes.length - at < 8) return truncated("webp");
      const size = bytes.readUInt32LE(at + 4);
      const next = at + 8 + size + (size % 2);
      if (next > end) return undefined;
      if (next > bytes.length) return truncated("webp");
      at = next;
    }
    return truncated("webp");
  }
  return undefined;
}

/** Validate container framing before treating pixel data as opaque; keep metadata contiguous. */
function inlineImageMetadata(bytes: Buffer, extension: string | undefined, budget: ScanBudget): { metadata: Buffer[]; complete: boolean } {
  budget.spend(bytes.length);
  const metadata: Buffer[] = [];
  const chunks = new Map<string, Buffer[]>();
  let partial: Buffer[] = [];
  const join = (parts: Buffer[]) => { budget.spend(parts.reduce((size, part) => size + part.length, 0)); return Buffer.concat(parts); };
  const finish = (complete: boolean) => ({ complete, metadata: [...metadata, ...[...chunks.values(), partial].filter((parts) => parts.length).map(join)] });
  if (extension !== "gif" && extension !== "webp" && extension !== "jpg") return finish(false);
  if (extension === "gif") {
    if (bytes.length < 14 || !/^(?:GIF87a|GIF89a)$/.test(bytes.toString("latin1", 0, 6)) ||
      !bytes.readUInt16LE(6) || !bytes.readUInt16LE(8)) return finish(false);
    const colors = (packed: number) => packed & 128 ? 3 * (2 << (packed & 7)) : 0;
    let at = 13 + colors(bytes.readUInt8(10));
    while (at < bytes.length) {
      const kind = bytes[at++];
      if (kind === 0x3b) return finish(at === bytes.length);
      let text = false;
      if (kind === 0x21) {
        if (at >= bytes.length) return finish(false);
        const label = bytes[at++];
        text = label === 0xfe || label === 0xff || label === 0x01;
      } else if (kind === 0x2c) {
        if (bytes.length - at < 9 || !bytes.readUInt16LE(at + 4) || !bytes.readUInt16LE(at + 6)) return finish(false);
        at += 9 + colors(bytes.readUInt8(at + 8));
        if (at >= bytes.length || bytes[at]! < 2 || bytes[at]! > 8) return finish(false);
        at++;
      } else return finish(false);
      const parts: Buffer[] = [];
      if (text) partial = parts;
      for (;;) {
        if (at >= bytes.length) return finish(false);
        const size = bytes[at++]!;
        if (!size) break;
        if (size > bytes.length - at) return finish(false);
        if (text) parts.push(bytes.subarray(at, at + size));
        at += size;
      }
      if (text) { metadata.push(join(parts)); partial = []; }
    }
    return finish(false);
  }
  if (extension === "webp") {
    if (bytes.length < 20 || bytes.toString("latin1", 0, 4) !== "RIFF" ||
      bytes.toString("latin1", 8, 12) !== "WEBP") return finish(false);
    const declaredEnd = bytes.readUInt32LE(4) + 8;
    const endOfChunks = Math.min(bytes.length, declaredEnd);
    for (let at = 12; at < endOfChunks;) {
      if (endOfChunks - at < 8) return finish(false);
      const kind = bytes.toString("latin1", at, at + 4), size = bytes.readUInt32LE(at + 4);
      if (at === 12 && !["VP8 ", "VP8L", "VP8X"].includes(kind)) return finish(false);
      const end = at + 8 + size, next = end + size % 2;
      if (next > endOfChunks || (size % 2 && bytes[end] !== 0)) return finish(false);
      if (kind === "EXIF" || kind === "XMP ") {
        const parts = chunks.get(kind) ?? [];
        parts.push(bytes.subarray(at + 8, end)); chunks.set(kind, parts);
      }
      at = next;
    }
    return finish(declaredEnd === bytes.length);
  }
  // JPEG keeps its existing binary classification; COM segment boundaries must not hide text.
  const comments: Buffer[] = [];
  chunks.set("COM", comments);
  let entropy = false;
  for (let at = 2; at < bytes.length;) {
    if (entropy) {
      at = bytes.indexOf(255, at);
      if (at < 0) break;
    }
    if (bytes[at++] !== 255) break;
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 0xd9) return finish(at === bytes.length);
    if (marker === undefined || marker === 0xd8) break;
    if (entropy && marker === 0) continue; // Byte stuffing in compressed scan data.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (bytes.length - at < 2) break;
    const size = bytes.readUInt16BE(at);
    if (size < 2 || size > bytes.length - at) break;
    if (marker === 0xfe) comments.push(bytes.subarray(at + 2, at + size));
    at += size;
    entropy = marker === 0xda;
  }
  return finish(false);
}

/** PNG text chunks are small documents, including their keywords and translated keywords. */
function checkPng(buffer: Buffer, file: string, terms: PrivateTerms, depth: number, budget: ScanBudget): string[] {
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
      if (parts[0]?.trim().toLowerCase() === "raw profile type exif") hits.push(`${safeLocation(file, terms)}: binary metadata`);
      let text = data.subarray(separator + 1);
      budget.spend(parts[0]?.length ?? 0);
      if (kind === "zTXt") {
        if (text[0] !== 0) throw new Error();
        text = budget.inflate(text.subarray(1), false, 1024 * 1024);
      } else if (kind === "iTXt") {
        const compressed = text[0];
        if ((compressed !== 0 && compressed !== 1) || text[1] !== 0) throw new Error();
        const languageEnd = text.indexOf(0, 2);
        const translatedEnd = languageEnd < 0 ? -1 : text.indexOf(0, languageEnd + 1);
        if (languageEnd < 0 || translatedEnd < 0) throw new Error();
        parts.push(text.subarray(2, languageEnd).toString("utf8"));
        parts.push(text.subarray(languageEnd + 1, translatedEnd).toString("utf8"));
        text = text.subarray(translatedEnd + 1);
        if (compressed) text = budget.inflate(text, false, 1024 * 1024);
        else budget.spend(text.length);
        budget.spend((parts[1]?.length ?? 0) + (parts[2]?.length ?? 0));
      } else budget.spend(text.length);
      parts.push(text.toString(kind === "iTXt" ? "utf8" : "latin1"));
      hits.push(...checkText(parts.join("\n"), file, terms, { attribution: true, lineExemptions: false, imageDepth: depth, budget }));
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    hits.push(`${safeLocation(file, terms)}: invalid PNG text metadata`);
  }
  return hits;
}

// Same per-asset and aggregate bounds as the publish contract.
const ASSET_BYTES = 25 * 1024 * 1024;
const EXPANDED_BYTES = 50 * 1024 * 1024;

class BudgetExceeded extends PublicCheckError {
  constructor() { super(1, "check:public: scan expansion budget exceeded"); }
}

/** One owner for every expansion and decoded view in a top-level scan. */
export class ScanBudget {
  remaining: number;
  /** Deterministic terminator-search work, shared by nested inline assets and visible to tests. */
  inlineTerminatorWork = 0;
  /** Source work done after yielding the bounded join, excluding its already scanned prefix. */
  inlineHitOnlyWork = 0;
  constructor(bytes = EXPANDED_BYTES) { this.remaining = bytes; }
  spend(bytes: number): void {
    if (bytes > this.remaining) throw new BudgetExceeded();
    this.remaining -= bytes;
  }
  inflate(bytes: Buffer, brotli: boolean, maximum = this.remaining): Buffer {
    if (this.remaining <= 0) throw new BudgetExceeded();
    const maxOutputLength = Math.min(maximum, this.remaining);
    let result: Buffer;
    try { result = (brotli ? brotliDecompressSync : inflateSync)(bytes, { maxOutputLength }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" && this.remaining <= maximum) throw new BudgetExceeded();
      throw error;
    }
    this.spend(result.length);
    return result;
  }
}

/** Like strings(1), with no generic path/host matches in arbitrary binary bytes. */
function binarySecrets(buffer: Buffer, file: string, terms: PrivateTerms, budget: ScanBudget): string[] {
  const hits: string[] = [];
  for (const [width, offset, bigEndian] of [[1, 0, false], [2, 0, false], [2, 1, false], [2, 0, true], [2, 1, true]] as const) {
    let start = offset;
    for (let at = offset; at <= buffer.length; at += width) {
      const byte = at + width > buffer.length ? 0 : width === 1 ? (buffer[at] ?? 0) :
        bigEndian ? buffer.readUInt16BE(at) : buffer.readUInt16LE(at);
      if (byte >= 32 && byte <= 126) continue;
      if (at - start >= 20 * width) {
        budget.spend(at - start);
        const bytes = buffer.subarray(start, at);
        const text = width === 1 ? bytes.toString("ascii") : bigEndian ? new TextDecoder("utf-16be").decode(bytes) : bytes.toString("utf16le");
        for (const match of matches(text, { ...terms, terms: [] }, false, false, undefined, true, false, budget))
          if (match.label === "secret shape") hits.push(safeLocation(file, terms) + ": secret shape");
      }
      start = at + width;
    }
  }
  return hits;
}

/** OpenType name records use Unicode/Windows UTF-16BE or legacy platform encodings. */
function checkFontNames(data: Buffer, file: string, terms: PrivateTerms, depth: number, budget: ScanBudget): string[] {
  if (data.length < 6 || data.readUInt16BE(0) > 1) throw new Error();
  const count = data.readUInt16BE(2), storage = data.readUInt16BE(4);
  if (6 + count * 12 > storage || storage > data.length) throw new Error();
  const hits: string[] = [];
  for (let at = 6; at < 6 + count * 12; at += 12) {
    // Empty strings still cost a record visit and decoder setup.
    budget.spend(12);
    const platform = data.readUInt16BE(at), encoding = data.readUInt16BE(at + 2);
    const length = data.readUInt16BE(at + 8), offset = storage + data.readUInt16BE(at + 10);
    if (offset + length > data.length) throw new Error();
    let decoder: string;
    if (platform === 0 || (platform === 3 && [0, 1, 10].includes(encoding))) decoder = "utf-16be";
    else if (platform === 1 && encoding === 0) decoder = "macintosh";
    else if (platform === 2 && [0, 2].includes(encoding)) decoder = "windows-1252";
    else throw new Error();
    if (decoder === "utf-16be" && length % 2) throw new Error();
    const text = new TextDecoder(decoder, { fatal: true }).decode(data.subarray(offset, offset + length));
    budget.spend(Buffer.byteLength(text));
    hits.push(...checkText(text, file + " (font name)", terms, { lineExemptions: false, imageDepth: depth, budget }));
  }
  return hits;
}

/** TTF and OTF share the SFNT table directory and OpenType name-record layout. */
function checkSfnt(buffer: Buffer, file: string, terms: PrivateTerms, depth: number, budget: ScanBudget): string[] {
  const hits: string[] = [];
  try {
    if (buffer.length < 12) throw new Error();
    const count = buffer.readUInt16BE(4), directoryEnd = 12 + count * 16;
    if (directoryEnd > buffer.length) throw new Error();
    budget.spend(directoryEnd);
    const tags = new Set<number>();
    const tables: { tag: number; offset: number; length: number }[] = [];
    for (let at = 12; at < directoryEnd; at += 16) {
      const tag = buffer.readUInt32BE(at);
      const offset = buffer.readUInt32BE(at + 8), length = buffer.readUInt32BE(at + 12);
      if (tags.has(tag) || offset < directoryEnd || offset + length > buffer.length) throw new Error();
      tags.add(tag);
      tables.push({ tag, offset, length });
    }
    tables.sort((a, b) => a.offset - b.offset);
    let end = directoryEnd;
    for (const table of tables) {
      if (table.offset < end) throw new Error();
      end = table.offset + table.length;
    }
    for (const { tag, offset, length } of tables)
      if (tag === 0x6e616d65) // name
        hits.push(...checkFontNames(buffer.subarray(offset, offset + length), file, terms, depth, budget));
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    hits.push(safeLocation(file, terms) + ": invalid SFNT font data");
  }
  return hits;
}

/** Font tables and optional metadata share one bounded expansion budget. */
function checkFont(buffer: Buffer, file: string, terms: PrivateTerms, depth: number, budget: ScanBudget): string[] {
  const hits: string[] = [];
  try {
    const woff2 = buffer.toString("ascii", 0, 4) === "wOF2";
    const header = woff2 ? 48 : 44;
    if (buffer.length < header || buffer.length > ASSET_BYTES || buffer.readUInt32BE(8) !== buffer.length)
      throw new Error();
    const count = buffer.readUInt16BE(12);
    if (!count || buffer.readUInt32BE(16) > EXPANDED_BYTES) throw new Error();
    let dataEnd = header;
    const scan = (data: Buffer) => {
      // Font names may also contain private text in any supported raw encoding.
      hits.push(...rawTermViews(data, file, terms, budget));
      hits.push(...binarySecrets(data, file, terms, budget));
    };
    if (!woff2) {
      if (header + count * 20 > buffer.length) throw new Error();
      dataEnd = header + count * 20;
      for (let i = 0; i < count; i++) {
        const at = header + i * 20;
        const offset = buffer.readUInt32BE(at + 4);
        const compressed = buffer.readUInt32BE(at + 8);
        const original = buffer.readUInt32BE(at + 12);
        if (!original || compressed > original ||
          offset < header + count * 20 || offset + compressed > buffer.length) throw new Error();
        if (original > budget.remaining) throw new BudgetExceeded();
        const bytes = buffer.subarray(offset, offset + compressed);
        dataEnd = Math.max(dataEnd, offset + compressed);
        const data = compressed === original ? bytes : budget.inflate(bytes, false, original);
        if (compressed === original) budget.spend(original);
        if (data.length !== original) throw new Error();
        scan(data);
        if (buffer.toString("ascii", at, at + 4) === "name") hits.push(...checkFontNames(data, file, terms, depth, budget));
      }
    } else {
      let at = header, expected = 0;
      const names: { offset: number; length: number }[] = [];
      const uintBase128 = () => {
        let value = 0;
        for (let i = 0; i < 5; i++) {
          if (at >= buffer.length) throw new Error();
          const byte = buffer[at++] as number;
          if ((!i && byte === 128) || value > 0x1ffffff) throw new Error();
          value = value * 128 + (byte & 127);
          if (!(byte & 128)) return value;
        }
        throw new Error();
      };
      for (let i = 0; i < count; i++) {
        if (at >= buffer.length) throw new Error();
        const flags = buffer[at++] as number;
        const index = flags & 63, version = flags >>> 6;
        let tag = index === 5 ? "name" : index === 10 ? "glyf" : index === 11 ? "loca" : "";
        if (index === 63) {
          if (at + 4 > buffer.length) throw new Error();
          tag = buffer.toString("ascii", at, at + 4);
          at += 4;
        }
        const original = uintBase128();
        const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
        const length = transformed ? uintBase128() : original;
        if (tag === "name") {
          if (transformed) throw new Error();
          names.push({ offset: expected, length });
        }
        expected += length;
        if (expected > EXPANDED_BYTES || original > EXPANDED_BYTES) throw new Error();
      }
      const compressed = buffer.readUInt32BE(20);
      if (expected > budget.remaining) throw new BudgetExceeded();
      if (!compressed || at + compressed > buffer.length) throw new Error();
      dataEnd = at + compressed;
      const data = budget.inflate(buffer.subarray(at, at + compressed), true, Math.max(1, expected));
      if (data.length !== expected) throw new Error();
      scan(data);
      for (const name of names) hits.push(...checkFontNames(data.subarray(name.offset, name.offset + name.length), file, terms, depth, budget));
    }
    const field = woff2 ? 28 : 24;
    const offset = buffer.readUInt32BE(field);
    const compressed = buffer.readUInt32BE(field + 4);
    const original = buffer.readUInt32BE(field + 8);
    if (offset || compressed || original) {
      const privateOffset = buffer.readUInt32BE(field + 12);
      if (offset < dataEnd || offset % 4 !== 0 || !compressed || !original ||
        offset + compressed > buffer.length ||
        (privateOffset && offset + compressed > privateOffset)) throw new Error();
      if (original > budget.remaining) throw new BudgetExceeded();
      const bytes = buffer.subarray(offset, offset + compressed);
      const data = budget.inflate(bytes, woff2, original);
      if (data.length !== original) throw new Error();
      scan(data);
      hits.push(...checkText(data.toString("utf8"), file + " (metadata)", terms, { lines: true, lineExemptions: false, imageDepth: depth, budget }));
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    hits.push(safeLocation(file, terms) + ": invalid compressed font data");
  }
  return hits;
}

/** Scan distinct byte-order/alignment views once; ASCII UTF-8 and Latin-1 share one view. */
function rawTermViews(buffer: Buffer, file: string, terms: PrivateTerms, budget: ScanBudget): string[] {
  const ascii = isAscii(buffer);
  // Reserve all views before allocating or normalizing any of them.
  budget.spend(buffer.length * (ascii ? 5 : 6));
  const hits: string[] = [];
  const seen = new Set<string>();
  const scan = (text: string) => {
    if (!seen.has(text)) {
      seen.add(text);
      // Binary byte views are not rendered text. Secret scanning remains in binarySecrets.
      hits.push(...checkText(text, file, terms, { lines: true, generic: false, binaryView: true, budget }));
    }
  };
  scan(buffer.toString("utf8"));
  if (!ascii) scan(buffer.toString("latin1"));
  for (const offset of [0, 1]) {
    const bytes = buffer.subarray(offset, offset + Math.floor((buffer.length - offset) / 2) * 2);
    scan(bytes.toString("utf16le"));
    scan(new TextDecoder("utf-16be").decode(bytes));
  }
  return hits;
}

interface InlineSyntax {
  contextStart: number;
  bodyQuote: string;
  srcset: (at: number) => { start: number; end: number } | undefined;
  next: (delimiter: string, from: number) => number;
  previous: (delimiter: string, before: number) => number;
  character: (at: number) => string;
  inspect: (characters: number) => void;
  malformedBody: (from: number) => boolean;
}

/** Index terminators in one pass; each cursor only moves forward as URIs are consumed. */
function inlineSyntax(text: string, budget: ScanBudget): InlineSyntax {
  // Reserve one body pass; inspect charges additional enclosure/context passes.
  budget.spend(Buffer.byteLength(text));
  const delimiters = new Map<string, { positions: number[]; at: number; before: number }>();
  // This fixed-token regex visits the input once, including non-delimiters.
  budget.inlineTerminatorWork += text.length;
  for (const match of text.matchAll(/(?<![a-z0-9])data:|[\r\n"'`)<>]/gi)) {
    budget.spend(8);
    const delimiter = match[0].toLowerCase();
    let entry = delimiters.get(delimiter);
    if (!entry) { entry = { positions: [], at: 0, before: 0 }; delimiters.set(delimiter, entry); }
    entry.positions.push(match.index);
  }
  // Only HTML attribute syntax has a range. Stray quotes in prose/code never pair with a URI.
  const srcsets: { start: number; end: number }[] = [];
  const read = (at: number) => { budget.inlineTerminatorWork++; return text[at] ?? ""; };
  let tag = false, srcsetAt = 0;
  for (let at = 0; at < text.length;) {
    const character = read(at++);
    if (character === "<") tag = true;
    else if (character === ">") tag = false;
    else if (tag && /[a-z_:]/i.test(character)) {
      const start = at - 1;
      while (at < text.length && /[a-z0-9_:.-]/i.test(read(at))) at++;
      const attribute = text.slice(start, at).toLowerCase();
      while (at < text.length && /\s/u.test(read(at))) at++;
      if (text[at] !== "=") continue;
      at++;
      while (at < text.length && /\s/u.test(read(at))) at++;
      const quote = /["']/.test(text[at] ?? "") ? text[at++] : "";
      const valueStart = at;
      while (at < text.length && (quote ? read(at) !== quote : !/[\s>]/u.test(read(at)))) at++;
      if (attribute === "srcset") srcsets.push({ start: valueStart, end: at });
      if (quote && at < text.length) at++;
    }
  }
  return {
    contextStart: 0,
    bodyQuote: "",
    srcset(at) {
      while ((srcsets[srcsetAt]?.end ?? Infinity) <= at) { budget.inlineTerminatorWork++; srcsetAt++; }
      const range = srcsets[srcsetAt];
      return range && range.start <= at ? range : undefined;
    },
    inspect(characters) { budget.inlineTerminatorWork += characters; budget.spend(characters); },
    character(at) {
      budget.inlineTerminatorWork++;
      return text[at] ?? "";
    },
    next(delimiter, from) {
      const entry = delimiters.get(delimiter);
      budget.inlineTerminatorWork++;
      if (!entry) return -1;
      while ((entry.positions[entry.at] ?? Infinity) < from) {
        budget.inlineTerminatorWork++;
        entry.at++;
      }
      return entry.positions[entry.at] ?? -1;
    },
    previous(delimiter, before) {
      const entry = delimiters.get(delimiter);
      budget.inlineTerminatorWork++;
      if (!entry) return -1;
      while ((entry.positions[entry.before] ?? Infinity) < before) {
        budget.inlineTerminatorWork++;
        entry.before++;
      }
      return entry.positions[entry.before - 1] ?? -1;
    },
    malformedBody(from) {
      const bounds = [this.next("data:", from), this.next("\n", from), this.next("\r", from)]
        .filter((at) => at >= 0);
      const end = Math.min(text.length, from + 64 * 1024, ...bounds);
      // Never look beyond the next URI. The sticky search examines this bounded span once.
      this.inspect(end - from);
      const comma = /[^,\r\n]{0,65535},[^\s"'`/)>]/y;
      return comma.test(text.slice(from, end));
    },
  };
}

/** Keep URI punctuation until the delimiter of the enclosing syntax. */
function inlineImageEnd(text: string, start: number, payloadStart: number, syntax: InlineSyntax, base64: boolean, limit: number): number {
  const lineStart = Math.max(syntax.previous("\n", start), syntax.previous("\r", start)) + 1;
  const contextStart = Math.max(lineStart, syntax.contextStart);
  const context = text.slice(contextStart, start);
  syntax.contextStart = start;
  syntax.inspect(context.length * 3);
  let before = start - 1;
  while (before >= contextStart && /[ \t]/.test(syntax.character(before))) before--;
  syntax.bodyQuote = /["'`]/.test(text[before] ?? "") ? text[before]! : "";
  const srcset = syntax.srcset(start);
  if (srcset) {
    // Base64's own scanner stops at candidate commas; do not rescan the rest of the attribute.
    if (base64 && text[payloadStart] !== "$" && !/[\s"'>]/u.test(text[payloadStart] ?? "")) return srcset.end;
    let end = payloadStart;
    while (end < limit && !/[\s"'>]/u.test(syntax.character(end))) end++;
    // HTML's candidate parser strips trailing separator commas from the URL.
    while (end > payloadStart && syntax.character(end - 1) === ",") end--;
    return end;
  }
  const opening = text[before];
  const reference = contextStart === lineStart && /^[ \t]{0,3}\[(?:\\.|[^\]\\])+\]:[ \t]*<?$/.test(context);
  // An empty data-URI regex ends immediately after the comma, at its closing slash.
  if ((opening === "/" || (opening === "^" && text[before - 1] === "/")) &&
    ["/", "("].includes(text[payloadStart] ?? "")) return payloadStart;
  // Includes bare autolinks and reference destinations on a continuation line.
  if (opening === "<") {
    const end = syntax.next(">", payloadStart);
    if (end >= 0) return end;
  } else if (reference) {
    // Unbracketed reference destinations end at whitespace, before any title syntax.
    for (let at = payloadStart; at < limit; at++)
      if (/\s/u.test(syntax.character(at))) return at;
    return limit;
  } else if (syntax.bodyQuote) {
    const end = syntax.next(syntax.bodyQuote, payloadStart);
    if (end >= 0) return end;
  } else if (opening === "(" && /\burl\($/i.test(text.slice(Math.max(0, before - 4), before + 1))) {
    const end = syntax.next(")", payloadStart);
    if (end >= 0) return end;
  } else if (opening === "(" && text[before - 1] === "]") {
    if (base64) return limit; // The alphabet boundary precedes any enclosing parentheses.
    // Markdown link destinations balance literal parentheses within a URI.
    syntax.inspect(limit - payloadStart);
    let depth = 1;
    for (let at = payloadStart; at < limit; at++) {
      const character = syntax.character(at);
      if (character === "\\") at++;
      else if (/\s/u.test(character)) return at;
      else if (character === "(") depth++;
      else if (character === ")" && --depth === 0) return at;
    }
  } else if (opening === "=") {
    // Query separators such as & terminate base64 before the enclosing line ends.
    if (base64 && text[payloadStart] !== "$" && !/[\s>]/u.test(text[payloadStart] ?? "")) return limit;
    for (let at = payloadStart; at < limit; at++)
      if (/[\s>]/u.test(syntax.character(at))) return at;
    return limit;
  }
  const lf = syntax.next("\n", payloadStart), cr = syntax.next("\r", payloadStart);
  return Math.min(lf < 0 ? text.length : lf, cr < 0 ? text.length : cr);
}

/** Parse MIME parameters separately so an unfamiliar parameter cannot hide image bytes. */
function inlineImageHeader(text: string, start: number): { payloadStart: number; base64: boolean } {
  let at = start;
  const limit = Math.min(text.length, start + 64 * 1024);
  const token = /[!#$%&'*+.^_`|~a-z0-9-]+/iy;
  const spaces = () => { while (at < limit && /[ \t\r\n\f]/.test(text[at] ?? "")) at++; };
  const readToken = () => {
    spaces();
    token.lastIndex = at;
    const match = token.exec(text);
    if (!match || token.lastIndex > limit || /%(?![a-f0-9]{2})/i.test(match[0])) throw new Error();
    at = token.lastIndex;
    spaces();
    return match[0];
  };
  while (at < limit && text[at] === ";") {
    at++;
    const name = readToken();
    if (name.toLowerCase() === "base64" && text[at] === ",") return { payloadStart: at + 1, base64: true };
    if (name.toLowerCase() === "utf8" && text[at] === ",") return { payloadStart: at + 1, base64: false };
    if (text[at++] !== "=") throw new Error();
    spaces();
    if (text[at] === '"') {
      const begin = ++at;
      while (at < limit && text[at] !== '"') {
        if (text[at] === "\\") at++;
        if (at >= limit || !/[\t\x20-\x7e]/.test(text[at] ?? "")) throw new Error();
        at++;
      }
      if (text[at] !== '"' || /%(?![a-f0-9]{2})/i.test(text.slice(begin, at))) throw new Error();
      at++;
      spaces();
    } else readToken();
  }
  if (at >= limit || text[at] !== ",") throw new Error();
  return { payloadStart: at + 1, base64: false };
}

/** Percent escapes denote bytes, including values that are not valid UTF-8. */
function decodeImageUrl(payload: string): Buffer {
  const bytes = Buffer.allocUnsafe(Math.min(Buffer.byteLength(payload), ASSET_BYTES));
  const hex = (code: number) => code >= 48 && code <= 57 ? code - 48 :
    (code | 32) >= 97 && (code | 32) <= 102 ? (code | 32) - 87 : -1;
  let written = 0;
  for (let at = 0; at < payload.length;) {
    if (payload[at] === "%") {
      const high = hex(payload.charCodeAt(at + 1)), low = hex(payload.charCodeAt(at + 2));
      if (written >= bytes.length) throw new Error();
      if (high >= 0 && low >= 0) {
        bytes[written++] = (high << 4) | low;
        at += 3;
      } else {
        // The data URL processor leaves a malformed percent escape literal.
        bytes[written++] = 37;
        at++;
      }
    } else {
      const next = payload.indexOf("%", at);
      const end = next < 0 ? payload.length : next;
      const literal = payload.slice(at, end);
      if (Buffer.byteLength(literal) > bytes.length - written) throw new Error();
      written += bytes.write(literal, written);
      at = end;
    }
  }
  return bytes.subarray(0, written);
}

/** One escape view for generic checks and URI discovery, with original source offsets. */
export function decodedEscapeView(text: string, budget: ScanBudget): Normalized | undefined {
  if (!text.includes("\\") && !text.includes("&")) return undefined;
  const escapes = /&(?:#(?:x[a-f0-9]+|[0-9]+)|[a-z][a-z0-9]*);|\\(?:u[0-9a-f]{4}|[0-9a-f]{1,6}(?:\r\n|[ \t\r\n\f])?|\r\n|[\s\S])/gi;
  if (!escapes.test(text)) return undefined;
  escapes.lastIndex = 0;
  const entities: Record<string, string> = {
    sol: "/", bsol: "\\", colon: ":", semi: ";", comma: ",", equals: "=", plus: "+", period: ".",
    amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", Tab: "\t", NewLine: "\n", nbsp: " ",
  };
  function* edits(): Generator<TextEdit> {
    let sourceAt = 0;
    for (const match of text.matchAll(escapes)) {
      const raw = match[0], at = match.index;
      let value = raw;
      if (raw[0] === "&") {
        const entity = raw.slice(1, -1);
        if (entity.startsWith("#")) {
          const code = /^#x/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
          value = code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
        } else value = entities[entity] ?? raw;
      } else if (/^\\u[0-9a-f]{4}$/i.test(raw)) value = String.fromCharCode(Number.parseInt(raw.slice(2), 16));
      else if (/^\\[0-9a-f]/i.test(raw)) {
        const code = Number.parseInt(raw.slice(1).trim(), 16);
        value = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
      } else if (/^\\[\r\n\f]/.test(raw)) value = "";
      else value = ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[raw.slice(1)] ?? raw.slice(1);
      budget.spend(Buffer.byteLength(text.slice(sourceAt, at)) + Buffer.byteLength(value));
      sourceAt = at + raw.length;
      yield { start: at, end: sourceAt, value };
    }
    budget.spend(Buffer.byteLength(text.slice(sourceAt)));
  }
  const result = rewrite({ text, start: (at) => at, end: (at) => at }, edits());
  return result.text === text ? undefined : result;
}

/** Documentation can contain a truncated image prefix; inspect its text without requiring an image. */
function checkInlineHeaderPrefix(payload: string, location: string, terms: PrivateTerms, depth: number, budget: ScanBudget, predecoded?: Buffer): string[] {
  const prefix = /^[a-z0-9+/]*={0,2}/i.exec(payload)?.[0] ?? "";
  if (!prefix) return [];
  const length = Math.floor(prefix.replace(/=+$/, "").length * 3 / 4);
  if (!predecoded) budget.spend(length);
  const bytes = predecoded ? predecoded.subarray(0, length) : Buffer.from(prefix, "base64");
  budget.spend(bytes.length);
  const encoding = utf16Bom(bytes) ? bytes[0] === 0xff ? "utf-16le" : "utf-16be" : "utf-8";
  return checkText(new TextDecoder(encoding).decode(bytes), location, terms,
    { lineExemptions: false, imageDepth: depth + 1, budget });
}

interface InlinePiece { start: number; end: number; padded: boolean }

/** Consume one alphabet run once, retaining percent-encoded bytes for the decoding pass. */
function inlinePiece(text: string, start: number, limit: number, syntax: InlineSyntax, whitespace = false): InlinePiece {
  let end = start, padded = false;
  while (end < limit) {
    let character = syntax.character(end), width = 1;
    if (character === "%" && end + 3 <= limit && /^[a-f0-9]{2}$/i.test(text.slice(end + 1, end + 3))) {
      syntax.inspect(2);
      character = String.fromCharCode(Number.parseInt(text.slice(end + 1, end + 3), 16));
      width = 3;
    } else if (whitespace && /[ \t\f]/.test(character)) { end++; continue; }
    else if (!/[A-Za-z0-9+/=]/.test(character)) break;
    if (character === "=") padded = true;
    end += width;
  }
  return { start, end, padded };
}

interface InlineReading { payload: string; end: number; url?: boolean; boundaries?: number[]; hitOnly?: boolean; bounded?: boolean; tolerant?: boolean; prefixAllowed?: boolean; chain?: boolean; srcset?: boolean }

/** Yield R2 at its quote stop, then resume the same pass for hit-only disclosure scanning. */
function* inlineJoined(text: string, first: InlinePiece, limit: number, syntax: InlineSyntax, plusIsData: boolean): Generator<InlineReading> {
  const pieces: string[] = [];
  const boundaries: number[] = [];
  let piece = first, total = 0;
  let hitOnly = false, stoppedLength = 0;
  for (;;) {
    let end = piece.end;
    while (end > piece.start && /[ \t\f]/.test(text[end - 1]!)) { syntax.inspect(1); end--; }
    // A plus inside a closing quote belongs to that piece, not to its separator.
    if (!plusIsData && text[end - 1] === "+" && !/["'`]/.test(text[piece.end] ?? "")) end--;
    if (pieces.length) boundaries.push(total);
    pieces.push(text.slice(piece.start, end));
    total += end - piece.start;
    if (total > ASSET_BYTES * 4 / 3 + 4) break;
    if (piece.padded && !hitOnly) {
      stoppedLength = total;
      yield { payload: pieces.join(""), end: piece.end, boundaries: boundaries.slice() };
      hitOnly = true;
    }
    let at = piece.end;
    const character = () => at < limit ? syntax.character(at) : "";
    const spaces = () => { while (at < limit && /[ \t]/.test(character())) at++; };
    const operator = (leading: boolean) => {
      const start = at;
      const char = character();
      if ((char === "." && text[at + 1] === ".") || (char === "|" && text[at + 1] === "|")) {
        syntax.inspect(1); at += 2;
      } else if (char === "&") { at++; spaces(); if (character() === "_") at++; }
      else if (/[.,\\]/.test(char) || (char === "+" && (!leading || !plusIsData))) at++;
      return at !== start;
    };
    spaces();
    const closesPiece = /["'`]/.test(character());
    const closesBody = !!syntax.bodyQuote && character() === syntax.bodyQuote;
    if (closesPiece) { at++; spaces(); }
    const trailingOperator = operator(false); spaces();
    if (character() === "\r") { at++; if (character() === "\n") at++; }
    else if (character() === "\n") at++;
    else break;
    spaces();
    // Keep the quoted ASCII whitespace forms accepted before the join grammar existed.
    if (syntax.bodyQuote) while (/[\r\n\f]/.test(character())) { at++; spaces(); }
    const leadingOperator = operator(true); spaces();
    if (character() === "@" && text[at + 1] === '"') at++;
    // A closed string can continue through concatenation or another quoted piece, not bare prose.
    if (!hitOnly && closesBody && !trailingOperator && !leadingOperator && !/["'`]/.test(character())) {
      stoppedLength = total;
      yield { payload: pieces.join(""), end: piece.end, boundaries: boundaries.slice() };
      hitOnly = true;
    }
    if (/["'`]/.test(character())) at++;
    const next = inlinePiece(text, at, limit, syntax);
    if (next.end === next.start) break;
    piece = next;
  }
  if (!hitOnly || total > stoppedLength)
    yield { payload: pieces.join(""), end: piece.end, boundaries, hitOnly };
}

/** Normalize before caching, preserving piece offsets in the normalized alphabet. */
function normalizeInlineReading(reading: InlineReading, budget: ScanBudget): InlineReading {
  const parts: string[] = [], boundaries: number[] = [];
  let start = 0, length = 0;
  for (const end of [...reading.boundaries ?? [], reading.payload.length]) {
    let payload = reading.payload.slice(start, end);
    if (payload.includes("%")) {
      budget.spend(Buffer.byteLength(payload));
      const bytes = decodeImageUrl(payload); budget.spend(bytes.length); payload = bytes.toString("latin1");
    }
    if (/[ \t\r\n\f]/.test(payload)) {
      budget.spend(Buffer.byteLength(payload)); payload = payload.replace(/[ \t\r\n\f]/g, "");
    }
    if (reading.tolerant) {
      budget.spend(Buffer.byteLength(payload)); payload = payload.replace(/[^a-z0-9+/=]/gi, "");
    }
    if (reading.url) payload = payload.replaceAll("-", "+").replaceAll("_", "/");
    if (parts.length) boundaries.push(length);
    parts.push(payload); length += payload.length; start = end;
  }
  return { ...reading, payload: parts.join(""), boundaries };
}

/** Continue from R4's closing quote; indexed quotes avoid scanning literal bodies again. */
function inlineConcatenated(text: string, first: InlineReading, limit: number, syntax: InlineSyntax, budget: ScanBudget): InlineReading[] {
  const parts: string[] = [], boundaries: number[] = [];
  let at = first.end + 1, total = 0, padding = 0, segmentLength = 0, invalid = false, validParts = 0, validLength = 0;
  let prefixAllowed = true;
  const append = (reading: InlineReading) => {
    const normalized = normalizeInlineReading(reading, budget);
    prefixAllowed &&= inlineSingleTokens(reading.payload);
    if (parts.length) boundaries.push(total);
    for (const boundary of normalized.boundaries ?? []) boundaries.push(total + boundary);
    parts.push(normalized.payload);
    for (const character of normalized.payload) {
      if (character === "=") padding++;
      else {
        if (padding) {
          invalid ||= padding > 2 || segmentLength % 4 !== 0;
          padding = segmentLength = 0;
        }
        if (!/[a-z0-9+/]/i.test(character)) invalid = true;
      }
      segmentLength++;
    }
    total += normalized.payload.length;
    if (!invalid && padding <= 2 && segmentLength % 4 !== 1 && (!padding || segmentLength % 4 === 0)) {
      validParts = parts.length; validLength = total;
    }
  };
  const character = () => at < limit ? syntax.character(at) : "";
  const spaces = () => { while (at < limit && /[ \t\r\n\f]/.test(character())) at++; };
  for (;;) {
    spaces();
    if (/[+.&]/.test(character())) {
      const operator = character(); at++;
      if (operator === "." && character() === ".") at++;
      spaces();
    }
    if (!/["'`]/.test(character())) break; // Commas and identifiers are not concatenated literals.
    const quote = character(), start = ++at;
    const end = syntax.next(quote, start);
    if (end < 0 || end >= limit) break;
    if (!parts.length) append(first);
    const payload = text.slice(start, end);
    append({ payload, end, boundaries: [...payload.matchAll(/\r\n?|\n/g)].map((line) => line.index) });
    at = end + 1;
    if (total > ASSET_BYTES * 4 / 3 + 4) break;
  }
  if (!parts.length) return [];
  const full = { payload: parts.join(""), end: at, boundaries, bounded: true, chain: true, prefixAllowed };
  return validParts > 1 && validParts < parts.length ? [full,
    { payload: parts.slice(0, validParts).join(""), end: at, boundaries: boundaries.filter((n) => n < validLength), bounded: true, chain: true, prefixAllowed },
  ] : [full];
}

/** Prefix recovery must not turn continuation prose into an opaque body. */
function inlineSingleTokens(payload: string): boolean {
  return payload.split(/\r\n?|\n/).slice(1).every((line) => !/\S[ \t\f]+\S/.test(line.trim()));
}

function inlineBoundedPrefix(reading: InlineReading, budget: ScanBudget): InlineReading | undefined {
  const normalized = normalizeInlineReading(reading, budget);
  const damaged = /[^a-z0-9+/=]/i.exec(normalized.payload);
  let payload = normalized.payload.slice(0, damaged?.index ?? normalized.payload.length);
  // Walk backwards once: an unanchored suffix regex retries long earlier segments.
  let tailStart = payload.length;
  while (tailStart > 0 && payload[tailStart - 1] === "=") tailStart--;
  while (tailStart > 0 && payload[tailStart - 1] !== "=") tailStart--;
  const tail = payload.slice(tailStart);
  if (tail.length % 4 === 1 || (tail.includes("=") && (tail.length % 4 !== 0 || /={3}/.test(tail)))) {
    let trimmed = tail.replace(/=+$/, "");
    if (trimmed.length % 4 === 1) trimmed = trimmed.slice(0, -1);
    payload = payload.slice(0, payload.length - tail.length) + trimmed;
  }
  if (!payload || payload === normalized.payload) return undefined;
  return { payload, end: reading.end, bounded: true, prefixAllowed: true,
    boundaries: normalized.boundaries?.filter((boundary) => boundary < payload.length) };
}

/** One additional text view retains token boundaries without rescanning every prefix. */
function inlineBoundaryText(reading: InlineReading, bytes: Buffer, budget: ScanBudget, padded?: InlinePadded): string | undefined {
  if (!reading.boundaries?.length && !padded) return undefined;
  const parts: string[] = [];
  const decoder = new TextDecoder(utf16Bom(bytes) ? bytes[0] === 255 ? "utf-16le" : "utf-16be" : "utf-8");
  let encodedAt = 0, dataLength = 0, byteAt = 0, dataStart = 0;
  const cuts: number[] = [];
  for (const boundary of reading.boundaries ?? []) {
    while (encodedAt < boundary) {
      if (reading.payload[encodedAt] === "=") {
        if (!padded) break;
        dataStart += Math.floor(dataLength * 3 / 4); dataLength = 0;
      } else if (/[a-z0-9+/_-]/i.test(reading.payload[encodedAt]!)) dataLength++;
      encodedAt++;
    }
    cuts.push(dataStart + Math.floor(dataLength * 3 / 4));
  }
  let pieceAt = 0, segmentAt = 0;
  while (pieceAt < cuts.length || segmentAt < (padded?.ends.length ?? 0)) {
    const piece = cuts[pieceAt] ?? Infinity, segment = padded?.ends[segmentAt]?.data ?? Infinity;
    const end = Math.min(bytes.length, piece, segment);
    if (piece <= segment) pieceAt++;
    if (segment <= piece) segmentAt++;
    if (end > byteAt && end < bytes.length) {
      parts.push(decoder.decode(bytes.subarray(byteAt, end), { stream: true }), "\n");
      byteAt = end;
    }
  }
  if (!parts.length) return undefined;
  budget.spend(bytes.length + parts.length / 2);
  parts.push(decoder.decode(bytes.subarray(byteAt)));
  return parts.join("");
}

/** Decode padded segments together in one pass, resetting the bit accumulator at padding. */
interface InlinePadded { bytes: Buffer; ends: { data: number; encoded: number; strict: boolean }[]; strict: boolean; restStrict: boolean }
function inlinePaddedBytes(payload: string, budget: ScanBudget): InlinePadded | undefined {
  const padding = payload.indexOf("=");
  if (padding < 0 || payload.length > ASSET_BYTES * 4 / 3 + 4 || !/[a-z0-9+/]/i.test(payload.slice(padding))) return undefined;
  const bytes = Buffer.allocUnsafe(Math.min(ASSET_BYTES, Math.floor(payload.length * 3 / 4)));
  const ends: InlinePadded["ends"] = [];
  let accumulator = 0, bits = 0, written = 0, padded = false;
  let strict = true, start = 0, paddingCount = 0, alphabet = true;
  const finish = (at: number) => {
    const length = at - start;
    const segmentStrict = alphabet && length % 4 !== 1 && paddingCount <= 2 && (!paddingCount || length % 4 === 0);
    strict &&= segmentStrict;
    ends.push({ data: written, encoded: at, strict: segmentStrict });
    start = at; paddingCount = 0; alphabet = true;
  };
  for (let at = 0; at < payload.length; at++) {
    const code = payload.charCodeAt(at);
    if (code === 61) {
      accumulator = bits = 0; padded = true; paddingCount++;
      continue;
    }
    const value = code >= 65 && code <= 90 ? code - 65 : code >= 97 && code <= 122 ? code - 71 :
      code >= 48 && code <= 57 ? code + 4 : code === 43 || code === 45 ? 62 : code === 47 || code === 95 ? 63 : -1;
    if (padded && value >= 0) { finish(at); padded = false; }
    if (value < 0 || code === 45 || code === 95) alphabet = false;
    if (value < 0) continue;
    accumulator = (accumulator << 6) | value; bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (written >= bytes.length) throw new BudgetExceeded();
      bytes[written++] = (accumulator >>> bits) & 255;
    }
  }
  finish(payload.length);
  budget.spend(written);
  return { bytes: bytes.subarray(0, written), ends, strict, restStrict: ends.slice(1).every((end) => end.strict) };
}

/** Only text with a valid encoding and no binary controls can govern refusals. */
function inlineText(bytes: Buffer, budget: ScanBudget): string | undefined {
  budget.spend(bytes.length);
  let text: string | undefined;
  if (utf16Bom(bytes)) {
    try { text = new TextDecoder(bytes[0] === 255 ? "utf-16le" : "utf-16be", { fatal: true }).decode(bytes); }
    catch { return undefined; }
  } else if (isUtf8(bytes)) text = bytes.toString("utf8");
  return text !== undefined && !/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text) ? text : undefined;
}

/** Framing completeness is separate from PNG text scanning, which retains hits before a bad tail. */
function completeInlinePng(bytes: Buffer, budget: ScanBudget): boolean {
  budget.spend(bytes.length);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return false;
  let image = false;
  for (let at = 8; at < bytes.length;) {
    if (bytes.length - at < 12) return false;
    const size = bytes.readUInt32BE(at), kind = bytes.toString("latin1", at + 4, at + 8);
    if (size > bytes.length - at - 12 || !/^[a-z]{4}$/i.test(kind)) return false;
    if (at === 8 && (kind !== "IHDR" || size !== 13 || !bytes.readUInt32BE(at + 8) || !bytes.readUInt32BE(at + 12))) return false;
    if (at !== 8 && kind === "IHDR") return false;
    at += size + 12;
    if (kind === "IDAT") image = true;
    if (kind === "IEND") return image && size === 0 && at === bytes.length;
  }
  return false;
}

interface InlineInspection { hits: string[]; firstHits: string[]; bytes?: Buffer; strict: boolean; dataLength: number; segmented?: boolean }
const inlineDisclosure = (hit: string) => /: (?:private term\b|secret shape\b)/.test(hit);
const inlineInvalid = (hit: string) => /: (?:invalid\b|binary file of unknown type$)/.test(hit);

/** Decode once, scan tolerantly, and retain the first-piece judgment independently. */
function inspectInlineReading(reading: InlineReading, mime: string, base64: boolean, marker: boolean,
  file: string, terms: PrivateTerms, depth: number, budget: ScanBudget, predecoded?: Buffer, interior = false): InlineInspection {
  const invalid = safeLocation(file, terms) + ": invalid or oversized inline image";
  const result: InlineInspection = { hits: [], firstHits: [], strict: false, dataLength: reading.payload.length };
  const payload = reading.payload;
  if (!payload || /^\$\{[^{}]*\}$/.test(payload) || (mime === "image/png" && base64 && payload === "AAAA")) return result;
  try {
    const header = !interior && base64 && payload.length < 16;
    const valid = !base64 || (!!payload && (reading.url ? /^[a-z0-9+/_-]*={0,2}$/i : /^[a-z0-9+/]*={0,2}$/i).test(payload) &&
      payload.length % 4 !== 1 && (!payload.includes("=") || payload.length % 4 === 0));
    result.strict = valid;
    if (depth >= 2 || payload.length > ASSET_BYTES * (base64 ? 4 / 3 : 3) + 4) throw new Error();
    const possibleTruncation = !interior && payload.length < 256 && /^(?:iVBO|\/9j\/|R0lG|UklG)/.test(payload) && /^[a-z0-9+/]+$/i.test(payload);
    let bytes: Buffer;
    if (predecoded) { bytes = predecoded; budget.spend(bytes.length); }
    else if (base64) {
      let dataEnd = payload.length;
      while (dataEnd > 0 && payload[dataEnd - 1] === "=") dataEnd--;
      budget.spend(Math.floor(dataEnd * 3 / 4));
      bytes = Buffer.from(payload, reading.url ? "base64url" : "base64");
    } else { bytes = decodeImageUrl(payload); budget.spend(bytes.length); }
    result.bytes = bytes;
    if (bytes.length > ASSET_BYTES) throw new Error();
    const declared = mime.endsWith("font-woff") ? "woff" : mime === "font/sfnt" ? "ttf" :
      ["font/woff", "font/woff2", "font/ttf", "font/otf"].includes(mime) ? mime.slice(5) :
      ["text/xml", "application/xml"].includes(mime) ? "xml" : ["image/svg+xml", "image/svg"].includes(mime) ? "svg" :
      mime === "image/png" ? "png" : mime.startsWith("image/") ? "image" : undefined;
    const extension = inlineAssetType(bytes, budget) ?? declared;
    const bodyFile = `${file}.${extension ?? "bin"}`;
    const metadata = inlineImageMetadata(bytes, extension, budget);
    const structured = metadata.complete || (extension === "png" && completeInlinePng(bytes, budget));
    result.hits = checkBuffer(bytes, bodyFile, terms, true, false, depth + 1, budget);
    // Unknown binary bytes still expose their text and secret shapes in a tolerant reading.
    if (!knownBinary(bytes, bodyFile) && bytes.includes(0)) result.hits.push(
      ...binarySecrets(bytes, bodyFile, terms, budget),
      ...checkText(bytes.toString("utf8"), bodyFile, terms, { lineExemptions: false, imageDepth: depth + 1, budget }).filter(inlineDisclosure),
    );
    for (const data of metadata.metadata) result.hits.push(
      ...rawTermViews(data, bodyFile, terms, budget), ...binarySecrets(data, bodyFile, terms, budget),
      ...checkText(data.toString("utf8"), bodyFile, terms, { lineExemptions: false, imageDepth: depth + 1, budget }),
    );
    const clean = inlineText(bytes, budget) !== undefined;
    const unknownBinary = !structured && !knownBinary(bytes, bodyFile) && !clean;
    if (unknownBinary) {
      const unknown = safeLocation(bodyFile, terms) + ": binary file of unknown type";
      if (!result.hits.includes(unknown)) result.hits.push(unknown);
    }
    // Complete inline containers are known here even when checkBuffer has no file-type parser.
    result.firstHits = structured ? result.hits.filter((hit) => !hit.endsWith(": binary file of unknown type")) : result.hits;
    const truncated = !interior && base64 && payload.length < 256 ? truncatedInlineImage(bytes, budget) : undefined;
    if (!valid && !header && !possibleTruncation) result.firstHits = [invalid];
    else if (truncated && (payload.length < 128 || marker)) {
      result.firstHits = [];
      if (truncated.extension === "png" && truncated.complete >= 8)
        result.firstHits.push(...checkBuffer(bytes.subarray(0, truncated.complete), `${file}.png`, terms, true, false, depth + 1, budget));
      result.firstHits.push(...rawTermViews(bytes, file, terms, budget), ...binarySecrets(bytes, file, terms, budget),
        ...checkInlineHeaderPrefix(payload, file, terms, depth, budget, bytes));
    } else if (!valid) result.firstHits = header ? checkInlineHeaderPrefix(payload, file, terms, depth, budget, bytes) : [invalid];
    else if (header && result.hits.some(inlineInvalid)) result.firstHits = [
      ...result.hits.filter((hit) => !inlineInvalid(hit)), ...checkInlineHeaderPrefix(payload, file, terms, depth, budget, bytes),
    ];
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    result.firstHits = [invalid];
  }
  return result;
}

/** All readings disclose; the longest strictly valid bounded reading judges refusals. */
function checkInlineImages(text: string, file: string, terms: PrivateTerms, depth: number, budget: ScanBudget, decoded?: Normalized): string[] {
  if (!/data:/i.test(text) && !(decoded && /data:/i.test(decoded.text))) return [];
  const hits: string[] = [];
  // Preserve physical backslash-newlines that the decoded view removes.
  if (decoded && /\\\r?\n/.test(text)) hits.push(...checkInlineImages(text, file, terms, depth, budget));
  text = decoded?.text ?? text;
  const syntax = inlineSyntax(text, budget);
  // Repeated small literals share inspections; larger assets retain their expansion-budget charges.
  const inspections = new Map<string, InlineInspection>();
  const pattern = /(?<![a-z0-9])data:[ \t]*(?:([!#$%&'*+.^_`|~a-z0-9-]+\/[!#$%&'*+.^_`|~a-z0-9-]+)[ \t]*)?(?=[;,])/gi;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const location = file + " (inline image)";
    const atLocation = (hit: string) => {
      const label = hit.indexOf(": ", file.length);
      return hit.startsWith(file) && label >= 0 ? location + hit.slice(label) : hit;
    };
    let nonempty = false;
    try {
      const { payloadStart, base64 } = inlineImageHeader(text, pattern.lastIndex);
      const next = syntax.next("data:", payloadStart), limit = next < 0 ? text.length : next;
      const syntacticEnd = Math.min(inlineImageEnd(text, match.index, payloadStart, syntax, base64, limit), limit);
      let first: InlineReading;
      const readings: InlineReading[] = [];
      let quoted: InlineReading | undefined;
      if (base64) {
        const piece = inlinePiece(text, payloadStart, Math.min(limit, syntacticEnd), syntax,
          !!syntax.bodyQuote && !syntax.srcset(match.index));
        first = { payload: text.slice(payloadStart, piece.end), end: piece.end };
        const joins = [false, true].map((plusIsData) => inlineJoined(text, piece, limit, syntax, plusIsData));
        for (const join of joins) readings.push(join.next().value!);
        // Resume only the suffix after a quote stop. Exhausted R2 iterators do no more source work.
        const continuationStart = budget.inlineTerminatorWork;
        for (const join of joins) readings.push(...join);
        budget.inlineHitOnlyWork += budget.inlineTerminatorWork - continuationStart;
        if (/[-_]/.test(text[piece.end] ?? "")) {
          let at = piece.end;
          while (at < limit && /[a-z0-9+/_=-]/i.test(syntax.character(at))) at++;
          readings.push({ payload: text.slice(payloadStart, at), end: at, url: true });
        }
        if (syntax.bodyQuote) {
          const at = syntax.next(syntax.bodyQuote, payloadStart);
          if (at >= 0 && at < limit) {
            const payload = text.slice(payloadStart, at);
            const srcset = !!syntax.srcset(match.index);
            quoted = { payload, end: at, bounded: true, srcset, prefixAllowed: !srcset && inlineSingleTokens(payload), boundaries: [...payload.matchAll(/\r\n?|\n/g)].map((line) => line.index) };
            readings.push(quoted, ...inlineConcatenated(text, quoted, limit, syntax, budget));
          }
        }
        const tolerantEnd = quoted?.end ?? Math.min(syntacticEnd, ...["\"", "'", "`", ")", ">"].map((delimiter) => {
          const at = syntax.next(delimiter, payloadStart);
          return at < 0 ? limit : at;
        }));
        if (tolerantEnd > piece.end) {
          const suffix = text.slice(piece.end, tolerantEnd);
          // R4 already covers ASCII whitespace. Resume only the missing damaged suffix.
          const skipped = quoted ? /[^a-z0-9+/=% \t\r\n\f]/i : /[^a-z0-9+/=]/i;
          if (skipped.test(suffix))
            readings.push({ payload: first.payload + suffix, end: tolerantEnd, tolerant: true, hitOnly: true });
        }
      } else {
        const fragment = text.slice(match.index, syntacticEnd).indexOf("#");
        first = { payload: text.slice(payloadStart, fragment < 0 ? syntacticEnd : match.index + fragment), end: syntacticEnd };
      }
      pattern.lastIndex = first.end;
      nonempty = !!first.payload;
      let markerAt = first.end;
      while (markerAt < limit && /[ \t]/.test(syntax.character(markerAt))) markerAt++;
      const markers = /(?:\.{3}|…|\[(?:\.{3}|truncated)\]|\(truncated\)|<truncated>)/iy;
      markers.lastIndex = markerAt;
      syntax.inspect(Math.min(11, limit - markerAt));
      const marker = markers.test(text);
      const mime = (match[1] ?? "").toLowerCase();
      const candidate = new Map<string, InlineInspection>();
      const boundaryScans = new Set<string>();
      const firstPayload = base64 ? normalizeInlineReading(first, budget).payload : first.payload;
      const paddedScans = new Map<string, { result: InlineInspection; decoded: InlinePadded; firstIsR1: boolean } | undefined>();
      const decodedBytes = new Map<string, Buffer>();
      const inspect = (reading: InlineReading) => {
        if (base64) reading = normalizeInlineReading(reading, budget);
        const key = `${mime}:${base64}:${marker}:${reading.payload}`;
        let result = candidate.get(key) ?? inspections.get(key);
        if (!result) {
          // Node stops at padding and ignores damaged characters. Equivalent byte views share a decode.
          let byteKey = base64 ? reading.payload.split("=", 1)[0]!.replace(/[^a-z0-9+/_-]/gi, "").replaceAll("-", "+").replaceAll("_", "/") : "";
          if (byteKey.length % 4 === 1) byteKey = byteKey.slice(0, -1);
          let bytes = base64 ? decodedBytes.get(byteKey) : undefined;
          if (base64 && !bytes) for (const [prefix, decoded] of decodedBytes)
            if (prefix.startsWith(byteKey)) { bytes = decoded.subarray(0, Math.floor(byteKey.length * 3 / 4)); break; }
          result = inspectInlineReading(reading, mime, base64, marker, location, terms, depth, budget, bytes);
          if (base64 && result.bytes) decodedBytes.set(byteKey, result.bytes);
          if (reading.payload.length <= 128) {
            if (inspections.size >= 16) inspections.delete(inspections.keys().next().value!);
            inspections.set(key, result);
          }
        }
        candidate.set(key, result);
        hits.push(...result.hits.filter(inlineDisclosure).map(atLocation));
        if (base64 && !paddedScans.has(key)) {
          paddedScans.set(key, undefined);
          const padded = inlinePaddedBytes(reading.payload, budget);
          if (padded) {
            const inspectSegment = (payload: string, bytes: Buffer, interior: boolean) => {
              const segmentKey = `${mime}:${base64}:${marker}:${payload}`;
              let segment = interior ? undefined : candidate.get(segmentKey);
              if (!segment) {
                budget.spend(5 * 1024); // At most about 10,000 independent segment inspections per scan.
                segment = inspectInlineReading({ payload, end: reading.end }, mime, true, marker,
                  location, terms, depth, budget, bytes, interior);
              }
              hits.push(...segment.hits.filter(inlineDisclosure).map(atLocation));
              return segment;
            };
            // Concatenated bytes remain a separate disclosure view, never a segment judgment.
            hits.push(...inspectInlineReading({ payload: reading.payload, end: reading.end }, mime, true, marker,
              location, terms, depth, budget, padded.bytes).hits.filter(inlineDisclosure).map(atLocation));
            const firstHits: string[] = [];
            let dataStart = 0, encodedStart = 0;
            for (const end of padded.ends) {
              if (end.data > dataStart) firstHits.push(...inspectSegment(reading.payload.slice(encodedStart, end.encoded),
                padded.bytes.subarray(dataStart, end.data), encodedStart > 0 || reading.payload.slice(0, end.encoded) !== firstPayload).firstHits);
              dataStart = end.data; encodedStart = end.encoded;
            }
            paddedScans.set(key, { result: { ...result, firstHits: [...new Set(firstHits)], strict: padded.strict, segmented: true },
              decoded: padded, firstIsR1: reading.payload.slice(0, padded.ends[0]!.encoded) === firstPayload });
          }
        }
        const padded = paddedScans.get(key);
        if (base64 && result.bytes && (reading.boundaries?.length || padded)) {
          const boundaryKey = `${key}:${reading.boundaries?.join(",") ?? ""}`;
          if (!boundaryScans.has(boundaryKey)) {
            boundaryScans.add(boundaryKey);
            const boundaryText = inlineBoundaryText(reading, padded?.decoded.bytes ?? result.bytes, budget, padded?.decoded);
            if (boundaryText !== undefined) hits.push(...checkText(boundaryText, location, terms,
              { lineExemptions: false, imageDepth: depth + 1, budget, pieceSecrets: true }).filter(inlineDisclosure).map(atLocation));
          }
        }
        // A srcset descriptor after padding is attribute syntax, not another payload segment.
        return reading.bounded && !reading.srcset && padded && (padded.result.strict || (reading.prefixAllowed && padded.firstIsR1 && padded.decoded.restStrict))
          ? { ...padded.result, strict: true } : result;
      };
      const r1 = inspect(first);
      let authority = r1.strict ? r1 : undefined;
      for (const reading of readings) {
        const result = inspect(reading);
        if (reading.bounded && result.strict && (!authority || result.dataLength > authority.dataLength)) authority = result;
        if (base64 && reading.bounded && !reading.chain && reading.prefixAllowed && !result.strict) {
          const prefix = inlineBoundedPrefix(reading, budget);
          if (prefix && prefix.payload.length > firstPayload.length) readings.push(prefix);
        }
      }
      // Keep the documented uppercase replacement-variable form quiet. Its decoded readings
      // still contribute disclosures, and arbitrary suffixes never exempt a binary prefix.
      const replacement = readings.some((reading) => reading.url && /^[A-Z_]+_(?:REPLACE_ME|BASE64_HERE)$/.test(reading.payload));
      const judgment = authority ?? r1;
      hits.push(...(replacement && judgment === r1 ? judgment.firstHits.filter(inlineDisclosure) : judgment.firstHits).map(atLocation));
    } catch (error) {
      if (error instanceof BudgetExceeded) throw error;
      if (nonempty || syntax.malformedBody(pattern.lastIndex)) hits.push(safeLocation(location, terms) + ": invalid or oversized inline image");
    }
  }
  return [...new Set(hits)];
}

function utf32Bom(buffer: Buffer): boolean {
  return buffer.length >= 4 && [0x0000feff, 0xfffe0000].includes(buffer.readUInt32LE(0));
}

function utf16Bom(buffer: Buffer): boolean {
  return buffer.length >= 2 && [0xfeff, 0xfffe].includes(buffer.readUInt16LE(0));
}

function rawBomViews(buffer: Buffer, file: string, terms: PrivateTerms, depth: number, budget: ScanBudget): string[] {
  budget.spend(buffer.length * 2);
  return (["utf8", "latin1"] as const).flatMap((encoding) =>
    checkText(buffer.toString(encoding), file, terms, { lines: true, attribution: true, lineExemptions: false, imageDepth: depth, budget }),
  );
}

export function checkBuffer(
  buffer: Buffer,
  file: string,
  terms: PrivateTerms,
  attribution: boolean,
  lineExemptions = true,
  depth = 0,
  budget?: ScanBudget,
): string[] {
  if (!budget) {
    try { return checkBuffer(buffer, file, terms, attribution, lineExemptions, depth, new ScanBudget()); }
    catch (error) {
      if (!(error instanceof BudgetExceeded)) throw error;
      return [safeLocation(file, terms) + ": scan expansion budget exceeded"];
    }
  }
  if (buffer.length > EXPANDED_BYTES) return [safeLocation(file, terms) + ": file exceeds size limit"];
  const unknown = safeLocation(file, terms) + ": binary file of unknown type";
  if (utf32Bom(buffer)) return [...new Set([unknown, ...rawBomViews(buffer, file, terms, depth, budget)])];
  if (utf16Bom(buffer)) {
    const encoding = buffer[0] === 0xff ? "utf-16le" : "utf-16be";
    budget.spend(buffer.length);
    const decoded = new TextDecoder(encoding).decode(buffer);
    return [...new Set([
      ...(decoded.includes("\0") ? [unknown] : []),
      ...checkText(decoded, file, terms, { attribution: true, lines: true, lineExemptions: false, imageDepth: depth, budget }),
      ...rawBomViews(buffer, file, terms, depth, budget),
    ])];
  }
  if (buffer.includes(0)) {
    const binary = knownBinary(buffer, file);
    const hits = binary ? [] : [unknown];
    hits.push(...rawTermViews(buffer, file, terms, budget));
    if (binary) {
      if (buffer.length > ASSET_BYTES) hits.push(safeLocation(file, terms) + ": asset exceeds size limit");
      hits.push(...binarySecrets(buffer, file, terms, budget));
      const extension = path.extname(file).toLowerCase();
      if (extension === ".woff" || extension === ".woff2") hits.push(...checkFont(buffer, file, terms, depth, budget));
      if (extension === ".ttf" || extension === ".otf") hits.push(...checkSfnt(buffer, file, terms, depth, budget));
    }
    if (buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) hits.push(...checkPng(buffer, file, terms, depth, budget));
    return [...new Set(hits)];
  }
  const decoded = buffer.toString("utf8");
  const hits = checkText(decoded, file, terms, { attribution, lines: true, lineExemptions, imageDepth: depth, budget });
  if (!isUtf8(buffer)) {
    const utf8Hits = new Set(hits);
    budget.spend(buffer.length);
    hits.push(...checkText(buffer.toString("latin1"), file, terms, { lines: true, generic: false, budget })
      .filter((hit) => !utf8Hits.has(hit)));
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
      if (stat.size > EXPANDED_BYTES) return [`${safeLocation(location, terms)}: file exceeds size limit`];
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
  const advertised = [...new Set([...destination.refs].filter(([ref]) => /^refs\/(?:heads|tags)\//.test(ref)).map(([, oid]) => oid))];
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
    return error instanceof PublicCheckError ? error.exitCode : 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
