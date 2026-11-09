// Decide on commands as written: a guardrail against direct calls by a steered or careless
// agent, not a sandbox. Covers Claude Code's Bash and Monitor only, including sub-agents.
// Codex runs its own shell; its sandbox must have no network access and no gh credentials.
// Limits: executors not on the list, remote shells, directory stacks and git -C,
// GIT_DIR=… and export GIT_DIR=…, git update-ref, git worktree prune, computed key names,
// wrappers taking shell strings, writes through programs the guard cannot see into (archive
// extraction, build tools), and code in repository files run by a command. Aliases, unmodelled
// git configuration, tracing switches, earlier links, unresolved paths and commands assembled
// from substitutions or files can also route around it. Recursive readers of .private-terms
// are not followed. Rewriting git metadata or other files as the owner can defeat any
// in-repository hook. Filesystem aliases (symlinks, bind mounts and /proc paths created or
// chosen outside the command) are not resolved. Absolute-path narrowing is limited to
// temporary descendants. Copies inside loops, functions or repeated executors cannot narrow.
// Another statement at any nesting level disables narrowing when it writes an overlapping
// path, has an unresolved write target, or executes code in/from the copy. A mkdir/rm/rmdir
// statement targeting only the destination itself is exempt; strict overlaps still deny.
// Input redirects are reads; output options and write redirects are writes. Narrowing is also
// disabled by links made inside the command.
// cd/pushd retain up to eight candidate directories, then collapse to unknown. They do not
// model shell control flow, filesystem aliases, CDPATH or wrapper working directories.
// Unknown cwd protects relative global config names.
// HOME/XDG and pwd spellings are lexical; repository scripts (including node bin/wt.ts),
// arbitrary interpreter file writes and remote receiver behavior are not executed or traced.
// git -C <copy> or git --git-dir=<copy>/.git can execute copied config; direct execution
// of a copied script (cp -r src /tmp/out; /tmp/out/x.sh) is also not followed.
// Complete control belongs outside the repository: OS-level read restrictions and a worker
// token without issue scope.
// Inline interpreter file writes are not followed (only process launching and credential reads
// are); settings deny rules and git metadata checks cover direct writes.
// Aliased environment accessors cover only the enumerated spellings, not every language form.
// Aliased literal non-secret environment keys can be denied although their direct forms pass.
// The alias scan has superlinear cost, capped by the existing input and analysis limits.
// Protected wrapper output paths are checked against the outer cwd, not the wrapper's cwd.
// The loop/function detector misses some compound positions, shell forms and repeated wrappers.
// The PHP option table is incomplete; unlisted valued options can hide later code or info flags.
// mkdir with valued options before a copy can be denied even when it only creates D.
// Without a narrowed copy, writes such as rm -rf / are not covered by the overlap rule.
// Accepted false positives: broad recursive destinations outside strict temporary descendants,
// unresolved/glob copy operands, unknown copy options that could hide a target, any link plus
// a narrowed write (even unrelated), repeated copies (including literal loops and functions),
// and any overlapping or unresolved write: mkdir/rm/rmdir strictly beneath or above a copy,
// mixed-target directory operations, copy/move/link targets, wrapper
// output files, write redirects and unknown commands. Two flat copies or loop iterations
// into the same destination deny even when they would only copy ordinary files.
// This includes pnpm --dir /tmp/out test, node /tmp/out/x.js, cd/pushd into a temporary copy,
// and echo > /tmp/out/marker after a copy. Read-only cat/diff/grep/wc/head/git diff stay free.
// HOME/XDG bindings with git/gh/wt, duplicated or non-prefix safe pager/editor bindings,
// opaque path segments cancelled by .., HOME parameter operators treated as HOME, and global
// config names under unknown cwd or unknown HOME/XDG bindings are intentionally conservative.
// cd /tmp && echo x > ../.gitconfig is conservative even when cd would succeed.
// So are strict text matches
// such as ls .* or inline code naming GH_TOKEN, opaque executors/stdin and namerefs.
// Parse failures and fixed analysis limits deny: 32 nesting levels, 262144 aggregate body
// characters, 32768 work units, 256 path ancestors, and 512 code/config bindings. Literal
// values/brace products also have fixed bounds. No inspected command or probe is executed.
// bin/wt is trusted code read from the main checkout. Never execute the inspected command.
// Strict GraphQL --input allows .wt JSON; earlier background jobs can race the check and gh's read.
// Requires Node with native type stripping (the repo requires Node 24 or newer).
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";

type Finding = "token" | "private-terms" | "tamper" | "complex" | "write" | undefined;

// Token identity survives decoding and variable substitution; quoted operators are operands.
const operatorTokens = new WeakMap<string[], Set<number>>();
function isOperator(words: string[], index: number): boolean {
  return operatorTokens.get(words)?.has(index) ?? false;
}

const privateTerms = /(?:^|[^\w.-])\.private-terms(?=$|[^\w./-])/;
const githubEndpoint = /\b(?:api\.github\.com|uploads\.github\.com|github\.com\/graphql)\b/i;
// Scan these names only in API/client arguments and input, not ordinary prose or searches.
const issueMutation =
  /\b(?:(?:add|remove|clear|create|update|delete|close|reopen|transfer|lock|unlock|pin|unpin|convert|reorder|reprioritize|replace|set|mark|unmark)\w*(?:Issue|Label|BlockedBy|Blocking|Assignable)\w*|addComment|updateComment|deleteComment)\b/;
const allowedMutations = new Set(["addPullRequestReviewThreadReply", "resolveReviewThread"]);
const shellKeywords = new Set(["if", "then", "else", "elif", "do", "while", "until", "!"]);
const optionalXargsValues = new Set(["-e", "--eof", "-i", "--replace", "-l"]);
const assignment = /^[A-Za-z_]\w*=/;
const nonliteral = /[$`*?[]/;
const knownGhGroups = new Set([
  "pr",
  "run",
  "workflow",
  "repo",
  "search",
  "browse",
  "status",
  "release",
  "gist",
  "cache",
  "ruleset",
  "project",
  "secret",
  "variable",
  "codespace",
  "org",
  "attestation",
  "completion",
  "help",
  "version",
  "api",
  "issue",
  "label",
  "auth",
  "config",
  "alias",
  "extension",
]);

function strongest(a: Finding, b: Finding): Finding {
  if (a === "token" || b === "token") return "token";
  if (a === "private-terms" || b === "private-terms") return "private-terms";
  if (a === "tamper" || b === "tamper") return "tamper";
  if (a === "complex" || b === "complex") return "complex";
  return a ?? b;
}

// Two pointers with one remembered star; the target here has a fixed, short length.
// Adjacent wildcards collapse, so long patterns cannot trigger regex backtracking.
function wildcardMatch(pattern: string, target: string, prefix = false): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let retry = 0;
  while (t < target.length) {
    if (pattern[p] === "\u0000") {
      while (pattern[p] === "\u0000") p++;
      star = p - 1;
      retry = t;
    } else if (pattern[p] === target[t]) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++retry;
    } else return false;
  }
  if (prefix) return true;
  while (pattern[p] === "\u0000") p++;
  return p === pattern.length;
}

// Expand only brace words, never execute substitutions or consult the filesystem.
function braceChoice(text: string, start: number): { end: number; choices: string[] } | undefined {
  let quote = "";
  let depth = 0;
  let last = start + 1;
  const choices: string[] = [];
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) return undefined;
    if (c === "{") depth++;
    if (c === "}" && depth-- === 0) {
      if (choices.length) return { end: i, choices: [...choices, text.slice(last, i)] };
      const range = text.slice(last, i).match(/^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(?:\.\.(-?\d+))?$/);
      if (!range) return undefined;
      const numeric = /^-?\d+$/.test(range[1]) && /^-?\d+$/.test(range[2]);
      const from = numeric ? Number(range[1]) : range[1].charCodeAt(0);
      const to = numeric ? Number(range[2]) : range[2].charCodeAt(0);
      const step = Math.abs(Number(range[3] ?? 1)) || 1;
      const count = Math.floor(Math.abs(to - from) / step) + 1;
      if (!Number.isSafeInteger(count) || count > 256) throw new AnalysisLimit();
      const padded = numeric && /^-?0\d/.test(range[1] + range[2]);
      return {
        end: i,
        choices: Array.from({ length: count }, (_, n) => {
          const value = from + n * step * (from <= to ? 1 : -1);
          return numeric
            ? padded
              ? String(value).padStart(Math.max(range[1].length, range[2].length), "0")
              : String(value)
            : String.fromCharCode(value);
        }),
      };
    }
    if (c === "," && depth === 0) {
      choices.push(text.slice(last, i));
      last = i + 1;
    }
  }
  return undefined;
}

function braceWords(word: string, depth = 0): string[] {
  if (depth > 32) throw new AnalysisLimit();
  let quote = "";
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (word[i] === quote) quote = "";
      continue;
    }
    if (word[i] === "'" || word[i] === '"') {
      quote = word[i];
      continue;
    }
    if (word.startsWith("${", i)) {
      i = parameterEnd(word, i);
      continue;
    }
    if (word[i] !== "{") continue;
    const brace = braceChoice(word, i);
    if (!brace) continue;
    const result: string[] = [];
    for (const choice of brace.choices) {
      result.push(...braceWords(word.slice(0, i) + choice + word.slice(brace.end + 1), depth + 1));
      if (result.length > 256) throw new AnalysisLimit();
    }
    return result;
  }
  return [word];
}

function privateTermsWord(word: string, dotglob = false): boolean {
  const wildcard = "\u0000";
  const expanded = word
    .replace(/^[^\s=]+=/, "")
    .replace(/\$\([^)]*\)|\$\{[^}]*\}|\$[A-Za-z_]\w*|\$[0-9@*#?$!-]|`[^`]*`/g, wildcard);
  let segment = expanded.slice(expanded.lastIndexOf("/") + 1);
  if (segment.endsWith("(D)")) {
    dotglob = true;
    segment = segment.slice(0, -3);
  }
  if (!dotglob && !segment.startsWith(".") && !segment.startsWith(wildcard)) return false;
  const pattern = segment.replace(/\{[^},]*\}|\[[^\]]*\]|[?*]/g, wildcard);
  // A bare unknown variable still keeps the existing behavior. Dotglob enables bare globs.
  if (!pattern.replaceAll(wildcard, "") && !(dotglob && /[?*[]/.test(segment))) return false;
  return wildcardMatch(pattern, ".private-terms");
}

function protectedPath(word: string, locations?: Locations): boolean {
  if (locations?.cwdCandidates)
    return candidateLocations(locations).some((candidate) => protectedPath(word, candidate));
  const value = operandValue(word);
  const normalized = path.posix.normalize(value);
  if (/^\$(?:GIT_CONFIG_GLOBAL|\{GIT_CONFIG_GLOBAL\})$/.test(value)) return true;
  let globalConfig = locationValue(value, locations);
  // Never let normalize cancel an opaque segment and thereby erase its possible HOME prefix.
  if (/[$`]/.test(globalConfig) && globalConfig.split("/").includes("..")) return true;
  globalConfig = path.posix.normalize(globalConfig);
  if (
    !/^~/.test(globalConfig) &&
    !/[$`]/.test(globalConfig) &&
    typeof locations?.cwd === "string" &&
    path.posix.isAbsolute(locations.cwd)
  )
    globalConfig = path.posix.resolve(locations.cwd, globalConfig);
  const home = locations?.home;
  if (home && path.posix.isAbsolute(home) && path.posix.isAbsolute(globalConfig)) {
    const homeParts = path.posix.normalize(home).split("/");
    const parts = globalConfig.split("/");
    if (homeParts.every((part, i) => parts[i] === part || credentialComponent(parts[i] ?? "", part, true)))
      globalConfig = `~/${parts.slice(homeParts.length).join("/")}`;
  }
  const unknownCwd = typeof locations?.cwd !== "string" || !path.posix.isAbsolute(locations.cwd);
  const boundConfig =
    (locations?.boundHomes ?? []).some((bound) => globalConfigPath(relativeHome(value, bound, locations))) ||
    (locations?.boundXdg ?? []).some((bound) =>
      pathContains(path.posix.join(bound, "git"), absoluteLocation(value, locations) ?? ""),
    ) ||
    (locations?.unknownHome && /(?:^|\/)(?:\.gitconfig$|\.config\/git(?:\/|$))/.test(normalized)) ||
    (locations?.unknownXdg && /(?:^|\/)git(?:\/|$)/.test(normalized));
  const basename = path.posix.basename(normalized);
  const directory = path.posix.dirname(normalized);
  const basenameScope = !value.replace(/\/+$/, "").includes("/") || /(?:^|\/)\.claude$/.test(directory);
  // Bare filename globs do not reach dot directories. An explicit guard-* name still identifies a guard.
  const namedBasename = !/[*?[{]/.test(basename) || basename.startsWith("guard-");
  return (
    globalConfigPath(globalConfig) ||
    boundConfig ||
    (unknownCwd && !path.posix.isAbsolute(value) && /(?:^|\/)(?:\.gitconfig$|\.config\/git(?:\/|$))/.test(normalized)) ||
    (unknownCwd && !path.posix.isAbsolute(value) && globalConfigPath(`~/${normalized.replace(/^(?:\.\.?\/)+/, "")}`)) ||
    /(?:^|\/)\.git(?:\/|$)/.test(value) ||
    /(?:^|\/)\.git(?:\/|$)/.test(normalized) ||
    /(?:^|\/)\.codex(?:\/|$)/.test(normalized) ||
    /(?:^|\/)\.claude\/?$/.test(normalized) ||
    /(?:^|\/)\.claude\/(?:hooks(?:\/|$)|settings(?:\.local)?\.json$)/.test(normalized) ||
    protectedGlobPath(normalized) ||
    (basenameScope && namedBasename && protectedBasename(basename))
  );
}

function locationValue(value: string, locations?: Locations): string {
  const home = locations?.home ?? "~";
  let globalConfig = value;
  const parameter = value.match(/^\$\{(HOME|XDG_CONFIG_HOME)(?=\W)/);
  if (parameter) {
    const end = parameterEnd(value, 0);
    globalConfig = (parameter[1] === "HOME" ? home : `${home}/.config`) + value.slice(end + 1);
  } else {
    globalConfig = value
      .replace(/^(?:~|\$HOME)(?=\/|$)/, home)
      .replace(/^\$XDG_CONFIG_HOME(?=\/|$)/, `${home}/.config`);
  }
  if (typeof locations?.cwd === "string")
    globalConfig = globalConfig.replace(/^(?:\$PWD|\$\{PWD\}|\$\(pwd\)|`pwd`)(?=\/|$)/, locations.cwd);
  return globalConfig;
}

function absoluteLocation(value: string, locations?: Locations): string | undefined {
  value = locationValue(value, locations);
  if (/[$`*?[{]/.test(value) || value.startsWith("~")) return undefined;
  if (path.posix.isAbsolute(value)) return path.posix.normalize(value);
  if (typeof locations?.cwd === "string" && path.posix.isAbsolute(locations.cwd))
    return path.posix.resolve(locations.cwd, value);
  return undefined;
}

function relativeHome(value: string, home: string, locations?: Locations): string {
  const absolute = absoluteLocation(value, { ...locations, home });
  return absolute && pathContains(home, absolute) ? `~/${path.posix.relative(home, absolute)}` : "";
}

function globalConfigPath(value: string): boolean {
  if (!value.startsWith("~/")) return false;
  const parts = value.slice(2).replace(/\/+$/, "").split("/");
  return (
    (parts.length === 1 && protectedDirectoryPattern(parts[0], ".gitconfig")) ||
    (parts.length >= 2 &&
      protectedDirectoryPattern(parts[0], ".config") &&
      credentialComponent(parts[1], "git", false, true))
  );
}

function operandValue(word: string): string {
  return word.replace(/^(?:--?[^=]+|[A-Za-z_]\w*)=/, "").replace(/^-(?:o|C|d|T)(?=.)/, "");
}

function protectedBasename(name: string): boolean {
  // An unresolved expansion is not itself a filename glob. Braces in code are not brace lists.
  const expanded = maskExpansions(name).replaceAll("\u0000", "\u0001");
  const pattern = expanded.replace(/\[[^\]]*\]|[?*]/g, "\u0000");
  return (
    wildcardMatch(pattern, "guard-", true) ||
    ["settings.json", "settings.local.json", "hooks"].some((target) => wildcardMatch(pattern, target))
  );
}

// Skip shell substitutions/quotes as units so their braces never close an outer parameter.
function substitutionEnd(text: string, start: number, backtick: boolean, level = 0): number {
  if (level > 32) throw new AnalysisLimit();
  let depth = 1;
  let quote = "";
  for (let i = start + (backtick ? 1 : 2); i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (backtick && c === "`") return i;
    if (quote === "'") {
      if (c === "'") quote = "";
      continue;
    }
    if (text.startsWith("${", i)) {
      i = parameterEnd(text, i, level + 1);
      continue;
    }
    if (text.startsWith("$(", i) || c === "`") {
      i = substitutionEnd(text, i, c === "`", level + 1);
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (!backtick && c === "(") depth++;
    if (!backtick && c === ")" && --depth === 0) return i;
  }
  throw new Error("unfinished substitution");
}

function parameterEnd(text: string, start: number, level = 0): number {
  if (level > 32) throw new AnalysisLimit();
  let quote = "";
  for (let i = start + 2; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = "";
      continue;
    }
    if (text.startsWith("$(", i) || c === "`") {
      i = substitutionEnd(text, i, c === "`", level + 1);
      continue;
    }
    if (text.startsWith("${", i)) {
      i = parameterEnd(text, i, level + 1);
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "}") return i;
  }
  throw new Error("unfinished parameter expansion");
}

function maskExpansions(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("${", i)) {
      let end: number;
      try {
        end = parameterEnd(text, i);
      } catch {
        result += text.slice(i);
        break;
      }
      result += "\u0000";
      i = end;
    } else result += text[i];
  }
  return result.replace(/\$\([^)]*\)|\$[A-Za-z_]\w*|`[^`]*`/g, "\u0000");
}

function protectedGlobPath(value: string): boolean {
  if (!/[*?[{]/.test(value)) return false;
  const parts = value.split("/");
  return parts.some(
    (part, i) =>
      protectedDirectoryPattern(part, ".git") ||
      protectedDirectoryPattern(part, ".codex") ||
      (protectedDirectoryPattern(part, ".claude") &&
        (i === parts.length - 1 ||
          credentialComponent(parts[i + 1], "hooks", false, true) ||
          (i === parts.length - 2 &&
            ["settings.json", "settings.local.json"].some((tail) =>
              credentialComponent(parts[i + 1], tail, false, true),
            )))),
  );
}

function protectedDirectoryPattern(part: string, name: string): boolean {
  return /^(?:\.|\[\.\]|\?)/.test(part) && credentialComponent(part, name, true);
}

type WriteOwner = string[] | undefined;
type WriteIndex = {
  owners: WriteOwner[];
  directories: WriteOwner[];
  executors: WriteOwner[];
  below: WriteOwner[];
  children: Map<string, WriteIndex>;
};
type WriteEffects = {
  copies: WriteIndex;
  writes: WriteIndex;
  unknown: WriteOwner[];
  blocked: boolean;
  analysis: Analysis;
};
type Locations = {
  cwd?: unknown;
  cwdCandidates?: (string | undefined)[];
  projectDir?: string;
  home?: string;
  tmpdir?: string;
  writes?: WriteEffects;
  repeated?: boolean;
  noTemporary?: boolean;
  statement?: string[];
  boundHomes?: string[];
  boundXdg?: string[];
  unknownHome?: boolean;
  unknownXdg?: boolean;
  backupBound?: boolean;
};

function candidateLocations(locations?: Locations): Locations[] {
  return locations?.cwdCandidates
    ? locations.cwdCandidates.map((cwd) => ({ ...locations, cwd, cwdCandidates: undefined }))
    : [locations ?? {}];
}

function pathContains(directory: string, target: string): boolean {
  const root = path.posix.normalize(directory).replace(/\/+$/, "") || "/";
  const value = path.posix.normalize(target).replace(/\/+$/, "") || "/";
  return value === root || value.startsWith(root === "/" ? "/" : `${root}/`);
}

function expandingTilde(raw: string): boolean {
  raw = raw.replace(/\\\r?\n/g, "");
  let quote = "";
  const isAssignment = assignment.test(raw);
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "~" && (i === 0 || (isAssignment && /[=:]/.test(raw[i - 1])))) return true;
  }
  return false;
}

function findStartProtected(start: string, locations?: Locations, raw = start): boolean {
  if (locations?.cwdCandidates)
    return candidateLocations(locations).some((candidate) => findStartProtected(start, candidate, raw));
  return braceWords(start).some((value) => {
    const normalized = path.posix.normalize(value).replace(/\/+$/, "");
    if (
      normalized === "." ||
      /^(?:\.\.)(?:\/\.\.)*$/.test(normalized) ||
      /[$`*?[{]/.test(value) ||
      expandingTilde(raw) ||
      /(?:^|\/)\.(?:claude|git)(?:\/|$)/.test(value) ||
      protectedPath(value, locations)
    )
      return true;
    const home = locations?.home ?? "/";
    if (!path.posix.isAbsolute(value)) {
      if (!value.split("/").includes("..")) return false;
      if (typeof locations?.cwd !== "string" || !path.posix.isAbsolute(locations.cwd)) return true;
      return findStartProtected(path.posix.resolve(locations.cwd, value), locations);
    }
    const absolute = normalized || "/";
    const roots = [locations?.cwd, locations?.projectDir ?? locations?.cwd, home];
    const custom = locations?.tmpdir;
    const safeTmpdir =
      custom &&
      path.posix.isAbsolute(custom) &&
      path.posix.normalize(custom) !== "/" &&
      roots.every((root) => typeof root === "string" && path.posix.isAbsolute(root) && !pathContains(custom, root));
    const temporary =
      !locations?.noTemporary &&
      !locations?.repeated &&
      ["/tmp", safeTmpdir ? custom : undefined].some((root) => {
        if (!root || !path.posix.isAbsolute(root)) return false;
        const directory = path.posix.normalize(root).replace(/\/+$/, "");
        return absolute !== (directory || "/") && absolute.startsWith(`${directory}/`);
      });
    if (!temporary) return true;
    // Only ancestors can contain the protected roots. Missing/relative context stays broad;
    // paths are compared lexically, without reading directories or resolving symlinks.
    return roots.some((root) => {
      if (typeof root !== "string" || !path.posix.isAbsolute(root)) return true;
      return pathContains(absolute, root);
    });
  });
}

function canonicalPath(value: string): string {
  return path.posix.normalize(value).replace(/\/+$/, "") || "/";
}

function writeIndex(): WriteIndex {
  return { owners: [], directories: [], executors: [], below: [], children: new Map() };
}

function addOwner(owners: WriteOwner[], owner: WriteOwner): void {
  // A query excludes only its own statement; two distinct owners suffice.
  if (owners.length < 2 && !owners.includes(owner)) owners.push(owner);
}

function recordWrite(target: string | undefined, locations?: Locations, narrowed = false, directoryOnly = false, insideOnly = false): void {
  const state = locations?.writes;
  if (!state) return;
  const owner = locations.statement;
  for (const candidate of candidateLocations(locations)) {
    analysisWork(state.analysis, 1);
    const absolute = target === undefined ? undefined : absoluteLocation(target, candidate);
    if (absolute === undefined) {
      if (narrowed) state.blocked = true;
      else {
        addOwner(state.unknown, owner);
        state.blocked ||= state.copies.below.some((other) => other !== owner);
      }
      continue;
    }
    const canonical = canonicalPath(absolute);
    const parts = canonical === "/" ? [] : canonical.split("/");
    if (parts.length > 256) throw new AnalysisLimit();
    const index = narrowed ? state.copies : state.writes;
    const opposing = narrowed ? state.writes : state.copies;
    if (narrowed) state.blocked ||= state.unknown.some((other) => other !== owner);
    let stored = index;
    let queried: WriteIndex | undefined = opposing;
    for (const part of parts) {
      analysisWork(state.analysis, 1);
      state.blocked ||= queried?.owners.some((other) => other !== owner) ?? false;
      state.blocked ||= queried?.directories.some((other) => other !== owner) ?? false;
      queried = queried?.children.get(part);
      let child = stored.children.get(part);
      if (!child) { child = writeIndex(); stored.children.set(part, child); }
      // below contains strictly deeper paths, never this node's own targets.
      addOwner(stored.below, owner);
      stored = child;
    }
    // Execution in D or below D counts; execution in a strict ancestor of D does not.
    if (!insideOnly) state.blocked ||= queried?.below.some((other) => other !== owner) ?? false;
    if (narrowed) state.blocked ||= queried?.executors.some((other) => other !== owner) ?? false;
    if (!directoryOnly) state.blocked ||= queried?.owners.some((other) => other !== owner) ?? false;
    if (insideOnly) addOwner(stored.executors, owner);
    else addOwner(directoryOnly ? stored.directories : stored.owners, owner);
  }
}

function rememberTemporary(target: string, locations?: Locations): void {
  recordWrite(target, locations, true);
}

function findTamper(args: string[], locations?: Locations, rawArgs = args): boolean {
  const actions = new Set(["-delete"]);
  const predicates = new Set(["-name", "-iname", "-path", "-ipath"]);
  let i = 0;
  while (/^-[HLP]$|^-O\d+$|^-D$/.test(args[i] ?? "")) i += args[i] === "-D" ? 2 : 1;
  const starts: string[] = [];
  const startSources: string[] = [];
  while (i < args.length && !/^[-!()]|^,$/.test(args[i])) {
    startSources.push(rawArgs[i]);
    starts.push(args[i++]);
  }
  if (!starts.length) starts.push(".");
  const atRoot = starts.some((start) => [".", ".."].includes(path.posix.normalize(start)));
  let action = false;
  let outputTamper = false;
  let protectedOperand = starts.some((start, index) => findStartProtected(start, locations, startSources[index]));
  for (; i < args.length; i++) {
    if (["-fprint", "-fprint0", "-fprintf", "-fls"].includes(args[i])) {
      const format = args[i] === "-fprintf";
      const target = args[++i] ?? "";
      outputTamper ||= protectedPath(target, locations);
      if (format) i++;
      continue;
    }
    if (["-printf", "-regex", "-iregex"].includes(args[i])) {
      i++;
      continue;
    }
    if (["-exec", "-execdir", "-ok", "-okdir"].includes(args[i])) {
      const start = ++i;
      while (i < args.length && ![";", "+"].includes(args[i])) i++;
      const executed = args.slice(start, i);
      const resolved = resolveCommand(executed);
      const reader = path.basename(executed[resolved.index] ?? "");
      action ||=
        !!resolved.shell ||
        !!resolved.split ||
        wrapperTargets(executed, resolved).some((word) => protectedPath(word, locations)) ||
        executed.slice(0, resolved.index).some((word) => assignment.test(word)) ||
        !readOnlyCommand(reader, executed.slice(resolved.index + 1));
      protectedOperand ||= executed.some((word) => protectedPath(word, locations));
    } else if (predicates.has(args[i])) {
      const predicate = args[i++];
      const value = predicate.startsWith("-i") ? (args[i] ?? "").toLowerCase() : (args[i] ?? "");
      protectedOperand ||=
        protectedPath(value, locations) ||
        (atRoot && ["-name", "-iname"].includes(predicate) && protectedBasename(value));
    } else {
      action ||= actions.has(args[i]);
      protectedOperand ||= protectedPath(args[i], locations);
    }
  }
  if (action)
    for (const [index, start] of starts.entries())
      if (
        !findStartProtected(start, locations, startSources[index]) &&
        findStartProtected(start, { ...locations, noTemporary: true }, startSources[index])
      )
        rememberTemporary(start, locations);
  return outputTamper || (action && protectedOperand);
}

const findChildSources = new WeakMap<string[], string[]>();
function findChildren(args: string[], rawArgs = args): string[][] {
  const children: string[][] = [];
  const values = new Set([
    "-name",
    "-iname",
    "-path",
    "-ipath",
    "-regex",
    "-iregex",
    "-printf",
    "-fprint",
    "-fprint0",
    "-fls",
    "-type",
    "-xtype",
    "-user",
    "-group",
    "-size",
    "-mtime",
    "-mmin",
    "-newer",
    "-maxdepth",
    "-mindepth",
  ]);
  for (let i = 0; i < args.length; i++) {
    if (["-exec", "-execdir", "-ok", "-okdir"].includes(args[i])) {
      const start = ++i;
      while (i < args.length && ![";", "+"].includes(args[i])) i++;
      const child = args.slice(start, i);
      children.push(child);
      findChildSources.set(child, rawArgs.slice(start, i));
    } else if (args[i] === "-fprintf") i += 2;
    else if (values.has(args[i])) i++;
  }
  return children;
}

// Exact option names only. Optional values must be attached; unknown options lose the exception.
function harmlessOptions(
  args: string[],
  switches: string,
  values = "",
  optional = "",
  pairs = "",
  stopAtOperand = false,
): boolean {
  const flags = new Set(switches.split(" "));
  const valued = new Set(values.split(" "));
  const attached = new Set(optional.split(" "));
  const two = new Set(pairs.split(" "));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return true;
    if (!arg.startsWith("-") || arg === "-") {
      if (stopAtOperand) break;
      continue;
    }
    if (arg.startsWith("--")) {
      const name = arg.split("=", 1)[0];
      if (two.has(name)) {
        if (arg.includes("=") || i + 2 >= args.length) return false;
        i += 2;
      } else if (valued.has(name)) {
        if (!arg.includes("=") && (++i >= args.length || /^--?[^\d]/.test(args[i]))) return false;
      } else if (!attached.has(name) && !(flags.has(name) && !arg.includes("="))) return false;
    } else {
      if ((!valued.has(arg) && flags.has(arg)) || (/^-\d+$/.test(arg) && flags.has("-NUMBER"))) continue;
      for (let j = 1; j < arg.length; j++) {
        const name = `-${arg[j]}`;
        if (valued.has(name)) {
          if (j === arg.length - 1 && ++i >= args.length) return false;
          break;
        }
        if (attached.has(name)) break;
        if (!flags.has(name)) return false;
      }
    }
  }
  return true;
}

const readerOptions: Record<string, [string, string?, string?, string?]> = {
  cat: [
    "-A -b -e -E -n -s -t -T -u -v --show-all --number-nonblank --show-ends --number --squeeze-blank --show-tabs --show-nonprinting",
  ],
  less: [
    "-E -F -G -i -I -J -K -m -M -n -N -q -Q -r -R -s -S -u -U -V -X --quit-at-eof --quit-if-one-screen --ignore-case --IGNORE-CASE --RAW-CONTROL-CHARS --chop-long-lines --no-init",
    "-p -x -z -j --pattern --tabs --window --jump-target",
  ],
  head: ["-q -v -z -NUMBER --quiet --silent --verbose --zero-terminated", "-c -n --bytes --lines"],
  tail: [
    "-q -v -z -F -NUMBER --quiet --silent --verbose --zero-terminated --retry",
    "-c -n -s --bytes --lines --sleep-interval --pid",
    "-f --follow",
  ],
  wc: ["-c -m -l -L -w --bytes --chars --lines --max-line-length --words", "--files0-from", "--total"],
  grep: [
    "-E -F -G -P -i -w -x -v -s -q -b -n -H -h -o -a -I -r -R -l -L -c -Z -z --extended-regexp --fixed-strings --basic-regexp --perl-regexp --ignore-case --word-regexp --line-regexp --invert-match --no-messages --quiet --silent --byte-offset --line-number --with-filename --no-filename --only-matching --text --recursive --dereference-recursive --files-with-matches --files-without-match --count --null --null-data --line-buffered",
    "-e -f -A -B -C -m --regexp --file --after-context --before-context --context --max-count --include --exclude --exclude-dir --binary-files --directories --devices --label",
    "--color --colour",
  ],
  rg: [
    "-i -s -S -v -w -x -F -P -U -a -n -N -H -I -l -L -c -q -o -r -z -0 --hidden --no-ignore --no-ignore-vcs --files --count --count-matches --files-with-matches --files-without-match --quiet --only-matching --line-number --no-line-number --with-filename --no-filename --heading --no-heading --stats --json --multiline --multiline-dotall --pcre2 --fixed-strings --ignore-case --case-sensitive --smart-case --invert-match --word-regexp --line-regexp --text --null --null-data --follow --trim --sort-files --no-config",
    "-e -f -g -t -T -A -B -C -m -j --regexp --file --glob --iglob --type --type-not --after-context --before-context --context --max-count --threads --color --colors --encoding --max-depth --max-filesize --sort --sortr --replace --pre-glob",
  ],
  ls: [
    "-a -A -b -B -c -C -d -f -F -g -G -h -H -i -l -L -m -n -N -o -p -q -Q -r -R -s -S -t -u -U -v -w -x -X -Z -1 --all --almost-all --directory --human-readable --inode --numeric-uid-gid --reverse --recursive --size --literal --quote-name",
    "--block-size --format --hide --ignore --indicator-style --quoting-style --sort --time --time-style --width",
    "--color --classify --hyperlink",
  ],
  stat: ["-L -f -t --dereference --file-system --terse", "-c --format --printf", "--cached"],
  file: [
    "-b -c -i -k -l -L -n -N -p -r -s -z -Z -0 --brief --checking-printout --mime --mime-type --mime-encoding --keep-going --dereference --no-buffer --no-pad --preserve-date --raw --special-files --uncompress",
    "-e -f -F -m -P --exclude --exclude-quiet --files-from --separator --magic-file --parameter",
  ],
  test: [
    "-a -b -c -d -e -f -g -G -h -k -L -n -N -O -p -r -s -S -t -u -v -w -x -z -o -eq -ne -gt -ge -lt -le -ef -nt -ot",
  ],
  diff: [
    "-a -b -B -c -d -i -N -q -r -s -t -T -u -w -y --text --ignore-space-change --ignore-blank-lines --minimal --ignore-case --new-file --brief --recursive --report-identical-files --expand-tabs --initial-tab --ignore-all-space --side-by-side",
    "-C -U -I -x -X -W --ignore-matching-lines --exclude --exclude-from --width --label",
    "--color --context --unified",
  ],
  jq: [
    "-n -R -s -r -c -j -a -S -C -M -e --null-input --raw-input --slurp --raw-output --raw-output0 --compact-output --join-output --ascii-output --sort-keys --color-output --monochrome-output --exit-status --tab --unbuffered --stream --stream-errors --seq --args --jsonargs",
    "-f -L --from-file --indent",
    "",
    "--arg --argjson --slurpfile --rawfile",
  ],
  bat: [
    "-n -p -P -A -l --number --plain --show-all --no-paging",
    "--style --color --theme --language --line-range --highlight-line --tabs --wrap --terminal-width --paging --map-syntax --ignored-suffix",
    "--decorations",
  ],
  cut: [
    "-s -z --only-delimited --zero-terminated --complement",
    "-b -c -d -f --bytes --characters --delimiter --fields --output-delimiter",
  ],
  tr: ["-c -C -d -s -t --complement --delete --squeeze-repeats --truncate-set"],
  md5sum: ["-b -c -t -z --binary --check --text --zero --tag --ignore-missing --quiet --status --strict --warn"],
  sha256sum: ["-b -c -t -z --binary --check --text --zero --tag --ignore-missing --quiet --status --strict --warn"],
  cmp: ["-b -l -s --print-bytes --verbose --quiet --silent", "-i -n --ignore-initial --bytes"],
  realpath: [
    "-e -m -L -P -q -s -z --canonicalize-existing --canonicalize-missing --logical --physical --quiet --strip --no-symlinks --zero",
    "--relative-to --relative-base",
  ],
  readlink: [
    "-f -e -m -n -q -s -v -z --canonicalize --canonicalize-existing --canonicalize-missing --no-newline --quiet --silent --verbose --zero",
  ],
  basename: ["-a -z --multiple --zero", "-s --suffix"],
  dirname: ["-z --zero"],
  sort: [
    "-b -d -f -g -h -i -M -n -R -r -s -u -V -z --ignore-leading-blanks --dictionary-order --ignore-case --general-numeric-sort --human-numeric-sort --ignore-nonprinting --month-sort --numeric-sort --random-sort --reverse --stable --unique --version-sort --zero-terminated",
    "-k -t -S --key --field-separator --buffer-size --parallel --batch-size --files0-from --sort --random-source",
    "-c -C --check",
  ],
  uniq: [
    "-c -d -i -u -z --count --repeated --ignore-case --unique --zero-terminated",
    "-f -s -w --skip-fields --skip-chars --check-chars",
    "-D --all-repeated --group",
  ],
};

function gitConfigRead(args: string[]): boolean {
  const reads = new Set(["get", "get-all", "get-regexp", "get-urlmatch", "get-color", "get-colorbool", "list"]);
  const valued = new Set(["-f", "--file", "--blob", "--type", "--default"]);
  const words: string[] = [];
  let read = false;
  for (let i = 0; i < args.length; ) {
    if (args[i] === "--") {
      words.push(...args.slice(i + 1));
      break;
    }
    if (!args[i].startsWith("-")) {
      words.push(args[i++]);
      continue;
    }
    const flag = option(args, i, valued);
    if (flag.name === "-l" || reads.has(flag.name.replace(/^--/, ""))) read = true;
    else if (
      !valued.has(flag.name) &&
      ![
        "--global",
        "--system",
        "--local",
        "--worktree",
        "--includes",
        "--no-includes",
        "--show-origin",
        "--show-scope",
        "--name-only",
        "--null",
        "-z",
      ].includes(flag.name)
    )
      return false;
    i = flag.next;
  }
  return read || reads.has(words[0]) || words.length === 1;
}

function gitReadOnly(args: string[], environment?: Map<string, string>): boolean {
  let i = 0;
  const valued = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  while (args[i]?.startsWith("-")) {
    const flag = option(args, i, valued);
    if (
      !valued.has(flag.name) &&
      !["--no-pager", "--paginate", "--no-optional-locks", "--literal-pathspecs"].includes(flag.name)
    )
      return false;
    i = flag.next;
  }
  if (args[i] === "config") return gitFinding(args, environment) === undefined && gitConfigRead(args.slice(i + 1));
  if (
    ![
      "diff",
      "log",
      "show",
      "status",
      "blame",
      "ls-files",
      "ls-tree",
      "grep",
      "cat-file",
      "show-ref",
      "check-ignore",
      "rev-list",
    ].includes(args[i])
  )
    return false;
  if (gitFinding(args, environment) !== undefined) return false;
  return harmlessOptions(
    args.slice(i + 1),
    "-NUMBER -a -b -c -C -d -e -f -h -i -I -l -L -m -n -p -q -r -R -s -t -u -v -w -z --exit-code --show-signature --no-renames --find-renames --find-copies --follow --no-follow --check --binary --summary --compact-summary --patch-with-stat --patch-with-raw --full-index --relative --no-relative --ignore-cr-at-eol --ignore-space-at-eol --ignore-all-space --ignore-space-change --ignore-blank-lines --no-merges --merges --first-parent --decorate --no-decorate --graph --parents --children --not --objects --objects-edge --reflog --walk-reflogs --source --use-mailmap --no-use-mailmap --textconv --no-pager --short --no-color --cached --stage --others --deleted --modified --exclude-standard --name-only --name-status --oneline --stat --numstat --patch --no-patch --raw --abbrev-commit --all --head --heads --tags --verify --quiet --debug --full-name --full-tree --long --object-only --count --left-right --boundary --reverse --topo-order --date-order --no-ext-diff --no-textconv --show-origin --no-index --line-number --fixed-strings --ignore-case --invert-match --files-with-matches --files-without-match --batch-all-objects --unordered --text --recursive --match --verbose --non-matching --stdin",
    "-U -n -L -e -f -A -B -C --unified --inter-hunk-context --diff-filter --diff-algorithm --word-diff-regex --src-prefix --dst-prefix --line-prefix --anchored --encoding --skip --max-age --min-age --min-parents --max-parents --regexp-ignore-case --glob --branches --remotes --abbrev --ignore-matching-lines -S -G --grep --author --committer --since --until --format --pretty --date --max-count --abbrev --exclude --exclude-from --exclude-per-directory --sort",
    "-M -C --color --word-diff --color-moved --color-moved-ws --decorate --stat --dirstat --find-renames --find-copies --porcelain --untracked-files --ignore-submodules --batch --batch-check --batch-command --contains --merged --no-merged",
  );
}

function readOnlyCommand(command: string, args: string[], environment?: Map<string, string>): boolean {
  if (command === "[") command = "test";
  const options = readerOptions[command];
  if (options && !harmlessOptions(args, `${options[0]} --help --version`, options[1], options[2], options[3]))
    return false;
  if (command === "sed") return sedReadOnly(args);
  if (command === "sort") return sortReadOnly(args);
  if (command === "uniq") return uniqReadOnly(args);
  if (/^[gmn]?awk$/.test(command)) return awkReadOnly(args);
  if (command === "node") return nodeCheck(args);
  if (command === "git") return gitReadOnly(args, environment);
  return options !== undefined;
}

function sortReadOnly(args: string[]): boolean {
  const valued = new Set([
    "-k",
    "--key",
    "-t",
    "--field-separator",
    "-S",
    "--buffer-size",
    "-T",
    "--temporary-directory",
    "--parallel",
    "--batch-size",
    "--compress-program",
    "--files0-from",
    "--sort",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (/^--output(?:=|$)/.test(arg)) return false;
    if (arg.startsWith("--")) i = option(args, i, valued).next - 1;
    else if (arg.startsWith("-")) {
      for (let j = 1; j < arg.length; j++) {
        if (arg[j] === "o") return false;
        if (valued.has(`-${arg[j]}`)) {
          if (j === arg.length - 1) i++;
          break;
        }
      }
    }
  }
  return true;
}

function uniqReadOnly(args: string[]): boolean {
  const valued = new Set(["-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars"]);
  let operands = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") return operands + args.length - i - 1 <= 1;
    if (args[i].startsWith("-") && args[i] !== "-") {
      if (args[i].startsWith("--")) i = option(args, i, valued).next - 1;
      else
        for (let j = 1; j < args[i].length; j++) {
          if (valued.has(`-${args[i][j]}`)) {
            if (j === args[i].length - 1) i++;
            break;
          }
        }
    } else operands++;
  }
  return operands <= 1;
}

function awkReadOnly(args: string[]): boolean {
  const scripts: string[] = [];
  const valued = new Set(["-F", "-v", "-f", "--file", "-e", "--source", "-i", "--include", "-l", "--load"]);
  for (let i = 0; i < args.length; ) {
    if (args[i] === "--") {
      i++;
      if (!scripts.length && args[i]) scripts.push(args[i]);
      break;
    }
    if (!args[i].startsWith("-")) {
      if (!scripts.length) scripts.push(args[i]);
      i++;
      continue;
    }
    const flag = option(args, i, valued);
    if (!valued.has(flag.name) && !["--posix", "--traditional", "--sandbox", "--lint"].includes(flag.name))
      return false;
    if (["-f", "--file", "-l", "--load"].includes(flag.name)) return false;
    if (["-i", "--include"].includes(flag.name)) return false;
    if (["-e", "--source"].includes(flag.name)) {
      if (flag.value === undefined) return false;
      scripts.push(flag.value);
    }
    i = flag.next;
  }
  return scripts.length > 0 && scripts.every((script) => !/[>|]|\bsystem\s*\(/.test(awkCode(script)));
}

function nodeCheck(args: string[]): boolean {
  const valued = new Set(["--input-type", "-C", "--conditions"]);
  let check = false;
  for (let i = 0; i < args.length && args[i].startsWith("-"); ) {
    if (args[i] === "--") break;
    const flag = option(args, i, valued);
    if (["--check", "-c"].includes(flag.name)) check = true;
    else if (!valued.has(flag.name) && !["--no-warnings", "--experimental-strip-types"].includes(flag.name))
      return false;
    i = flag.next;
  }
  return check;
}

type CopyArity = "none" | "required" | "attached";
function copyOptionTable(text: string): Map<string, CopyArity> {
  return new Map(
    text
      .trim()
      .split(/\s+/)
      .map((word) => [
        word.replace(/[=?]$/, ""),
        word.endsWith("=") ? "required" : word.endsWith("?") ? "attached" : "none",
      ]),
  );
}

// GNU coreutils 9.12 cp(1) and rsync(1): client/daemon options, documented aliases and
// --no-OPTION forms. '=' takes an attached or separate value; '?' takes only an attached value.
// Tables and parsing are shared by destination analysis and link detection.
const copyOptions: Record<string, Map<string, CopyArity>> = {
  cp: copyOptionTable(`
    -a -b -d -f -H -i -l -L -n -P -p -R -r -s -T -u -v -x -Z --archive --attributes-only --copy-contents
    --debug --force --interactive --keep-directory-symlink --link --no-clobber --no-dereference
    --dereference --parents --recursive --remove-destination --strip-trailing-slashes --symbolic-link
    --no-target-directory --one-file-system --verbose --help --version -t= -S= --target-directory=
    --suffix= --no-preserve= --sparse= --backup? --preserve? --reflink? --update? --context?
  `),
  rsync: copyOptionTable(`
    --8-bit-output --acls --append --append-verify --archive --atimes --backup --blocking-io --checksum
    --compress --copy-devices --copy-dirlinks --copy-links --copy-unsafe-links --crtimes --cvs-exclude
    --daemon --del --delay-updates --delete --delete-after --delete-before --delete-delay --delete-during --delete-excluded --delete-missing-args --devices --dirs --drop-D --dry-run --executability
    --existing --fake-super --force --from0 --fsync --fuzzy --group --hard-links --help --human-readable
    --i-r --ignore-errors --ignore-existing --ignore-missing-args --ignore-non-existing --ignore-times
    --inc-recursive --inplace --insecure-links --ipv4 --ipv6 --itemize-changes --keep-dirlinks --links
    --list-only --mkpath --msgs2stderr --munge-links --no-8 --no-8-bit-output --no-A --no-D --no-H
    --no-J --no-N --no-O --no-R --no-S --no-U --no-W --no-X --no-acls --no-append --no-atimes --no-backup --no-blocking-io --no-bwlimit --no-c --no-checksum --no-compress --no-contimeout --no-crtimes
    --no-d --no-delay-updates --no-detach --no-devices --no-dirs --no-drop-D --no-force --no-from0 --no-fuzzy --no-g --no-group --no-h --no-hard-links --no-human-readable --no-i --no-i-d --no-i-r --no-iconv --no-ignore-errors --no-implied-dirs --no-inc-recursive --no-inplace --no-insecure-links --no-itemize-changes --no-l --no-links --no-m --no-mkpath --no-motd --no-msgs2stderr --no-munge-links
    --no-numeric-ids --no-o --no-old-args --no-omit-dir-times --no-omit-link-times --no-one-file-system
    --no-open-noatime --no-owner --no-p --no-partial --no-perms --no-progress --no-protect-args --no-prune-empty-dirs --no-recursive --no-s --no-secluded-args --no-sparse --no-super --no-t --no-timeout
    --no-times --no-v --no-verbose --no-whole-file --no-write-devices --no-x --no-xattrs --no-y --no-z
    --numeric-ids --old-args --old-d --old-dirs --omit-dir-times --omit-link-times --one-file-system
    --open-noatime --owner --partial --perms --preallocate --progress --protect-args --prune-empty-dirs
    --quiet --recursive --relative --remove-source-files --remove-sent-files --safe-links --secluded-args --size-only
    --sparse --specials --stats --super --times --trust-sender --update --verbose --version --whole-file
    --write-devices --xattrs -0 -4 -6 -8 -A -C -D -E -F -H -I -J -K -L -N -O -P -R -S -U -V -W -X -a -b
    -c -d -g -h -i -k -l -m -n -o -p -q -r -s -t -u -v -x -y -z --no-relative --no-specials --address=
    --backup-dir= --block-size= --bwlimit= --cc= --checksum-choice= --checksum-seed= --chmod= --chown=
    --compare-dest= --compress-choice= --compress-level= --compress-threads= --config= --confine-root=
    --contimeout= --copy-as= --copy-dest= --debug= --dparam= --early-input= --exclude= --exclude-from=
    --files-from= --filter= --groupmap= --iconv= --include= --include-from= --info= --link-dest= --log-file= --log-file-format= --max-alloc= --max-delete= --max-size= --min-size= --modify-window= --only-write-batch= --out-format= --outbuf= --partial-dir= --password-file= --port= --protocol= --read-batch= --remote-option= --rsh= --rsync-path= --skip-compress= --sockopts= --stderr= --stop-after=
    --stop-at= --suffix= --temp-dir= --time-limit= --timeout= --usermap= --write-batch= --zc= --zl=
    --zt= -@= -B= -M= -T= -e= -f= --no-r --no-b
  `),
  install: copyOptionTable(`
    -b -C -d -D -p -s -T -v --compare --directory --preserve-timestamps --strip --no-target-directory
    --verbose --help --version -t= -S= -m= -o= -g= --target-directory= --suffix= --mode= --owner=
    --group= --strip-program= --backup?
  `),
  mv: copyOptionTable(`
    -b -f -i -n -T -u -v -Z --backup? --debug --exchange --force --interactive --no-clobber
    --no-copy --no-target-directory --strip-trailing-slashes --update? --verbose --context?
    --help --version -t= -S= --target-directory= --suffix=
  `),
  ln: copyOptionTable(`
    -b -d -F -f -i -L -n -P -r -s -T -v --backup? --directory --force --interactive
    --logical --no-dereference --physical --relative --symbolic --no-target-directory --verbose
    --help --version -t= -S= --target-directory= --suffix=
  `),
};
type CopyOperand = { value: string; index: number };
type CopyFlag = { name: string; value?: string; index: number };
function parseCopy(
  command: string,
  args: string[],
  depth = 0,
): {
  operands: CopyOperand[];
  flags: CopyFlag[];
  uncertain: CopyOperand[];
  unknown: boolean;
} {
  if (depth > 16) throw new AnalysisLimit();
  const table = copyOptions[command];
  const flags: CopyFlag[] = [];
  const operands: CopyOperand[] = [];
  const uncertain: CopyOperand[] = [];
  let unknown = false;
  const unknownFlag = (index: number, value?: string) => {
    unknown = true;
    if (value !== undefined) uncertain.push({ value, index });
    if (args[index + 1] !== undefined && args[index + 1] !== "--")
      uncertain.push({ value: args[index + 1], index: index + 1 });
  };
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === "--") {
      operands.push(...args.slice(i + 1).map((value, offset) => ({ value, index: i + 1 + offset })));
      break;
    }
    if (!word.startsWith("-") || word === "-") {
      operands.push({ value: word, index: i });
      continue;
    }
    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      let name = equals < 0 ? word : word.slice(0, equals);
      let value = equals < 0 ? undefined : word.slice(equals + 1);
      if (!table.has(name)) {
        const matches = [...table.keys()].filter(
          (candidate) => candidate.startsWith("--") && candidate.startsWith(name),
        );
        if (matches.length === 1) name = matches[0];
      }
      const arity = table.get(name);
      if (!arity || (arity === "none" && value !== undefined)) {
        unknownFlag(i, value);
        continue;
      }
      let index = i;
      if (arity === "required" && value === undefined) {
        index = ++i;
        value = args[i];
      }
      if (arity === "required" && value === undefined) unknownFlag(i);
      flags.push({ name, value, index });
    } else {
      for (let j = 1; j < word.length; j++) {
        const name = `-${word[j]}`;
        const arity = table.get(name);
        if (!arity) {
          unknownFlag(i, word.slice(j + 1) || undefined);
          break;
        }
        let index = i;
        let value: string | undefined;
        if (arity !== "none") {
          value = word.slice(j + 1) || undefined;
          if (arity === "required" && value === undefined) {
            index = ++i;
            value = args[i];
          }
          if (arity === "required" && value === undefined) unknownFlag(i);
        }
        flags.push({ name, value, index });
        if (arity !== "none") break;
      }
    }
  }
  if (command === "rsync") {
    for (const flag of [...flags]) {
      if (!["-M", "--remote-option"].includes(flag.name) || flag.value === undefined) continue;
      const receiver = parseCopy("rsync", [flag.value], depth + 1);
      flags.push(...receiver.flags.map((nested) => ({ ...nested, index: flag.index })));
      uncertain.push(...[...receiver.uncertain, ...receiver.operands].map((item) => ({ ...item, index: flag.index })));
      unknown ||= receiver.unknown || receiver.operands.length > 0;
    }
  }
  return { operands, flags, uncertain, unknown };
}

function createsLink(command: string, args: string[]): boolean {
  if (command === "ln") return !(args.length === 1 && ["--help", "--version"].includes(args[0]));
  if (command === "rsync") return parseCopy(command, args).flags.some(({ name }) => name === "--link-dest");
  if (command !== "cp") return false;
  return parseCopy(command, args).flags.some(({ name }) => ["-s", "-l", "--symbolic-link", "--link"].includes(name));
}

function copyTargets(
  command: string,
  args: string[],
  locations?: Locations,
  rawArgs = args,
  environment?: Map<string, string>,
): string[] {
  const { operands, flags, uncertain, unknown } = parseCopy(command, args);
  const has = (...names: string[]) => flags.some(({ name }) => names.includes(name));
  if (command === "cp" && createsLink(command, args)) locations = { ...locations, noTemporary: true };
  if (command === "ln" && !has("-b", "--backup")) return args;
  const output = new Set([
    "-t",
    "--target-directory",
    "--backup-dir",
    "--log-file",
    "--temp-dir",
    "--partial-dir",
    "--write-batch",
    "--only-write-batch",
  ]);
  if (command === "rsync") output.add("-T");
  const targets: CopyOperand[] = flags
    .filter((flag) => output.has(flag.name) && flag.value !== undefined)
    .map((flag) => ({ value: flag.value as string, index: flag.index }));
  const targetDirectory = has("-t", "--target-directory") && command !== "rsync";
  const directoryMode = command === "install" && has("-d", "--directory");
  if (directoryMode && !unknown) return [...targets, ...operands].map(({ value }) => value);
  if (directoryMode) targets.push(...operands);
  if (!targetDirectory && operands.length) targets.push(operands.at(-1) as CopyOperand);
  const sources = targetDirectory ? operands : operands.slice(0, -1);
  // Consumed filter/exclude values are data, never unresolved source operands.
  if ([...operands, ...targets, ...uncertain].some(({ value }) => /[$`]/.test(value) || /^(?:[*?]|\[)/.test(value)))
    return [".claude"];
  const destination = targetDirectory
    ? targets.find(({ index }) =>
        flags.some((flag) => flag.index === index && ["-t", "--target-directory"].includes(flag.name)),
      )
    : operands.at(-1);
  const directoryDestination = targetDirectory || sources.length > 1 || /\/$/.test(destination?.value ?? "");
  const realDestinations = !destination
    ? []
    : directoryDestination
      ? sources.map(({ value }) => path.posix.join(destination.value, path.posix.basename(value)))
      : [
          destination.value,
          ...sources.map(({ value }) => path.posix.join(destination.value, path.posix.basename(value))),
        ];
  const destinationDirectories = !destination
    ? ["."]
    : directoryDestination || (command === "rsync" && sources.some(({ value }) => /\/$/.test(value)))
      ? [destination.value]
      : [destination.value, path.posix.dirname(destination.value)];
  const rsyncDirectories = (value: string) => candidateLocations(locations).flatMap(candidate => {
    const expanded = locationValue(value, candidate);
    return path.posix.isAbsolute(expanded) ? [expanded] :
      destinationDirectories.map(directory => path.posix.join(directory, expanded));
  });
  const backups = flags.reduce(
    (enabled, { name, value }) =>
      ["-b", "--backup", "--backup-dir"].includes(name)
        ? !["none", "off", "numbered", "t"].includes(value ?? "")
        : ["--no-b", "--no-backup"].includes(name)
          ? false
          : enabled,
    false,
  );
  if (backups && destination) {
    const suffix =
      (locations?.backupBound ? `\${SIMPLE_BACKUP_SUFFIX}` : undefined) ??
      flags.filter(({ name }) => ["-S", "--suffix"].includes(name)).at(-1)?.value ??
      environment?.get("SIMPLE_BACKUP_SUFFIX") ??
      "~";
    targets.push(...realDestinations.map((value) => ({ value: value + suffix, index: destination.index })));
  }
  if (command === "rsync" && destination) {
    for (const flag of flags) {
      if (
        ["--backup-dir", "--partial-dir", "--temp-dir", "-T"].includes(flag.name) &&
        flag.value !== undefined
      )
        targets.push(...rsyncDirectories(flag.value).map(value => ({ value, index: flag.index })));
    }
  }
  const recursive =
    command !== "ln" &&
    (unknown ||
      has("-r", "-a", "--recursive", "--archive") ||
      (command !== "rsync" && has("-R", "-T", "--no-target-directory")));
  const sourceRisk =
    unknown || sources.some(({ value }) => protectedPath(value, locations)) || (recursive && (sources.length > 0 || locations?.repeated));
  const preservesLinks = (command === "cp" && has("-P", "-d", "--no-dereference")) ||
    (command === "rsync" && has("-l", "--links"));
  const parents = command === "cp" && has("--parents");
  const relative =
    command === "rsync" &&
    flags.reduce(
      (enabled, { name }) =>
        ["-R", "--relative"].includes(name) || (enabled && !["--no-R", "--no-relative"].includes(name)),
      false,
    );
  if (parents || relative) {
    targets.push(
      ...targets.flatMap((target) =>
        sources.map((source) => {
          const marker = relative ? source.value.indexOf("/./") : -1;
          const kept = marker < 0 ? source.value : source.value.slice(marker + 3);
          return { value: path.posix.join(target.value, kept), index: target.index };
        }),
      ),
    );
  }
  targets.push(...uncertain);
  const linkedSources =
    command === "mv" || command === "ln"
      ? args
      : (command !== "rsync" && createsLink(command, args)) || has("--remove-source-files", "--remove-sent-files")
        ? sources.map(({ value }) => value)
        : [];
  if (command === "rsync") {
    for (const flag of flags.filter(({ name }) => name === "--link-dest")) {
      if (flag.value === undefined || /[$`*?[{]/.test(flag.value)) return [".claude"];
      linkedSources.push(...rsyncDirectories(flag.value));
    }
  }
  if (
    (sourceRisk || preservesLinks) &&
    (recursive ||
      preservesLinks ||
      (command === "rsync" && sources.some(({ value }) => /(?:^|\/)\.(?:claude|git)\/?$|[$`*?[]/.test(value))))
  ) {
    // Unknown directory contents can place a protected entry beneath any broad destination.
    return [
      ...linkedSources,
      ...targets.flatMap(({ value: target, index }) => {
        const broad = findStartProtected(target, locations, rawArgs[index]);
        if (!broad && findStartProtected(target, { ...locations, noTemporary: true }, rawArgs[index]))
          rememberTemporary(target, locations);
        return broad ? [target, path.posix.join(target, ".claude")] : [target];
      }),
    ];
  }
  return [...linkedSources, ...targets.map(({ value }) => value)];
}

function tamperCommand(
  command: string,
  args: string[],
  environment = false,
  configEnvironment?: Map<string, string>,
  locations?: Locations,
  rawArgs = args,
): boolean {
  // Loop lists and assignment-only statements are shell syntax, not a program's operands.
  if (!command || ["for", "select", "case", "fi", "done", "esac"].includes(command)) return false;
  if (command === "find") return findTamper(args, locations, rawArgs);
  if (command === "sed" && sedWriteTargets(args).some((word) => protectedPath(word, locations))) return true;
  if (!environment && readOnlyCommand(command, args, configEnvironment)) return false;
  if (["cp", "rsync", "install", "mv", "ln"].includes(command))
    return copyTargets(command, args, { ...locations, writes: undefined }, rawArgs, configEnvironment).some((word) =>
      protectedPath(word, locations),
    );
  const shellFlag = shells.has(command) ? args.findIndex((arg) => /^-[^-]*c/.test(arg)) : -1;
  const codes = interpreter.test(command) ? inlinePrograms(command, args) : [];
  return args.some(
    (arg, i) =>
      !(shellFlag >= 0 && i === shellFlag + 1) &&
      !codes.some((code) => arg === code || (arg.startsWith("-") && arg.endsWith(code))) &&
      protectedPath(arg, locations),
  );
}

function codeConfigKey(key: string): boolean {
  return !/^(?:color\..+|advice\..+|core\.(?:quotepath|abbrev)|log\.(?!.*(?:^|\.)(?:program|command)$)(?!program$|command$).+|diff\.(?:renames|noprefix|mnemonicprefix)|merge\.conflictstyle|user\.(?:name|email)|init\.defaultbranch)$/i.test(
    key,
  );
}

function configSettingUnsafe(key: string, value?: string): boolean {
  return (
    codeConfigKey(key) &&
    !(key.toLowerCase() === "core.pager" && value !== undefined && ["cat", "less", ""].includes(value))
  );
}

function gitConfigEnvironment(word: string, words: string[]): boolean {
  const match = word.match(/^GIT_CONFIG_([^=]+)=(.*)$/s);
  if (!match) return false;
  if (/^KEY_\d+$/.test(match[1])) {
    const keys = words.filter((word) => word.startsWith(`GIT_CONFIG_${match[1]}=`));
    const values = words.filter((word) => word.startsWith(`GIT_CONFIG_VALUE_${match[1].slice(4)}=`));
    const resolved = resolveCommand(words);
    const prefix = words.slice(0, resolved.index);
    const uniquePrefix =
      path.basename(words[resolved.index] ?? "") === "git" &&
      keys.length === 1 &&
      values.length === 1 &&
      prefix.includes(keys[0]) &&
      prefix.includes(values[0]);
    return configSettingUnsafe(match[2], uniquePrefix ? values[0].slice(values[0].indexOf("=") + 1) : undefined);
  }
  if (match[1] === "PARAMETERS") {
    const parsed = tokenize(match[2]);
    if (parsed.incomplete) return true;
    const settings = parsed.commands.flat();
    return settings.some((setting) => {
      const equals = setting.indexOf("=");
      const key = equals < 0 ? setting : setting.slice(0, equals);
      const duplicatePager =
        key.toLowerCase() === "core.pager" && settings.filter((setting) => /^core\.pager=/i.test(setting)).length !== 1;
      return configSettingUnsafe(key, equals < 0 || duplicatePager ? undefined : setting.slice(equals + 1));
    });
  }
  return !["COUNT", "NOSYSTEM"].includes(match[1]) && !/^VALUE_\d+$/.test(match[1]);
}

const gitCodeVariable =
  /^(?:GIT_(?:EXTERNAL_DIFF|SSH_COMMAND|SSH|ASKPASS|EDITOR|PAGER|SEQUENCE_EDITOR|PROXY_COMMAND|EXEC_PATH|TEMPLATE_DIR|CONFIG_\w*)|PAGER|EDITOR|VISUAL|SSH_ASKPASS|HOME|XDG_CONFIG_HOME)$/;
type GitBinding = {
  name: string;
  value?: string;
  prefix: boolean;
  unset: boolean;
  statement: string[];
  position: number;
};
type GitBindings = {
  runsGit: boolean;
  homeConsumer?: boolean;
  bindings: GitBinding[];
  children?: WeakMap<string[], Map<string, string[]>>;
};
const backupVariable = /^(?:SIMPLE_BACKUP_SUFFIX|VERSION_CONTROL)$/;

// Repeated analysis of one nested source position uses the same statement identity.
// Distinct positions stay distinct even when their shell text is identical.
function writtenStatement(state: GitBindings, parent: string[] | undefined, site: string, words: string[]): string[] {
  if (!parent) return words;
  state.children ??= new WeakMap();
  let children = state.children.get(parent);
  if (!children) {
    children = new Map();
    state.children.set(parent, children);
  }
  let written = children.get(site);
  if (!written) {
    written = words;
    children.set(site, written);
  }
  return written;
}

function safeGitProgram(name: string, value?: string): boolean {
  return (
    value !== undefined &&
    (["GIT_PAGER", "PAGER"].includes(name)
      ? ["cat", "less", ""].includes(value)
      : ["GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "EDITOR", "VISUAL"].includes(name) && ["true", ":", ""].includes(value))
  );
}

function bindingCount(bindings: GitBinding[]): number {
  const positions = new Map<string[], Set<number>>();
  for (const binding of bindings) {
    const seen = positions.get(binding.statement) ?? new Set<number>();
    seen.add(binding.position);
    positions.set(binding.statement, seen);
  }
  return [...positions.values()].reduce((sum, seen) => sum + seen.size, 0);
}

function gitPagerPrefixAllowed(word: string, words: string[], state?: GitBindings, statement = words): boolean {
  const equals = word.indexOf("=");
  if (equals < 0 || !safeGitProgram(word.slice(0, equals), word.slice(equals + 1))) return false;
  const name = word.slice(0, word.indexOf("=") + 1);
  const resolved = resolveCommand(words);
  return (
    path.basename(words[resolved.index] ?? "") === "git" &&
    words.slice(0, resolved.index).includes(word) &&
    words.filter((word) => word.startsWith(name)).length === 1 &&
    !!state?.bindings.some(
      (binding) => binding.statement === statement && binding.prefix && `${binding.name}=` === name,
    )
  );
}

// Record binding positions, not assignment-shaped prose in ordinary command arguments.
// The shared state also sees git and bindings in recursively inspected shell input.
function recordGitBindings(words: string[], state: GitBindings, statement = words, names = gitCodeVariable): void {
  const resolved = resolveCommand(words.map((word) => word.replace(/^([A-Za-z_]\w*)\+=/, "$1=")));
  const command = path.basename(words[resolved.index] ?? "");
  state.runsGit ||= command === "git";
  state.homeConsumer ||= ["git", "gh", "wt"].includes(command);
  const add = (word: string, position: number, prefix: boolean, unset = false) => {
    const match = word.match(/^([A-Za-z_]\w*)(?:(=|\+=)([\s\S]*))?$/);
    if (match && names.test(match[1])) {
      const binding = {
        name: match[1],
        value: match[2] === "=" ? match[3] : undefined,
        prefix,
        unset,
        statement,
        position,
      };
      if (
        !state.bindings.some(
          (other) =>
            other.statement === statement &&
            other.position === position &&
            other.name === binding.name &&
            other.value === binding.value &&
            other.prefix === prefix &&
            other.unset === unset,
        )
      )
        state.bindings.push(binding);
      if (state.bindings.length > 512) throw new AnalysisLimit();
    }
  };
  const optionValues = new Set<number>();
  for (const wrapper of resolved.wrappers) {
    for (let i = wrapper.index + 1; i < Math.min(wrapper.target, words.length); i++) {
      if (!words[i].startsWith("-") || words[i] === "--") continue;
      const bundle = optionBundle(words, i, wrapperOptions[wrapper.name]);
      for (const flag of bundle.flags)
        if (wrapper.name === "env" && ["-u", "--unset"].includes(flag.name)) add(flag.value ?? "", i, false, true);
      for (let j = i + 1; j < bundle.next; j++) optionValues.add(j);
      i = bundle.next - 1;
    }
  }
  for (let i = 0; i < resolved.index; i++)
    if (!optionValues.has(i) && /^[A-Za-z_]\w*\+?=/.test(words[i])) add(words[i], i, command === "git");
  const args = words.slice(resolved.index + 1);
  if (["for", "select"].includes(command) && args[1] === "in") add(args[0], resolved.index + 1, false);
  if (["read", "mapfile", "readarray"].includes(command)) {
    // Dynamic input has no literal value; only variable-name operands are recorded.
    const valued =
      command === "read"
        ? new Set(["-a", "-d", "-i", "-n", "-N", "-p", "-t", "-u"])
        : new Set(["-d", "-n", "-O", "-s", "-u", "-C", "-c"]);
    for (let j = 0; j < args.length; j++) {
      if (args[j].startsWith("-")) {
        const flag = option(args, j, valued);
        if (flag.name === "-a") add(flag.value ?? "", resolved.index + 1 + j, false);
        j = flag.next - 1;
      } else add(args[j], resolved.index + 1 + j, false);
    }
  }
  if (command === "printf") {
    for (let j = 0; j < args.length && args[j].startsWith("-"); j++) {
      const flag = option(args, j, new Set(["-v"]));
      if (flag.name === "-v") add(flag.value ?? "", resolved.index + 1 + j, false);
      j = flag.next - 1;
    }
  }
  if (["export", "declare", "typeset", "local", "readonly", "unset"].includes(command)) {
    const exported = command === "export" || args.some((arg) => /^-[^-]*x/.test(arg));
    for (const [index, arg] of args.entries()) {
      if (exported || command === "unset" || arg.includes("=") || arg.startsWith("GIT_CONFIG_"))
        add(arg, resolved.index + 1 + index, false, command === "unset");
      else if (["HOME", "XDG_CONFIG_HOME"].includes(arg)) add(arg, resolved.index + 1 + index, false);
      else if (["GIT_PAGER", "PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "EDITOR", "VISUAL"].includes(arg))
        add(arg, resolved.index + 1 + index, false, true);
      else if (backupVariable.test(arg)) add(arg, resolved.index + 1 + index, false);
    }
  }
}

function gitBindingsTamper(state: GitBindings): boolean {
  if (!state.runsGit && !state.homeConsumer) return false;
  const config = state.bindings.filter(({ name }) => name.startsWith("GIT_CONFIG_"));
  return state.bindings.some((binding) => {
    const { name, value, prefix, unset, statement } = binding;
    if (!state.runsGit && !["HOME", "XDG_CONFIG_HOME"].includes(name)) return false;
    if (name.startsWith("GIT_CONFIG_")) {
      if (!prefix) return true;
      if (!/^GIT_CONFIG_(?:COUNT|PARAMETERS|(?:KEY|VALUE)_\d+)$/.test(name)) return true;
      const local = config.filter((other) => other.statement === statement);
      if (bindingCount(local.filter((other) => other.name === name)) !== 1) return true;
      if (
        /^GIT_CONFIG_VALUE_\d+$/.test(name) &&
        !local.some((other) => other.name === name.replace("_VALUE_", "_KEY_"))
      )
        return true;
      if (name === "GIT_CONFIG_COUNT") {
        const keys = local.filter((other) => /^GIT_CONFIG_KEY_\d+$/.test(other.name));
        if (
          !/^\d+$/.test(value ?? "") ||
          bindingCount(keys) !== Number(value) ||
          keys.some(
            (key) => !/^(?:0|[1-9]\d*)$/.test(key.name.slice(15)) || Number(key.name.slice(15)) >= Number(value),
          )
        )
          return true;
      }
      // A pager's value exception cannot borrow or override configuration from another statement.
      return (
        (value?.toLowerCase() === "core.pager" || name === "GIT_CONFIG_PARAMETERS") &&
        config.some((other) => other.statement !== statement)
      );
    }
    if (unset) return false; // Still counts against a pager exception elsewhere in the command.
    return !(
      prefix &&
      safeGitProgram(name, value) &&
      bindingCount(state.bindings.filter((other) => other.name === name)) === 1
    );
  });
}

function configBindingRoots(parsed: ReturnType<typeof tokenize>, values: Values, inherited?: Locations): Locations {
  const state: GitBindings = { runsGit: false, bindings: [] };
  for (const words of parsed.commands) recordGitBindings(withoutRedirects(words), state);
  const result: Locations = {
    boundHomes: [...(inherited?.boundHomes ?? [])],
    boundXdg: [...(inherited?.boundXdg ?? [])],
    unknownHome: inherited?.unknownHome,
    unknownXdg: inherited?.unknownXdg,
  };
  for (const binding of state.bindings) {
    if (binding.unset || !["HOME", "XDG_CONFIG_HOME"].includes(binding.name)) continue;
    const roots = binding.name === "HOME" ? result.boundHomes : result.boundXdg;
    const choices =
      binding.value !== undefined && !/[$`]/.test(binding.value)
        ? [binding.value]
        : [...(values.get(binding.name) ?? [undefined])];
    for (const choice of choices) {
      if (choice !== undefined && path.posix.isAbsolute(choice) && !/[$`*?[{]/.test(choice)) roots?.push(choice);
      else if (binding.name === "HOME") result.unknownHome = true;
      else result.unknownXdg = true;
    }
  }
  return result;
}

function gitEnvironment(words: string[], bindings: Map<string, string>): Map<string, string> {
  const values = new Map(bindings);
  for (const word of words)
    if (assignment.test(word)) values.set(word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1));
  return values;
}

function gitConfigWrite(args: string[]): boolean {
  // Support both legacy flags and the get/set/unset subcommands. Only key operands matter:
  // a filename, a default value, or an unrelated key's value can contain a protected key name.
  const valued = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value"]);
  const reads = new Set(["get", "get-all", "get-regexp", "get-urlmatch", "get-color", "get-colorbool", "list"]);
  const writes = new Set([
    "set",
    "add",
    "replace-all",
    "unset",
    "unset-all",
    "rename-section",
    "remove-section",
    "edit",
  ]);
  const positionals: string[] = [];
  const actions: string[] = [];
  for (let i = 0; i < args.length; ) {
    if (args[i] === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!args[i].startsWith("-")) {
      positionals.push(args[i++]);
      continue;
    }
    const flag = option(args, i, valued);
    i = flag.next;
    const action = flag.name === "-l" ? "list" : flag.name === "-e" ? "edit" : flag.name.replace(/^--/, "");
    if (reads.has(action) || writes.has(action)) actions.push(action);
  }
  if (reads.has(positionals[0]) || writes.has(positionals[0])) actions.push(positionals.shift() as string);
  if (actions.includes("edit")) return true;
  // Moving/removing a whole section also changes its protected keys.
  if (actions.some((action) => ["rename-section", "remove-section"].includes(action))) {
    return positionals.slice(0, 2).some((section) => !/^(?:color|advice)(?:\.|$)/i.test(section));
  }
  const key = positionals[0] ?? "";
  if (!configSettingUnsafe(key, positionals[1])) return false;
  return (
    actions.some((action) => writes.has(action)) ||
    (!actions.some((action) => reads.has(action)) && positionals.length > 1)
  );
}

function gitFinding(args: string[], environment = new Map<string, string>()): Finding {
  let i = 0;
  const valued = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  let config: Finding;
  while (args[i]?.startsWith("-")) {
    const flag = option(args, i, valued);
    if (["-c", "--config-env"].includes(flag.name)) {
      const setting = flag.value ?? "";
      const equals = setting.indexOf("=");
      const key = equals < 0 ? setting : setting.slice(0, equals);
      const raw = equals < 0 ? undefined : setting.slice(equals + 1);
      const value = flag.name === "--config-env" ? environment.get(raw ?? "") : raw;
      if (configSettingUnsafe(key, value)) config = "tamper";
    }
    i = flag.next;
  }
  const group = args[i];
  if (
    (group === "credential" && ["fill", "get"].includes(args[i + 1])) ||
    (group?.startsWith("credential-") && credentialHelperGet(args.slice(i + 1)))
  )
    return "token";
  if (config || (group === "config" && gitConfigWrite(args.slice(i + 1)))) return "tamper";
  const subcommand = args.slice(i + 1).find((arg) => !arg.startsWith("-"));
  if (group === "worktree" && ["move", "repair", "remove", "add"].includes(subcommand ?? "")) return "tamper";
  if (["init", "clone"].includes(group) && args.slice(i + 1).some((arg) => /^--separate-git-dir(?:=|$)/.test(arg)))
    return "tamper";
  if (group === "submodule" && subcommand === "absorbgitdirs") return "tamper";
  return undefined;
}

function credentialHelperGet(args: string[]): boolean {
  // Helper option vocabularies vary; a literal get requests credentials regardless of preceding flags.
  return args.includes("get");
}

function gitShellPrograms(args: string[]): { value: string; index: number }[] {
  const scripts: { value: string; index: number }[] = [];
  const globals = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  let i = 0;
  while (args[i]?.startsWith("-")) i = option(args, i, globals).next;
  if (args[i++] !== "rebase") return scripts;
  const valued = new Set(["-x", "--exec", "--exe", "--ex", "--onto", "-s", "--strategy", "-X", "--strategy-option"]);
  for (; i < args.length; ) {
    if (args[i] === "--") break;
    if (!args[i].startsWith("-")) {
      i++;
      continue;
    }
    const bundle = optionBundle(args, i, valued);
    for (const flag of bundle.flags)
      if (["-x", "--exec", "--exe", "--ex"].includes(flag.name) && flag.value !== undefined)
        scripts.push({ value: flag.value, index: i });
    i = bundle.next;
  }
  return scripts;
}

// No expansion or execution. Preserve quoted arguments, join adjacent quoted word fragments,
// and collect command substitutions separately (also when they appear inside double quotes).
function tokenize(
  text: string,
  loose = false,
  expansionsOnly = false,
): {
  commands: string[][];
  nested: { words: string[]; body: string }[];
  inputs: { words: string[]; body: string; literal: boolean; expand: boolean }[];
  sources: Map<string[], string[]>;
  pipes: Map<string[], string[]>;
  fed: Set<string[]>;
  credentials: boolean;
  scoped: Set<string[]>;
  repeated: Set<string[]>;
  incomplete: boolean;
} {
  const commands: string[][] = [];
  const nested: { words: string[]; body: string }[] = [];
  const inputs: { words: string[]; body: string; literal: boolean; expand: boolean }[] = [];
  const pending: { words: string[]; delimiter: string; stripTabs: boolean; literal: boolean }[] = [];
  const sources = new Map<string[], string[]>();
  const pipes = new Map<string[], string[]>();
  const fed = new Set<string[]>();
  const scoped = new Set<string[]>();
  const repeated = new Set<string[]>();
  const functionDepths: number[] = [];
  let functionPending = false;
  let groupDepth = 0;
  let pipelineStage = false;
  let blockDepth = 0;
  let producer: string[] | undefined;
  let previous: string[] | undefined;
  let words: string[] = [];
  let wordStart = -1;
  let cursor = 0;
  let word = "";
  let started = false;
  let quote = expansionsOnly ? '"' : "";
  let credentials = false;
  let incomplete = false;
  const flushWord = () => {
    if (started) {
      const previous = isOperator(words, words.length - 1) ? words.at(-1) : undefined;
      if (
        words.every((prefix) => ["then", "else", "do", "!"].includes(prefix)) &&
        text.slice(wordStart, cursor) === word
      ) {
        if (["if", "for", "while", "until", "select", "case"].includes(word)) blockDepth++;
        if (["fi", "done", "esac"].includes(word)) blockDepth = Math.max(0, blockDepth - 1);
      }
      words.push(word);
      const source = sources.get(words) ?? [];
      source.push(text.slice(wordStart, cursor));
      sources.set(words, source);
      if (previous === "<<" || previous === "<<-")
        pending.push({
          words,
          delimiter: word,
          stripTabs: previous === "<<-",
          literal: /['"\\]/.test(text.slice(wordStart, cursor)),
        });
      if (previous === "<<<")
        inputs.push({ words, body: word, literal: !/[$`]/.test(word) || text[wordStart] === "'", expand: false });
    }
    word = "";
    started = false;
    wordStart = -1;
  };
  const flushCommand = () => {
    flushWord();
    if (words.length) {
      commands.push(words);
      if (groupDepth > 0 || blockDepth > 0) scoped.add(words);
      if (functionDepths.length) repeated.add(words);
      if (pipelineStage) fed.add(words);
      pipelineStage = false;
      if (producer) pipes.set(words, producer);
      producer = undefined;
      previous = words;
    }
    words = [];
  };
  try {
    for (let i = 0; i < text.length; i++) {
      cursor = i;
      const c = text[i];
      if (wordStart < 0 && !/\s/.test(c)) wordStart = i;
      if (c === "\n" && !quote) {
        flushCommand();
        for (const input of pending.splice(0)) {
          const lines: string[] = [];
          let closed = false;
          while (i < text.length) {
            const start = i + 1;
            const end = text.indexOf("\n", start);
            const line = text.slice(start, end < 0 ? text.length : end);
            i = end < 0 ? text.length : end;
            if ((input.stripTabs ? line.replace(/^\t+/, "") : line) === input.delimiter) {
              closed = true;
              break;
            }
            lines.push(line);
          }
          if (!closed) throw new Error("unfinished heredoc");
          inputs.push({
            words: input.words,
            body: lines.join("\n"),
            literal: input.literal || !/[$`]/.test(lines.join("\n")),
            expand: !input.literal,
          });
        }
        continue;
      }
      if (quote === "'" || quote === "$'") {
        if (c === "'") quote = "";
        else if (quote === "$'" && c === "\\") {
          const escaped = text
            .slice(i + 1)
            .match(/^(?:x[\da-fA-F]{1,2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|[0-7]{1,3}|.)/s)?.[0];
          if (!escaped) throw new Error("unfinished escape");
          const simple: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            b: "\b",
            a: "\x07",
            e: "\x1b",
            f: "\f",
            v: "\v",
          };
          word += /^[xuU]/.test(escaped)
            ? String.fromCodePoint(Number.parseInt(escaped.slice(1), 16))
            : /^[0-7]/.test(escaped)
              ? String.fromCodePoint(Number.parseInt(escaped, 8))
              : (simple[escaped] ?? escaped);
          i += escaped.length;
        } else word += c;
        continue;
      }
      if (c === "\\") {
        if (++i === text.length) throw new Error("unfinished escape");
        if (text[i] !== "\n") {
          // In double quotes, only these backslashes are removed by the shell.
          if (quote === '"' && !/[\\$`"]/.test(text[i])) word += "\\";
          word += text[i];
          started = true;
        }
        continue;
      }
      if (c === "$") {
        const namesOnly = /^\$\{!(?:[A-Za-z_]\w*\[[@*]\]|[A-Za-z_]\w*[*@])\}/.test(text.slice(i));
        if (text.startsWith("${!", i) && !namesOnly) credentials = true;
        const name = text.slice(i).match(/^\$(?:\{!?([A-Za-z_]\w*)|([A-Za-z_]\w*))/);
        if (!namesOnly && name && credentialNames.has(name[1] ?? name[2])) credentials = true;
      }
      if (c === "$" && text[i + 1] === "{") {
        const end = parameterEnd(text, i);
        const parameters = tokenize(text.slice(i + 2, end), false, true);
        nested.push(...parameters.nested.map((entry) => ({ words, body: entry.body })));
        credentials ||= parameters.credentials;
        incomplete ||= parameters.incomplete;
        word += text.slice(i, end + 1);
        started = true;
        i = end;
        continue;
      }
      if (c === "`" || (c === "$" && text[i + 1] === "(")) {
        const backtick = c === "`";
        const start = i + (backtick ? 1 : 2);
        let depth = 1;
        let innerQuote = "";
        let end = start;
        for (; end < text.length; end++) {
          const ch = text[end];
          if (ch === "\\" && innerQuote !== "'") {
            end++;
            continue;
          }
          if (backtick && ch === "`") break;
          if (innerQuote) {
            if (ch === innerQuote) innerQuote = "";
          } else if (ch === "'" || ch === '"') innerQuote = ch;
          else if (!backtick && ch === "(") depth++;
          else if (!backtick && ch === ")" && --depth === 0) break;
        }
        if (end === text.length) throw new Error("unfinished substitution");
        nested.push({ words, body: text.slice(start, end) });
        word += text.slice(i, end + 1);
        started = true;
        i = end;
        continue;
      }
      if (quote === '"') {
        if (c === '"' && !expansionsOnly) quote = "";
        else word += c;
        continue;
      }
      if (c === "'" || c === '"' || (c === "$" && text[i + 1] === "'")) {
        quote = c === "$" ? "$'" : c;
        if (c === "$") i++;
        started = true;
      } else if (text.slice(i, i + 2) === "{}") {
        word += "{}";
        started = true;
        i++;
      } else if ((c === "{" && (started || braceChoice(text, i))) || (c === "}" && word.includes("{"))) {
        // Braces inside a word, such as repos/{owner}/{repo}, are not shell groups.
        word += c;
        started = true;
      } else if (c === "(" && started && text.slice(i, i + 3) === "(D)") {
        word += "(D)";
        i += 2;
      } else if (c === "(" && text[i + 1] === "(") {
        flushCommand();
        const end = text.indexOf("))", i + 2);
        if (end < 0) throw new Error("unfinished arithmetic");
        const expression = text.slice(i, end + 2);
        words.push(expression);
        sources.set(words, [expression]);
        nested.push({ words, body: text.slice(i + 2, end) });
        flushCommand();
        i = end + 1;
      } else if (/[;|&\n(){}]/.test(c)) {
        flushCommand();
        const signature = c === "(" && /^\(\s*\)/.test(text.slice(i));
        if (signature) functionPending = true;
        if ((c === "{" || c === "(") && !signature && (functionPending || previous?.[0] === "function")) {
          functionDepths.push(groupDepth + 1);
          functionPending = false;
        }
        if (c === "(" || c === "{") groupDepth++;
        if ((c === "}" && groupDepth === 0) || (c === ")" && groupDepth === 0 && blockDepth === 0)) incomplete = true;
        if (c === ")" || c === "}") groupDepth = Math.max(0, groupDepth - 1);
        if ((c === "}" || c === ")") && groupDepth < (functionDepths.at(-1) ?? 0)) functionDepths.pop();
        if (c === "|" && text[i + 1] !== "|") {
          pipelineStage = true;
        }
        if (/[(){}]/.test(c)) previous = undefined; // A group/subshell is never a literal producer.
        producer = c === "|" && text[i + 1] !== "|" ? previous : undefined;
        if ((c === "|" || c === "&") && text[i + 1] === c) i++;
        wordStart = -1;
      } else if (loose && /[[\],!]/.test(c)) flushWord();
      else if (/\s/.test(c)) flushWord();
      else if (c === "#" && !started) {
        while (i < text.length && text[i] !== "\n") i++;
        flushCommand();
        i--; // Let the newline consume pending heredocs, including after a comment.
      } else if (c === "<" || c === ">") {
        // Retain targets for sensitive-path checks, but mark operators so leading
        // redirections (including file descriptors) cannot hide the command word.
        if (/^\d+$/.test(word)) {
          word = "";
          started = false;
        }
        flushWord();
        const operator = text.slice(i).match(/^(?:<<<|<<-|>>|<<|<>|>&|<&|>\||[<>])/)?.[0] ?? c;
        const operators = operatorTokens.get(words) ?? new Set<number>();
        operators.add(words.length);
        operatorTokens.set(words, operators);
        words.push(operator);
        const source = sources.get(words) ?? [];
        source.push(operator);
        sources.set(words, source);
        wordStart = -1;
        i += operator.length - 1;
      } else {
        word += c;
        started = true;
      }
    }
    if (quote && !expansionsOnly) throw new Error("unfinished quote");
  } catch {
    incomplete = true;
  }
  cursor = text.length;
  flushCommand();
  incomplete ||=
    pending.length > 0 ||
    groupDepth > 0 ||
    blockDepth > 0 ||
    commands.some((command) => isOperator(command, command.length - 1));
  return { commands, nested, inputs, sources, pipes, fed, credentials, scoped, repeated, incomplete };
}

const wrapperOptions: Record<string, Set<string>> = Object.fromEntries(
  Object.entries({
    env: "-u --unset -C --chdir -S --split-string -a --argv0",
    command: "",
    builtin: "",
    exec: "-a",
    nohup: "",
    time: "-f --format -o --output",
    strace: "-o --output -e --expr -p --attach -P --trace-path -s --string-limit -u --user",
    ltrace: "-o -e -p -s -u -l -x -A -S",
    nice: "-n --adjustment",
    flock: "-E --conflict-exit-code -w --wait -c --command",
    setsid: "",
    ionice: "-c --class -n --classdata -p --pid -P --pgid -u --uid",
    chrt: "-T --sched-runtime -P --sched-period -D --sched-deadline",
    taskset: "",
    script: "-c --command -O --log-out -I --log-in -B --log-io -T --log-timing -m --logging-format",
    su: "-c --command -s --shell -g --group -G --supp-group -w --whitelist-environment",
    runuser: "-u --user -c --command -s --shell -g --group -G --supp-group -w --whitelist-environment",
    doas: "-u -C",
    busybox: "",
    pnpm: "-C --dir --filter --filter-prod",
    npx: "-p --package -c --call",
    timeout: "-k --kill-after -s --signal",
    sudo: "-u --user -g --group -h --host -p --prompt -C --close-from -T --command-timeout -r --role -t --type -D --chdir -R --chroot",
    parallel:
      "-j --jobs -S --sshlogin --colsep -a --arg-file -N --max-args -n -I --replace --tagstring --results --joblog",
    xargs:
      "-a --arg-file -d --delimiter -E -e --eof -I -i --replace -L -l --max-lines -n --max-args -P --max-procs -s --max-chars --process-slot-var",
  }).map(([name, options]) => [name, new Set(options.split(" "))]),
);

function optionBundle(
  words: string[],
  i: number,
  valued: Set<string>,
): { flags: { name: string; value?: string }[]; next: number } {
  const word = words[i];
  if (word.startsWith("--") || word.length <= 2) {
    const flag = option(words, i, valued);
    return { flags: [flag], next: flag.next };
  }
  const flags: { name: string; value?: string }[] = [];
  for (let j = 1; j < word.length; j++) {
    const name = `-${word[j]}`;
    if (valued.has(name)) {
      flags.push({ name, value: word.slice(j + 1) || words[i + 1] });
      return { flags, next: i + (j < word.length - 1 ? 1 : 2) };
    }
    flags.push({ name });
  }
  return { flags, next: i + 1 };
}

// Return the option name/value for both separated and attached short/long forms.
function option(words: string[], i: number, valued: Set<string>): { name: string; value?: string; next: number } {
  const word = words[i];
  if (!word.startsWith("--") && word.length > 2 && valued.has(word.slice(0, 2))) {
    return { name: word.slice(0, 2), value: word.slice(2).replace(/^=/, ""), next: i + 1 };
  }
  const equals = word.indexOf("=");
  if (equals >= 0) return { name: word.slice(0, equals), value: word.slice(equals + 1), next: i + 1 };
  if (valued.has(word)) return { name: word, value: words[i + 1], next: i + 2 };
  return { name: word, next: i + 1 };
}

function skipFlags(words: string[], start: number): number {
  const valued = new Set(["-R", "--repo", "--hostname", "-h", "--host"]);
  while (words[start]?.startsWith("-")) start = option(words, start, valued).next;
  return start;
}

// Inspect mutation root fields, not just their names anywhere in the document. Aliases cannot
// hide a second write, nor can an allowed field in a string, argument or nested selection.
function graphqlWrite(query: string): boolean {
  if (query.startsWith("@") || !query.includes("{")) return true;
  const tokens = (query.match(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\r\n]*|\.\.\.|[_A-Za-z][_0-9A-Za-z]*|[^\s,]/g) ?? [])
    .filter((token) => !token.startsWith("#"))
    .map((token) => (token.startsWith('"') ? '""' : token));
  const skipGroup = (start: number): number => {
    const close = tokens[start] === "(" ? ")" : tokens[start] === "{" ? "}" : "]";
    let i = start + 1;
    while (i < tokens.length && tokens[i] !== close) {
      i = ["(", "{", "["].includes(tokens[i]) ? skipGroup(i) : i + 1;
    }
    if (i === tokens.length) throw new Error("unfinished GraphQL group");
    return i + 1;
  };
  try {
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== "mutation") continue;
      while (++i < tokens.length && tokens[i] !== "{") {
        if (tokens[i] === "(") i = skipGroup(i) - 1;
      }
      if (i === tokens.length) return true;
      let fields = 0;
      for (i++; i < tokens.length && tokens[i] !== "}"; ) {
        // Root fragments are opaque; refusing them also covers writes hidden in fragments.
        if (tokens[i] === "...") return true;
        if (tokens[i + 1] === ":") i += 2;
        if (!allowedMutations.has(tokens[i])) return true;
        fields++;
        i++;
        if (tokens[i] === "(") i = skipGroup(i);
        while (tokens[i] === "@") {
          i += 2;
          if (tokens[i] === "(") i = skipGroup(i);
        }
        if (tokens[i] === "{") i = skipGroup(i);
      }
      if (!fields || tokens[i] !== "}") return true;
    }
  } catch {
    return true;
  }
  return false;
}

function apiWrite(words: string[]): boolean {
  // gh api's value-taking flags; do not mistake a preview/header/etc. value for the endpoint.
  const valued = new Set([
    "-X",
    "--method",
    "-f",
    "-F",
    "--field",
    "--raw-field",
    "--input",
    "-H",
    "--header",
    "--hostname",
    "-q",
    "--jq",
    "-t",
    "--template",
    "--cache",
    "-p",
    "--preview",
  ]);
  const switches = new Set(["--paginate", "--slurp", "--silent", "-i", "--include", "--verbose", "--help"]);
  const positionals: string[] = [];
  let unknownFlag = false;
  let method: string | undefined;
  let body = false;
  let input = false;
  const queries: string[] = [];
  for (let i = 0; i < words.length; ) {
    if (words[i] === "--") {
      positionals.push(...words.slice(i + 1));
      break;
    }
    if (!words[i].startsWith("-")) {
      positionals.push(words[i]);
      i++;
      continue;
    }
    const bundle = optionBundle(words, i, valued);
    i = bundle.next;
    for (const flag of bundle.flags) {
      unknownFlag ||=
        (!valued.has(flag.name) && !switches.has(flag.name)) || (valued.has(flag.name) && flag.value === undefined);
      if (flag.name === "-X" || flag.name === "--method") method = flag.value ?? "unknown";
      if (["-f", "-F", "--field", "--raw-field", "--input"].includes(flag.name)) {
        body = true;
        input ||= flag.name === "--input";
        if (flag.value?.startsWith("query=")) queries.push(flag.value.slice(6));
      }
    }
  }
  if (issueMutation.test(words.join(" "))) return true;
  if (positionals[0]?.replace(/^\//, "") === "graphql") {
    if (input || queries.length === 0 || queries.some(graphqlWrite)) return true;
    // Only this unambiguous GraphQL request gets the read-query exception to implied POST.
    if (
      positionals.length === 1 &&
      positionals[0] === "graphql" &&
      !unknownFlag &&
      (method === undefined || method.toUpperCase() === "POST")
    )
      return false;
  }
  return unknownFlag || !["GET", "HEAD"].includes((method ?? (body ? "POST" : "GET")).toUpperCase());
}

function ghFinding(words: string[], namedGh = true): Finding {
  const start = skipFlags(words, 0);
  const group = words[start];
  const subcommandIndex = skipFlags(words, start + 1);
  const subcommand = words[subcommandIndex];
  if (group === "auth" && (subcommand !== "status" || words.some((word) => /^--show-token(?:=|$)|^-[^-]*t/.test(word))))
    return "token";
  if (group === "config" && subcommand === "get") {
    const keys: string[] = [];
    for (let i = subcommandIndex + 1; i < words.length; ) {
      if (words[i].startsWith("-")) i = option(words, i, new Set(["-h", "--host", "--hostname"])).next;
      else keys.push(words[i++]);
    }
    if (keys.some((key) => /token/i.test(key))) return "token";
  }
  // Unknown groups may be aliases when gh is literal or named in an expansion's text.
  // A variable program with an ordinary file operand (for example $EDITOR file) is not one.
  if (namedGh && group && !knownGhGroups.has(group)) return "write";
  if (group === "alias" && !["list", "help"].includes(subcommand)) return "write";
  if (group === "extension" && !["list", "search", "browse", "help"].includes(subcommand)) return "write";
  if (group === "issue" && !["view", "list", "ls", "status"].includes(subcommand)) return "write";
  if (group === "label" && !["list", "ls"].includes(subcommand)) return "write";
  if (words.some((word) => /^--(?:add|remove)-label(?:=|$)/.test(word))) return "write";
  if (
    subcommand === "create" &&
    words.some((word) => /^--label(?:=|$)/.test(word) || (["issue", "pr"].includes(group) && /^-l/.test(word)))
  )
    return "write";
  if (group === "api" && apiWrite(words.slice(start + 1))) return "write";
  return undefined;
}

type Values = Map<string, Set<string | undefined>>;
type Context = {
  bindings: Map<string, string>;
  values?: Values;
  dotglob: boolean;
  locations?: Locations;
  gitBindings?: GitBindings;
  backupBindings?: GitBindings;
  statement?: string[];
  analysis?: Analysis;
};
class AnalysisLimit extends Error {}

type Analysis = {
  work: number;
  characters: number;
  exhausted: boolean;
  bodies: WeakMap<string[], Map<string, Map<Values | undefined, Finding>>>;
};
function analysisWork(analysis: Analysis | undefined, amount: number): void {
  if (!analysis) return;
  analysis.work += amount;
  if (analysis.exhausted || analysis.work > 32768) {
    analysis.exhausted = true;
    throw new AnalysisLimit();
  }
}

// Substitute one possible binding environment. Never evaluate shell code.
function expandWord(
  raw: string,
  bindings: Map<string, string>,
  referenced?: Set<string>,
): { value: string; literal: boolean } {
  let quote = "";
  let expanded = "";
  let literal = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && quote !== "'") {
      expanded += raw.slice(i, i + 2);
      i++;
      continue;
    }
    if (c === "'" && quote !== '"') quote = quote === "'" ? "" : "'";
    if (c === '"' && quote !== "'") quote = quote === '"' ? "" : '"';
    if (quote !== "'" && c === "$" && raw[i + 1] !== "'") {
      const match = raw.slice(i).match(/^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})/);
      if (match) referenced?.add(match[1] ?? match[2]);
      const value = match ? bindings.get(match[1] ?? match[2]) : undefined;
      if (match && value !== undefined) {
        expanded += quote === '"' ? value.replace(/[\\"$`]/g, "\\$&") : `'${value.replaceAll("'", "'\\''")}'`;
        i += match[0].length - 1;
        continue;
      }
      literal = false;
      if (match) {
        // Keep an unknown name separate from a following resolved literal ($X$suffix).
        expanded += `\${${match[1] ?? match[2]}}`;
        i += match[0].length - 1;
        continue;
      }
    }
    if ((quote !== "'" && c === "`") || (!quote && /[*?[{~]/.test(c))) literal = false;
    expanded += c;
  }
  return { value: tokenize(expanded).commands[0]?.[0] ?? "", literal };
}

type ResolvedCommand = {
  index: number;
  wrappers: { name: string; index: number; target: number; informational?: boolean }[];
  split?: { index: number; value?: string; next: number };
  shell?: { index: number; value?: string };
};

// One resolution path for data masking, assignment collection, input roles and classification.
function resolveCommand(words: string[]): ResolvedCommand {
  const wrappers: ResolvedCommand["wrappers"] = [];
  let i = 0;
  for (;;) {
    while (assignment.test(words[i] ?? "")) i++;
    const wrapper = path.basename(words[i] ?? "");
    if (shellKeywords.has(wrapper)) {
      i++;
      continue;
    }
    const valued = wrapperOptions[wrapper];
    if (!valued) return { index: i, wrappers };
    const entry: ResolvedCommand["wrappers"][number] = { name: wrapper, index: i++, target: i };
    wrappers.push(entry);
    while (i < words.length) {
      if (words[i] === "--") {
        i++;
        break;
      }
      if (assignment.test(words[i])) {
        i++;
        continue;
      }
      if (!words[i].startsWith("-")) break;
      const bundle =
        wrapper === "xargs" && optionalXargsValues.has(words[i])
          ? { flags: [{ name: words[i], value: undefined }], next: i + 1 }
          : optionBundle(words, i, valued);
      for (const flag of bundle.flags) {
        if (
          ["flock", "script", "su", "runuser", "npx"].includes(wrapper) &&
          ["-c", "--command", "--call"].includes(flag.name)
        )
          return { index: entry.index, wrappers, shell: { index: i, value: flag.value } };
        if (wrapper === "env" && ["--help", "--version"].includes(flag.name)) entry.informational = true;
        if (wrapper === "env" && ["-S", "--split-string"].includes(flag.name))
          return { index: entry.index, wrappers, split: { index: i, value: flag.value, next: bundle.next } };
      }
      i = bundle.next;
    }
    if (["timeout", "flock", "chrt", "taskset"].includes(wrapper)) i++;
    if (wrapper === "pnpm") {
      if (!["exec", "dlx"].includes(words[i])) return { index: entry.index, wrappers };
      i++;
    }
    if (
      wrapper === "su" ||
      (wrapper === "runuser" && !words.slice(entry.index + 1, i).some((word) => /^-u|^--user/.test(word)))
    ) {
      if (words[i] && !words[i].startsWith("-")) i++;
    }
    if (["flock", "su", "runuser", "script"].includes(wrapper)) {
      while (words[i]?.startsWith("-")) {
        const bundle = optionBundle(words, i, valued);
        for (const flag of bundle.flags)
          if (["-c", "--command"].includes(flag.name))
            return { index: entry.index, wrappers, shell: { index: i, value: flag.value } };
        i = bundle.next;
      }
      if (["su", "script"].includes(wrapper)) return { index: entry.index, wrappers };
    }
    entry.target = i;
  }
}

function withoutRedirects(words: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (isOperator(words, i)) i++;
    else result.push(words[i]);
  }
  return result;
}

function nameref(command: string, args: string[]): boolean {
  return ["declare", "typeset", "local"].includes(command) && args.some((arg) => /^-[^-]*n/.test(arg));
}

function bindingVariants(sources: string[], values: Values): Map<string, string>[] {
  const names = new Set<string>();
  for (const source of sources) expandWord(source, new Map(), names);
  let variants = [new Map<string, string>()];
  for (const name of names) {
    const choices = values.get(name);
    if (!choices) continue;
    if (variants.length * choices.size > 256) throw new AnalysisLimit();
    variants = variants.flatMap((bindings) =>
      [...choices].map((value) => {
        const next = new Map(bindings);
        if (value !== undefined) next.set(name, value);
        return next;
      }),
    );
  }
  return variants;
}

function collectValues(parsed: ReturnType<typeof tokenize>, inherited?: Values, analysis?: Analysis): Values {
  const values: Values = new Map([...(inherited ?? [])].map(([name, choices]) => [name, new Set(choices)]));
  const expressions: { name: string; source: string }[] = [];
  let unmodelled = false;
  const collect = (part: ReturnType<typeof tokenize>, depth = 0) => {
    if (depth > 32) throw new AnalysisLimit();
    for (const words of part.commands) {
      analysisWork(analysis, words.length + 1);
      const sources = part.sources.get(words) ?? words;
      for (const source of sources) {
        const match = expandWord(source, new Map()).value.match(/^([A-Za-z_]\w*)=/);
        if (match) expressions.push({ name: match[1], source });
      }
      const commandWords = withoutRedirects(words);
      const resolved = resolveCommand(commandWords);
      const command = path.basename(commandWords[resolved.index] ?? "");
      const args = commandWords.slice(resolved.index + 1);
      if (command === "for" && /^[A-Za-z_]\w*$/.test(args[0] ?? "") && args[1] === "in") {
        const start = words.indexOf("in") + 1;
        for (const source of sources.slice(start)) expressions.push({ name: args[0], source: `${args[0]}=${source}` });
      }
      unmodelled ||=
        ["let", "eval", "source", ".", "read", "mapfile", "readarray", "unset"].includes(command) ||
        (command === "printf" && args.some((arg) => /^-v/.test(arg))) ||
        nameref(command, args) ||
        words.some((word) => /^[A-Za-z_]\w*\+=|^\(\(/.test(word)) ||
        sources.some((source) => source.includes("$(("));
    }
    for (const nested of part.nested) collect(tokenize(nested.body), depth + 1);
  };
  collect(parsed);
  const add = (name: string, value: string | undefined): boolean => {
    const choices = values.get(name) ?? new Set<string | undefined>();
    const before = choices.size;
    choices.add(value);
    if (choices.size > 64) throw new AnalysisLimit();
    values.set(name, choices);
    return before !== choices.size;
  };
  for (const { name, source } of expressions) {
    const value = expandWord(source, new Map());
    add(name, value.literal ? value.value.slice(value.value.indexOf("=") + 1) : undefined);
  }
  // Resolve literal dependencies to a fixed point, retaining unknown alternatives as well.
  for (let pass = 0; ; pass++) {
    let changed = false;
    for (const { name, source } of expressions) {
      analysisWork(analysis, 1);
      for (const bindings of bindingVariants([source], values)) {
        const value = expandWord(source, bindings);
        if (value.literal) changed = add(name, value.value.slice(value.value.indexOf("=") + 1)) || changed;
      }
    }
    if (!changed) break;
    if (pass >= 15) throw new AnalysisLimit();
  }
  if (unmodelled) for (const choices of values.values()) choices.add(undefined);
  return values;
}

// Mask only named data positions. Their substitutions remain in tokenize().nested.
function dataArguments(words: string[], start: number): Set<number> {
  const data = new Set<number>();
  const command = path.basename(words[start] ?? "");
  let flags: Set<string> | undefined;
  let i = start + 1;
  if (command === "gh") {
    i = skipFlags(words, i);
    const group = words[i];
    i = skipFlags(words, i + 1);
    if (
      (group === "pr" && ["comment", "review", "create", "edit"].includes(words[i])) ||
      (group === "issue" && words[i] === "comment")
    )
      flags = new Set(["--body", "-b", "--title", "-t"]);
    i++;
  } else if (command === "git") {
    while (words[i]?.startsWith("-")) i = option(words, i, new Set(["-C", "-c", "--git-dir", "--work-tree"])).next;
    const group = words[i++];
    if (group === "commit") flags = new Set(["-m", "--message"]);
    if (group === "log") flags = new Set(["--grep", "-S", "-G"]);
    if (group === "grep") {
      for (const index of dataArguments(["grep", ...words.slice(i)], 0)) data.add(i + index - 1);
      return data;
    }
  } else if (["rg", "grep", "egrep", "fgrep", "ag"].includes(command)) {
    const valued = new Set([
      "-e",
      "--regexp",
      "-f",
      "--file",
      "-g",
      "--glob",
      "--iglob",
      "-t",
      "--type",
      "-T",
      "--type-not",
      "-A",
      "-B",
      "-C",
      "--after-context",
      "--before-context",
      "--context",
      "-m",
      "--max-count",
      "--include",
      "--exclude",
      "--exclude-dir",
      "--color",
      "--colors",
      "--encoding",
      "--pre",
      "--pre-glob",
    ]);
    const explicit = words.slice(i).some((word) => /^(?:-[ef]|--(?:regexp|file)(?:=|$))/.test(word));
    let operand = false;
    let endFlags = false;
    for (; i < words.length; ) {
      if (!endFlags && words[i] === "--") {
        endFlags = true;
        i++;
        continue;
      }
      if (!endFlags && words[i].startsWith("-")) {
        const flag = option(words, i, valued);
        if (["-e", "--regexp", "--pre-glob"].includes(flag.name)) data.add(flag.next === i + 2 ? i + 1 : i);
        i = flag.next;
      } else {
        if (!explicit && !operand) data.add(i);
        operand = true;
        i++;
      }
    }
    return data;
  }
  if (flags) {
    for (; i < words.length; i++) {
      if (words[i] === "--") break;
      if (!words[i]?.startsWith("-")) continue;
      if (command === "git" && flags.has("-m") && /^-[A-Za-z]*m.+/.test(words[i])) {
        data.add(i);
        continue;
      }
      const flag =
        command === "git" && /^-[^-]+m$/.test(words[i])
          ? { name: "-m", value: words[i + 1], next: i + 2 }
          : option(words, i, flags);
      if (flags.has(flag.name)) data.add(flag.next === i + 2 ? i + 1 : i);
      i = flag.next - 1;
    }
    return data;
  }
  return data;
}

const shells = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "ash"]);
const schedulers = new Set(["at", "batch"]);
const interpreter = /^(?:python(?:\d+(?:\.\d+)*)?|node(?:js)?|perl|ruby|php|deno|bun|[gmn]?awk)$/;
function executesArguments(command: string): boolean {
  command = path.basename(tokenize(command).commands[0]?.[0] ?? command);
  return (
    command === "gh" ||
    shells.has(command) ||
    schedulers.has(command) ||
    interpreter.test(command) ||
    command in wrapperOptions
  );
}

function literalGhSubcommand(words: string[], sources: string[], start: number): boolean {
  if (path.basename(words[start] ?? "") !== "gh") return false;
  const group = skipFlags(words, start + 1);
  const verb = skipFlags(words, group + 1);
  return (
    ["issue", "pr"].includes(words[group]) &&
    ["view", "list", "status", "diff", "checks"].includes(words[verb]) &&
    [start, group, verb].every((i) => expandWord(sources[i], new Map()).literal)
  );
}

// Only -- and a bare script operand end PHP options. -r/-f consume one value.
const phpOptions = new Map([
  ["-r", "code"], ["-B", "code"], ["-E", "code"], ["-R", "code"],
  ["-f", "value"], ["--file", "value"], ["-c", "value"], ["--php-ini", "value"],
  ["-d", "value"], ["--define", "value"], ["-F", "value"], ["-S", "value"], ["-t", "value"],
  ["--rf", "value"], ["--rc", "value"], ["--re", "value"], ["--rz", "value"], ["--ri", "value"],
]);
const phpValued = new Set(phpOptions.keys());
function phpFlags(args: string[]): { name: string; value?: string }[] {
  const flags: { name: string; value?: string }[] = [];
  for (let i = 0; i < args.length && args[i].startsWith("-") && args[i] !== "--";) {
    const bundle = optionBundle(args, i, phpValued);
    flags.push(...bundle.flags);
    i = bundle.next;
  }
  return flags;
}

function inlinePrograms(command: string, args: string[]): string[] {
  if (command === "php") return phpFlags(args).filter(flag => phpOptions.get(flag.name) === "code")
    .map(flag => { if (flag.value === undefined) throw new AnalysisLimit(); return flag.value; });
  const programs: string[] = [];
  const awk = /^[gmn]?awk$/.test(command);
  let fileProgram = false;
  if (command === "deno" && args[0] === "eval") {
    const code = args.slice(1).find((arg) => !arg.startsWith("-"));
    return code === undefined ? [] : [code];
  }
  const flags = awk
    ? ["-e", "--source"]
    : command.startsWith("python")
      ? ["-c"]
      : command === "perl"
          ? ["-e", "-E"]
          : command === "ruby"
            ? ["-e"]
            : ["-e", "--eval", "-p", "--print"];
  const valued = new Set([
    ...flags,
    "-r",
    "--require",
    "--import",
    ...(command.startsWith("python") ? [] : ["-I"]),
    "-W",
    "-X",
    "--loader",
    "--experimental-loader",
    "--input-type",
    ...(awk ? ["-F", "-v", "-f", "--file", "-i", "--include", "-l", "--load", "-E", "--exec"] : []),
  ]);
  for (let i = 0; i < args.length; ) {
    if (args[i] === "--") {
      if (awk && !fileProgram && !programs.length && args[i + 1]) programs.push(args[i + 1]);
      break;
    }
    if (!args[i].startsWith("-")) {
      if (awk) {
        if (!fileProgram && !programs.length) programs.push(args[i]);
        i++;
        continue;
      }
      break;
    }
    if (
      /^node(?:js)?$/.test(command) &&
      ["-p", "--print"].includes(args[i]) &&
      /^(?:-e|--eval(?:=|$))/.test(args[i + 1] ?? "")
    ) {
      i++;
      continue;
    }
    let bundle = optionBundle(args, i, valued);
    if (/^node(?:js)?$/.test(command) && /^-pe/.test(args[i])) {
      bundle = {
        flags: [{ name: "-e", value: args[i].slice(args[i].startsWith("-pe") ? 3 : 2) || args[i + 1] }],
        next: i + (args[i].length > (args[i].startsWith("-pe") ? 3 : 2) ? 1 : 2),
      };
    }
    for (const flag of bundle.flags) {
      if (awk && ["-f", "--file", "-E", "--exec"].includes(flag.name)) fileProgram = true;
      if (flags.includes(flag.name)) {
        if (flag.value === undefined) throw new AnalysisLimit();
        programs.push(flag.value);
        if (command.startsWith("python")) return [flag.value];
      }
    }
    i = bundle.next;
  }
  return programs;
}

function interpreterInput(command: string, body: string, depth: number, context: Context, site = "stdin"): Finding {
  let finding: Finding;
  if (interpreter.test(command)) {
    if (inlineCredentials(body, command)) finding = "token";
    if (launchesProcess(body, command)) finding = strongest(finding, "write");
  }
  return interpreter.test(command)
    ? strongest(finding, looseFinding(body))
    : strongest(finding, inspect(body, depth + 1, context, site));
}

function nodeStdinPreload(args: string[]): boolean {
  if (stdinOperand(args)) return true;
  const preloads = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
  const valued = new Set([...preloads, "-e", "--eval", "-p", "--print", "--input-type", "-C", "--conditions"]);
  for (let i = 0; i < args.length && args[i].startsWith("-"); ) {
    if (args[i] === "--") break;
    const bundle = optionBundle(args, i, valued);
    if (
      bundle.flags.some((flag) => preloads.has(flag.name) && (flag.value === "-" || stdinOperand([flag.value ?? ""])))
    )
      return true;
    i = bundle.next;
  }
  return false;
}

function nodeNoStdin(args: string[]): boolean {
  if (nodeStdinPreload(args)) return false;
  const valued = new Set([
    "-r",
    "--require",
    "--import",
    "--input-type",
    "-e",
    "--eval",
    "-p",
    "--print",
    "--conditions",
    "-C",
  ]);
  for (let i = 0; i < args.length && args[i].startsWith("-"); ) {
    if (args[i] === "--") break;
    if (["--test", "--version", "-v", "--help", "-h", "--check", "-c"].includes(args[i])) return true;
    i = option(args, i, valued).next;
  }
  return false;
}

// Literal text cannot launch awk pipes. Keep operators outside strings and regexes.
function awkCode(code: string): string {
  let result = "";
  let operand = true;
  let control = false;
  const parens: boolean[] = [];
  for (let i = 0; i < code.length; ) {
    const c = code[i];
    if (c === '"' || c === "'" || (c === "/" && operand)) {
      const delimiter = c;
      let bracket = false;
      let end = i + 1;
      for (; end < code.length; end++) {
        if (code[end] === "\\") {
          end++;
          continue;
        }
        if (delimiter === "/" && code[end] === "[") bracket = true;
        if (delimiter === "/" && code[end] === "]") bracket = false;
        if (code[end] === delimiter && !bracket) break;
      }
      if (end === code.length) return result + code.slice(i); // Malformed literals stay visible.
      result += " 0 ";
      operand = false;
      i = end + 1;
    } else if (c === "#") {
      while (i < code.length && code[i] !== "\n") i++;
    } else {
      const word = code.slice(i).match(/^[A-Za-z_]\w*|^\d+(?:\.\d+)?/);
      if (word) {
        result += word[0];
        control = ["if", "while", "for", "switch"].includes(word[0]);
        operand = ["print", "printf", "return", "in"].includes(word[0]);
        i += word[0].length;
      } else if (code.startsWith("++", i) || code.startsWith("--", i)) {
        // A postfix operator still ends an operand; a following slash is division.
        result += code.slice(i, i + 2);
        i += 2;
      } else {
        result += c;
        if (c === "(") {
          parens.push(control);
          control = false;
        }
        if (!/\s/.test(c)) operand = c === ")" ? (parens.pop() ?? false) : c !== "]";
        if (c === "\n") operand = true;
        i++;
      }
    }
  }
  return result;
}

function awkLaunches(code: string): boolean {
  const stripped = awkCode(code);
  if (/\bsystem\s*\(/.test(stripped)) return true;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === "|") {
      if (stripped[i + 1] === "|") i++;
      else return true;
    }
  }
  return false;
}

function launchesProcess(code: string, command: string): boolean {
  if (/^[gmn]?awk$/.test(command)) return awkLaunches(code);
  if ((shells.has(command) || ["ruby", "perl", "php"].includes(command)) && code.includes("`")) return true;
  if (/\b(?:shell_exec|passthru|popen|proc_open)\s*\(|\bDeno\s*\.\s*run\s*\(/.test(code)) return true;
  if (
    /\b(?:subprocess|pty|child_process|execSync|spawnSync|execFile|qx|spawn|system|exec|getattr)\b|\bos\.(?:popen|exec\w*|spawn\w*)\b|\b(?:Deno\.Command|IO\.popen)\b|%x\W|\bopen\s*(?:\([^)]*|[^;\n]*)["'][^"']*\|/.test(
      code,
    )
  )
    return true;
  // Literal module loads remain available for parsing; computed module names can select a launcher.
  for (const call of code.matchAll(/\b(?:require|__import__)\s*(\(\s*|\s+)/g)) {
    const tail = code.slice((call.index ?? 0) + call[0].length);
    const literal = tail.match(/^(?:"[^"\\]*"|'[^'\\]*')\s*/);
    if (
      !literal ||
      (call[1].includes("(") ? tail[literal[0].length] !== ")" : !/^(?:;|$)/.test(tail.slice(literal[0].length)))
    )
      return true;
  }
  return false;
}

// Awk can combine inline programs with an additional program file on stdin.
function stdinProgramFile(command: string, args: string[]): boolean {
  if (!/^[gmn]?awk$/.test(command)) return false;
  const valued = new Set([
    "-f",
    "--file",
    "-E",
    "--exec",
    "-e",
    "--source",
    "-F",
    "-v",
    "-i",
    "--include",
    "-l",
    "--load",
  ]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") break;
    if (!args[i].startsWith("-")) continue;
    const flag = option(args, i, valued);
    if (
      ["-f", "--file", "-E", "--exec"].includes(flag.name) &&
      (flag.value === "-" || stdinOperand([flag.value ?? ""]))
    )
      return true;
    i = flag.next - 1;
  }
  return false;
}

function stdinOperand(args: string[]): boolean {
  return args.some((arg) => ["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"].includes(arg));
}

function readsStdin(command: string, args: string[]): boolean {
  if (/^node(?:js)?$/.test(command) && nodeStdinPreload(args)) return true;
  if (/^node(?:js)?$/.test(command) && nodeNoStdin(args)) return false;
  if (stdinOperand(args) || schedulers.has(command)) return true;
  if (["deno", "bun"].includes(command) && ["run", "eval"].includes(args[0])) args = args.slice(1);
  if (shells.has(command) && args.some((arg) => /^-[^-]*s/.test(arg))) return true;
  // Skip value-taking startup options; a script/module operand means stdin is data.
  const valued = new Set([
    "-O",
    "+O",
    "-o",
    "+o",
    "--rcfile",
    "--init-file",
    "--input-type",
    "-r",
    "--require",
    "--import",
    "-I",
    "-W",
    "-X",
  ]);
  for (let i = 0; i < args.length; ) {
    if (args[i] === "-") return true;
    if (args[i] === "--") return args.length === i + 1 || args[i + 1] === "-";
    if (!/^[+-]/.test(args[i])) return false;
    if (args[i] === "-m" || args[i] === "--check") return false;
    i = option(args, i, valued).next;
  }
  return true;
}

function literalProducer(
  words: string[],
  sources: string[],
  context: Context,
  allowDynamic = false,
): string | undefined {
  const values = sources.map((source) => expandWord(source, context.bindings));
  if (!allowDynamic && values.some((value) => !value.literal)) return undefined;
  const command = path.basename(words[0] ?? "");
  const args = values.slice(1).map((value) => value.value);
  const decode = (value: string) =>
    value.replace(/\\(?:[abefnrtv\\]|0?[0-7]{1,3}|x[\da-fA-F]{1,2}|u[\da-fA-F]{4}|U[\da-fA-F]{8})/g, (sequence) => {
      if (/^\\[0-7]/.test(sequence)) return String.fromCodePoint(Number.parseInt(sequence.slice(1), 8));
      if (/[xuU]/.test(sequence[1])) return String.fromCodePoint(Number.parseInt(sequence.slice(2), 16));
      const simple: Record<string, string> = {
        a: "\x07",
        b: "\b",
        e: "\x1b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\v",
        "\\": "\\",
      };
      return simple[sequence[1]] ?? sequence;
    });
  if (command === "echo") {
    let escapes = false;
    while (/^-[neE]+$/.test(args[0] ?? "")) {
      escapes ||= args[0].includes("e");
      args.shift();
    }
    return escapes ? decode(args.join(" ")) : args.join(" ");
  }
  if (command !== "printf" || !args.length) return undefined;
  if (args[0] === "--") args.shift();
  const format = decode(args.shift() ?? "");
  if (/%(?![%sb])/.test(format)) return undefined;
  let result = "";
  do {
    const before = args.length;
    result += format.replace(/%[%sb]/g, (specifier) => {
      if (specifier === "%%") return "%";
      const value = args.shift() ?? "";
      return specifier === "%b" ? decode(value) : value;
    });
    if (args.length === before) break;
  } while (args.length);
  return result;
}

const credentialNames = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);

function credentialComponent(word: string, target: string, dotglob: boolean, opaque = false): boolean {
  const wildcard = "\u0000";
  const expanded = word.replace(/\$\([^)]*\)|\$\{[^}]*\}|\$[A-Za-z_]\w*|`[^`]*`/g, wildcard);
  const segment = expanded.replace(/\(D\)$/, "");
  dotglob ||= expanded.endsWith("(D)");
  if (target.startsWith(".") && !dotglob && !segment.startsWith(".") && !segment.startsWith(wildcard)) return false;
  const pattern = segment.replace(/\{[^},]*\}|\[[^\]]*\]|[?*]/g, wildcard);
  if (!opaque && !pattern.replaceAll(wildcard, "") && !(dotglob && /[?*[]/.test(segment))) return false;
  return wildcardMatch(pattern, target);
}

function credentialParts(word: string): string[] {
  const value = operandValue(word)
    .replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, "~")
    .replace(/^\$(?:GH_CONFIG_DIR|\{GH_CONFIG_DIR\})(?=\/|$)/, ".config/gh")
    .replace(/^\$(?:XDG_CONFIG_HOME|\{XDG_CONFIG_HOME\})(?=\/|$)/, ".config");
  // Never collapse .. across an unknown expansion or glob. Literal paths can be normalized in full.
  const normalized = /[$`*?[{]/.test(value) ? maskExpansions(value) : path.posix.normalize(value);
  return normalized.split("/").filter((part, i) => part !== "." && (part !== "" || (i === 0 && value.startsWith("/"))));
}

function credentialPath(word: string, dotglob = false): boolean {
  const parts = credentialParts(word);
  const basename = parts.at(-1) ?? "";
  if ([".git-credentials", ".netrc"].some((name) => credentialComponent(basename, name, dotglob))) return true;
  const suffix = (names: string[]) =>
    parts.length >= names.length &&
    names.every((name, i) => credentialComponent(parts[parts.length - names.length + i], name, dotglob, true));
  if (suffix([".config", "gh", "hosts.yml"])) return true;
  if (
    parts.length >= 4 &&
    parts[0] === "" &&
    credentialComponent(parts[1], "proc", dotglob, true) &&
    credentialComponent(basename, "environ", dotglob, true)
  )
    return true;
  return (
    parts.length >= 2 &&
    // An opaque parent alone does not identify SSH contents: $HOME/notes.md is an ordinary path.
    parts.slice(0, -1).some((part) => credentialComponent(part, ".ssh", dotglob)) &&
    !!basename &&
    !basename.endsWith(".pub") &&
    !["known_hosts", "config"].includes(basename)
  );
}

function credentialDirectory(word: string, dotglob: boolean): boolean {
  const parts = credentialParts(word);
  return (
    credentialComponent(parts.at(-1) ?? "", ".ssh", dotglob) ||
    (parts.length >= 2 &&
      credentialComponent(parts[parts.length - 2], ".config", dotglob) &&
      credentialComponent(parts.at(-1) ?? "", "gh", dotglob, true))
  );
}

function credentialAncestor(word: string, dotglob: boolean): boolean {
  if (credentialDirectory(word, dotglob)) return true;
  const parts = credentialParts(word);
  return (
    parts.at(-1) === "~" ||
    credentialComponent(parts.at(-1) ?? "", ".config", dotglob) ||
    (parts[0] === "" && (parts.length === 1 || (parts[1] === "home" && parts.length <= 3)))
  );
}

function readsCredentialDirectory(command: string, args: string[], dotglob: boolean): boolean {
  if (["ls", "stat", "test"].includes(command)) return false;
  const operands = args.map(operandValue);
  if (operands.some((arg) => credentialDirectory(arg, dotglob))) return true;
  const recursive =
    ["tar", "rsync", "zip", "rg"].includes(command) ||
    (command === "cp" && args.some((arg) => /^-[^-]*[rRa]|^--(?:recursive|archive)$/.test(arg))) ||
    (command === "grep" && args.some((arg) => /^-[^-]*[rR]|^--recursive$|^--directories=recurse$/.test(arg))) ||
    (command === "find" && args.some((arg) => ["-exec", "-execdir", "-ok", "-fprint"].includes(arg)));
  if (recursive && operands.some((arg) => credentialAncestor(arg, dotglob))) return true;
  if (command === "find") {
    for (let i = 0; i < args.length - 1; i++) {
      if (!["-name", "-iname", "-path", "-ipath"].includes(args[i])) continue;
      const namePredicate = ["-name", "-iname"].includes(args[i]);
      const insensitive = args[i].startsWith("-i");
      const pattern = insensitive ? args[++i].toLowerCase() : args[++i];
      const basename = pattern.slice(pattern.lastIndexOf("/") + 1);
      if (
        credentialPath(namePredicate ? pattern : pattern.replace(/\[[^\]]*\]|[?*]/g, "\u0000"), dotglob) ||
        (namePredicate &&
          (["hosts.yml", "id_rsa", "id_ed25519"].some((name) => credentialComponent(basename, name, dotglob, true)) ||
            (basename.startsWith("id_") && !basename.endsWith(".pub"))))
      )
        return true;
    }
  }
  return false;
}

function phpComputedEnvironment(code: string): boolean {
  const safeKey = (tail: string, close: string): boolean => {
    const literal = tail.match(/^\s*(["'])([^"'\\]*)\1\s*([\]),])/);
    return (
      !!literal &&
      close.includes(literal[3]) &&
      !credentialNames.has(literal[2]) &&
      !(literal[1] === '"' && literal[2].includes("$"))
    );
  };
  for (const match of code.matchAll(/\$_(?:ENV|SERVER)\s*\[/g)) {
    if (!safeKey(code.slice(match.index + match[0].length), "]")) return true;
  }
  for (const match of code.matchAll(/\bgetenv\s*\(/gi)) {
    const tail = code.slice(match.index + match[0].length);
    // Whole-environment/default-name forms retain the existing case-insensitive rule.
    if (/^\s*(?:\)|(?:name\s*:\s*)?null\b|local_only\s*:)/i.test(tail)) continue;
    if (!safeKey(tail.replace(/^\s*name\s*:/i, ""), "),")) return true;
  }
  return false;
}

function aliasedEnvironment(code: string): boolean {
  if (/\bObject\s*\.\s*const_get\s*\(\s*:ENV\b|%main::ENV\b/.test(code)) return true;
  if (
    /\brequire\s*\(\s*["'](?:node:)?process["']\s*\)\s*\.\s*env\b/.test(code) ||
    /\bglobalThis\s*(?:\[\s*["']process["']\s*\]|\.\s*process)\s*\.\s*env\b/.test(code) ||
    /\bReflect\s*\.\s*get\s*\(\s*process\s*,\s*["']env["']/.test(code) ||
    /\bos\s*\.\s*environb\b|\bposix\s*\.\s*environ\b|\bvars\s*\(\s*os\s*\)\s*\[\s*["']environ["']\s*\]/.test(code) ||
    /\bfrom\s+os\s+import\b[^;\n]*\benvironb\b/.test(code) ||
    /\$GLOBALS\s*\[\s*["']_(?:ENV|SERVER)["']\s*\]|\bfilter_input_array\s*\(\s*INPUT_(?:ENV|SERVER)\b/.test(code)
  ) return true;
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$]\w*)\s*=\s*process\b|\bimport\s+os\s+as\s+([A-Za-z_]\w*)/g)) {
    const name = match[1] ?? match[2];
    if (new RegExp("\\b" + name.replaceAll("$", "\\$") + "\\s*\\.\\s*" + (match[1] ? "env" : "environb?") + "\\b").test(code)) return true;
  }
  return /\bimport\s*\(\s*["'](?:node:)?process["']\s*\)[\s\S]*\.\s*env\b/.test(code);
}

function inlineCredentials(code: string, language?: string): boolean {
  if (aliasedEnvironment(code)) return true;
  if (language === "php" && phpComputedEnvironment(code)) return true;
  if (
    /\bgetenv\s*\(\s*(?:\)|(?:(?:name\s*:\s*)?null\s*(?:\)|,)|local_only\s*:))/i.test(code) ||
    /\$_(?:ENV|SERVER)\b(?!\s*\[)/.test(code) ||
    /\bphpinfo\s*\(/i.test(code)
  )
    return true;
  for (const literal of code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    if (credentialPath(literal[2].replace(/\\(["'`\\])/g, "$1"))) return true;
  }
  if (
    /\bprocess\s*\[|\{[^}]*\benv\b[^}]*\}\s*=\s*process\b|\bfrom\s+os\s+import\b[^;\n]*\benviron\b|\b(?:Deno|Bun)\s*\.\s*env\b/.test(
      code,
    )
  )
    return true;
  if (/\b(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)\b/.test(code)) return true;
  const objects = /\bprocess\s*\.\s*env\b|\bos\s*\.\s*environ\b|\bENVIRON\b|\bENV\b/g;
  for (const object of code.matchAll(objects)) {
    const tail = code.slice((object.index ?? 0) + object[0].length);
    // A literal key reads only that entry. Whole objects and computed keys may expose tokens.
    if (/^\s*\[\s*(?:"[^"\\]*"|'[^'\\]*')\s*\]/.test(tail)) continue;
    if (object[0].startsWith("process") && /^\s*\.\s*[A-Za-z_$][\w$]*/.test(tail)) continue;
    if (/^(?:os|ENV$)/.test(object[0]) && /^\s*\.\s*(?:get|fetch)\s*\(\s*(?:"[^"\\]*"|'[^'\\]*')\s*[,)]/.test(tail))
      continue;
    if (
      object[0] === "ENV" &&
      code[(object.index ?? 0) - 1] === "$" &&
      /^\s*\{\s*(?:[A-Za-z_]\w*|"[^"\\]*"|'[^'\\]*')\s*\}/.test(tail)
    )
      continue;
    return true;
  }
  return false;
}

function psEnvironment(args: string[]): boolean {
  const valued = new Set(["-o", "-p", "-u", "-U", "-G", "-t", "-C", "-q"]);
  for (let i = 0; i < args.length; ) {
    const flag = option(args, i, valued);
    if (valued.has(flag.name)) {
      i = flag.next;
      continue;
    }
    if (args[i] === "-E" || /^[A-Za-z]*e[A-Za-z]*$/.test(args[i])) return true;
    i++;
  }
  return false;
}

// Mask jq data, retaining expressions inside string interpolation (including nested strings).
function jqCode(text: string): string {
  let i = 0;
  function expression(interpolation: boolean, depth: number): string {
    if (depth > 32) throw new AnalysisLimit();
    let result = "";
    let parens = 0;
    while (i < text.length) {
      const c = text[i++];
      if (c === "#") {
        while (i < text.length && text[i] !== "\n") i++;
        result += " ";
      } else if (c === '"') {
        result += " ";
        while (i < text.length) {
          const quoted = text[i++];
          if (quoted === '"') break;
          if (quoted === "\\") {
            if (text[i++] === "(") result += ` ${expression(true, depth + 1)} `;
          }
        }
        result += " ";
      } else if (c === ")" && interpolation && parens-- === 0) return result;
      else {
        if (c === "(") parens++;
        result += c;
      }
    }
    return result;
  }
  return expression(false, 0);
}

function jqEnvironment(args: string[]): boolean {
  for (let i = 0; i < args.length; ) {
    if (["--arg", "--argjson", "--slurpfile", "--rawfile"].includes(args[i])) {
      i += 3;
      continue;
    }
    if (args[i] === "--") {
      i++;
      if (i >= args.length) return false;
    } else if (args[i].startsWith("-")) {
      const flag = option(args, i, new Set(["-f", "--from-file", "-L", "--indent"]));
      if (["-f", "--from-file"].includes(flag.name)) return false;
      i = flag.next;
      continue;
    }
    return /(?:^|[^\w.$])env\b|\$ENV\b/.test(jqCode(args[i]));
  }
  return false;
}

function environmentCommand(args: string[]): boolean {
  let i = 0;
  while (args[i]?.startsWith("-"))
    i = option(args, i, new Set(["-L", "-S", "-f", "-H", "--host", "-M", "--machine"])).next;
  return args[i] === "show-environment";
}

function credentialCommand(command: string, args: string[]): boolean {
  if (command === "php" && phpFlags(args).some(flag => ["-i", "--info"].includes(flag.name))) return true;
  if (nameref(command, args)) return true;
  if (["declare", "typeset"].includes(command) && args.length === 0) return true;
  if (command === "ps" && psEnvironment(args)) return true;
  if (command === "jq" && jqEnvironment(args)) return true;
  if (["tmux", "systemctl"].includes(command) && environmentCommand(args)) return true;
  const names = args.filter((arg) => !arg.startsWith("-"));
  if (command === "printenv") return names.length === 0 || names.some((name) => credentialNames.has(name));
  if (command === "export")
    return names.length === 0 || (args.includes("-p") && names.some((name) => credentialNames.has(name)));
  if (["declare", "typeset"].includes(command))
    return (
      (names.length === 0 || names.some((name) => credentialNames.has(name))) &&
      args.some((arg) => /^-[^-]*[xp]/.test(arg))
    );
  return command === "set" && args.length === 0;
}

function sedReadOnly(args: string[]): boolean {
  const parsed = sedScripts(args);
  return parsed !== undefined && !parsed.inPlace && sedSafe(args);
}

function sedSafe(args: string[]): boolean {
  const parsed = sedScripts(args);
  return parsed?.scripts.every((script) => safeSedScript(script)) ?? false;
}

function sedScripts(args: string[]): { scripts: string[]; inPlace: boolean } | undefined {
  let inPlace = false;
  const scripts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      if (!scripts.length && args[i + 1]) scripts.push(args[i + 1]);
      break;
    }
    if (arg.startsWith("--")) {
      const flag = option(args, i, new Set(["--expression", "--file"]));
      if (flag.name === "--file") return undefined;
      if (flag.name === "--in-place") inPlace = true;
      if (flag.name === "--expression") {
        if (flag.value === undefined) return undefined;
        scripts.push(flag.value);
        i = flag.next - 1;
      } else if (!/^--(?:quiet|silent|regexp-extended|separate|unbuffered|null-data|sandbox|in-place)(?:=|$)/.test(arg))
        return undefined;
    } else if (arg.startsWith("-") && arg !== "-") {
      for (let j = 1; j < arg.length; j++) {
        if (arg[j] === "f") return undefined;
        if (arg[j] === "e") {
          const script = arg.slice(j + 1) || args[++i];
          if (script === undefined) return undefined;
          scripts.push(script);
          break;
        }
        if (arg[j] === "i") {
          inPlace = true;
          break;
        } // Optional attached backup suffix, never a script.
        if (!"nErsuz".includes(arg[j])) return undefined;
      }
    } else if (!scripts.length) scripts.push(arg);
  }
  return scripts.length ? { scripts, inPlace } : undefined;
}

function sedWriteTargets(args: string[]): string[] {
  const targets: string[] = [];
  for (const script of sedScripts(args)?.scripts ?? []) {
    const before = targets.length;
    if (!safeSedScript(script, targets) && targets.length === before) {
      // Unsupported/malformed addresses must not hide a later literal write target.
      for (const write of script.matchAll(/(?:^|[;\n\s/%%])(?:[wW]|s[^\n]*?[wW])\s+([^\n;]+)/g))
        targets.push(write[1].trim());
    }
  }
  return targets;
}

function safeSedScript(script: string, targets?: string[]): boolean {
  let i = 0;
  let braces = 0;
  const space = () => {
    while (/\s/.test(script[i] ?? "") && i < script.length) i++;
  };
  const delimited = (delimiter: string): boolean => {
    while (i < script.length) {
      if (script[i] === "\\") {
        i += 2;
        continue;
      }
      if (script[i++] === delimiter) return true;
    }
    return false;
  };
  const address = (): boolean => {
    if (script[i] === "/" || script[i] === "\\") {
      const delimiter = script[i++] === "\\" ? script[i++] : "/";
      return !!delimiter && delimited(delimiter);
    }
    if (script[i] === "+" || script[i] === "~") {
      const relative = script.slice(i).match(/^[+~]\d+/);
      if (!relative) return false;
      i += relative[0].length;
      return true;
    }
    if (script[i] === "$") {
      i++;
      return true;
    }
    const number = script.slice(i).match(/^\d+(?:~\d+)?/);
    if (!number) return false;
    i += number[0].length;
    return true;
  };
  while (i < script.length) {
    space();
    if (i === script.length) break;
    if (script[i] === ";") {
      i++;
      continue;
    }
    if (/[/\\\d$]/.test(script[i])) {
      if (!address()) return false;
      space();
      if (script[i] === ",") {
        i++;
        space();
        if (!address()) return false;
      }
      space();
      if (script[i] === "!") {
        i++;
        space();
      }
    }
    const command = script[i++];
    if (command === "{") {
      braces++;
      continue;
    }
    if (command === "}") {
      if (--braces < 0) return false;
      continue;
    }
    if ("pdq=".includes(command ?? "") && command) {
      if (command === "q") while (/\d/.test(script[i] ?? "")) i++;
      continue;
    }
    if (targets && ["w", "W"].includes(command)) {
      const end = script.indexOf("\n", i);
      targets.push(script.slice(i, end < 0 ? script.length : end).trim());
      i = end < 0 ? script.length : end;
      continue;
    }
    if (command !== "s" && command !== "y") {
      if (!targets) return false;
      // Other commands can precede writes. Their text ends at a command separator.
      while (i < script.length && !/[;\n]/.test(script[i])) i++;
      continue;
    }
    const delimiter = script[i++];
    if (!delimiter || /[\\\s]/.test(delimiter) || !delimited(delimiter) || !delimited(delimiter)) return false;
    if (command === "s") {
      const flags = script.slice(i).match(/^[A-Za-z\d]*/)?.[0] ?? "";
      if (targets && flags.includes("w")) {
        i += flags.indexOf("w") + 1;
        const end = script.indexOf("\n", i);
        targets.push(script.slice(i, end < 0 ? script.length : end).trim());
        i = end < 0 ? script.length : end;
      } else {
        if (!targets && /[^gpiImM\d]/.test(flags)) return false;
        i += flags.length;
      }
    }
  }
  return braces === 0;
}

// Script arguments are inspected recursively, where data positions retain their meaning.
// The remaining words keep the conservative loose scan and path checks.
function ordinaryFinding(words: string[], sources: string[], context: Context): Finding {
  let finding = looseFinding(sources.join(" "));
  // This includes for-list paths and globs even when the loop body uses an unresolved variable.
  for (const [i, word] of words.entries()) {
    const original = expandWord(sources[i], new Map()).value;
    if (original !== word && credentialPath(original, context.dotglob)) finding = strongest(finding, "token");
    if (credentialPath(word, context.dotglob)) finding = strongest(finding, "token");
    if (privateTerms.test(word) || privateTermsWord(word, context.dotglob))
      finding = strongest(finding, "private-terms");
    if (githubEndpoint.test(word) || (word.startsWith("query=") && issueMutation.test(word)))
      finding = strongest(finding, "write");
  }
  return finding;
}

// Only these receivers treat stdin as data. Unknown executors retain full shell inspection.
function dataReceiver(words: string[], resolved = resolveCommand(words)): boolean {
  if (resolved.split || resolved.shell || resolved.wrappers.some(({ name }) => ["xargs", "parallel"].includes(name)))
    return false;
  let i = resolved.index;
  const command = path.basename(words[i] ?? "");
  if (/^node(?:js)?$/.test(command) && nodeNoStdin(words.slice(i + 1))) return true;
  if (["cat", "tee", "wc", "sort", "rg", "grep", "jq", "head", "tail", "tr", "cut"].includes(command)) return true;
  if (command === "sed") return sedSafe(words.slice(i + 1));
  let flags: Set<string>;
  if (command === "git") {
    i++;
    while (words[i]?.startsWith("-"))
      i = option(words, i, new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"])).next;
    if (!["commit", "tag", "notes"].includes(words[i++])) return false;
    flags = new Set(["-F", "--file"]);
  } else if (command === "gh") {
    i = skipFlags(words, i + 1);
    if (words[i] === "api") return true; // API stdin is data; mutation fields are checked separately.
    if (!["pr", "issue"].includes(words[i])) return false;
    i = skipFlags(words, i + 1);
    if (!["comment", "review", "create", "edit"].includes(words[i++])) return false;
    flags = new Set(["--body-file", "-F"]);
  } else return false;
  for (; i < words.length; i++) {
    if (!words[i].startsWith("-")) continue;
    const flag = option(words, i, flags);
    if (flags.has(flag.name) && flag.value === "-") return true;
    i = flag.next - 1;
  }
  return false;
}

// Wrappers may write files even when their child is a harmless reader.
function wrapperTargets(words: string[], resolved: ResolvedCommand): string[] {
  const targets: string[] = [];
  const outputOptions: Record<string, string[]> = {
    time: ["-o", "--output"],
    flock: [],
    script: ["-O", "--log-out", "-I", "--log-in", "-B", "--log-io", "-T", "--log-timing"],
    strace: ["-o", "--output"],
    ltrace: ["-o"],
    parallel: ["--results", "--joblog"],
  };
  for (const wrapper of resolved.wrappers) {
    if (!outputOptions[wrapper.name]) continue;
    let positional = false;
    for (let i = wrapper.index + 1; i < words.length; i++) {
      const arg = words[i];
      if (arg === "--") {
        positional = true;
        continue;
      }
      if (!positional && arg.startsWith("-")) {
        const bundle = optionBundle(words, i, wrapperOptions[wrapper.name]);
        for (const flag of bundle.flags)
          if (outputOptions[wrapper.name].includes(flag.name) && flag.value !== undefined) targets.push(flag.value);
        i = bundle.next - 1;
      } else {
        if (wrapper.name === "script") {
          targets.push(arg);
          continue;
        }
        if (wrapper.name === "flock" && !/^\d+$/.test(arg)) targets.push(arg);
        break;
      }
    }
  }
  return targets;
}

function wrapperLocations(words: string[], resolved: ResolvedCommand, locations?: Locations): Locations | undefined {
  for (const wrapper of resolved.wrappers) {
    for (let i = wrapper.index + 1; i < wrapper.target; i++) {
      if (!words[i]?.startsWith("-")) continue;
      const bundle = optionBundle(words, i, wrapperOptions[wrapper.name]);
      for (const flag of bundle.flags)
        if ((wrapper.name === "env" && ["-C", "--chdir"].includes(flag.name)) ||
            (wrapper.name === "sudo" && ["-D", "--chdir"].includes(flag.name))) {
          locations = { ...locations, cwdCandidates: candidateLocations(locations).map(candidate =>
            flag.value === undefined ? undefined : absoluteLocation(flag.value, candidate)) };
        }
      i = bundle.next - 1;
    }
  }
  return locations;
}

function onlyDirectoryTarget(
  command: string,
  targets: string[],
  sources: string[],
  locations: Locations | undefined,
  context: Context,
): boolean {
  if (!["mkdir", "rm", "rmdir"].includes(command) || !targets.length) return false;
  const names = new Set<string>();
  const expanded = sources.map(source => expandWord(source, context.bindings, names));
  if (expanded.some(source => !source.literal)) return false;
  if ([...names].some(name => context.values?.get(name)?.size !== 1)) return false;
  // rmdir --parents (including abbreviations) also removes strict ancestors.
  if (command === "rmdir" && expanded.some(({ value }) =>
    /^-[^-]*p/.test(value) || (value.startsWith("--") && value.length > 2 && "--parents".startsWith(value)))) return false;
  // Generic option/assignment extraction must not turn a literal name such as x=/tmp/out into D.
  const operands = expanded.map(source => source.value).filter(value => !value.startsWith("-"));
  if (targets.length !== operands.length || targets.some((target, i) => target !== operands[i])) return false;
  let destination: string | undefined;
  for (const candidate of candidateLocations(locations)) {
    for (const target of targets) {
      const absolute = absoluteLocation(target, candidate);
      if (absolute === undefined) return false;
      const normalized = canonicalPath(absolute);
      destination ??= normalized;
      if (normalized !== destination) return false;
    }
  }
  return true;
}

function recordCommandWrites(words: string[], resolved: ResolvedCommand, locations: Locations | undefined, context: Context, literalInput?: string, rawArgs = words.slice(resolved.index + 1), otherWrites = false, fedStdin = false): void {
  const command = path.basename(words[resolved.index] ?? "");
  const args = words.slice(resolved.index + 1);
  if (!command || ["for", "select", "case", "fi", "done", "esac"].includes(command)) return;
  if (["echo", "printf", "du", "stat", "test", "["].includes(command)) return;
  let targets: string[];
  if (["cp", "mv", "rsync", "install"].includes(command)) {
    targets = copyTargets(command, args, locations, rawArgs, gitEnvironment(words, context.bindings));
  } else if (command === "find") {
    targets = [];
    const own = findOwnArguments(args);
    for (let i = 0; i < own.length; i++) {
      if (["-fprint", "-fprint0", "-fprintf", "-fls"].includes(own[i])) targets.push(own[++i]);
    }
    if (own.includes("-delete") || own.some(arg => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg))) {
      targets.push(...own.filter(arg => !arg.startsWith("-")));
    }
  } else if (command === "sed") {
    targets = sedWriteTargets(args);
    if (sedScripts(args)?.inPlace) targets.push(...args.filter(arg => !arg.startsWith("-")));
  } else if (readOnlyCommand(command, args, gitEnvironment(words, context.bindings))) return;
  else targets = args;
  // These writers obtain target names from stdin, not just their command-line operands.
  let gitGroup = 0;
  if (command === "git") {
    const globals = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
    while (args[gitGroup]?.startsWith("-")) gitGroup = option(args, gitGroup, globals).next;
  }
  if ((!readOnlyCommand(command, args, gitEnvironment(words, context.bindings)) && literalInput === undefined &&
       resolved.wrappers.some(({ name }) => ["xargs", "parallel"].includes(name))) ||
      (fedStdin && (command === "patch" || (command === "git" && args[gitGroup] === "apply"))))
    recordWrite(undefined, locations);
  if (literalInput !== undefined && resolved.wrappers.some(({name}) => ["xargs", "parallel"].includes(name)))
    targets.push(...tokenize(literalInput).commands.flat());
  let positional = false;
  const written = targets.flatMap(word => {
    if (word === "--") { positional = true; return []; }
    const target = ["cp", "mv", "rsync", "install"].includes(command)
      ? word : operandValue(word.replace(/^-[A-Za-z]+(?=\/|~\/|\.)/, ""));
    const previous = target && !target.startsWith("-") ? [target] : [];
    // Keep earlier conservative candidates as well as the literal operand after --.
    return positional && !previous.includes(word) ? [word, ...previous] : previous;
  });
  const directoryOnly = !otherWrites &&
    !resolved.wrappers.some(({ name }) => ["xargs", "parallel"].includes(name)) &&
    onlyDirectoryTarget(command, written, rawArgs, locations, context);
  for (const target of written) recordWrite(target, locations, false, directoryOnly);
}

function commandFinding(
  rawWords: string[],
  depth: number,
  context: Context,
  rawSources = rawWords,
  literalInput?: string,
  pipeOutput = false,
  fedStdin = false,
): Finding {
  if (depth > 32) return "complex";
  const words: string[] = [];
  const sources: string[] = [];
  let otherWrites = false;
  let finding: Finding;
  try {
    analysisWork(context.analysis, rawWords.length + 1);
    for (let i = 0; i < rawWords.length; i++) {
      if (isOperator(rawWords, i)) {
        if (!["<<", "<<-", "<<<"].includes(rawWords[i]))
          finding = strongest(finding, ordinaryFinding([rawWords[i + 1] ?? ""], [rawSources[i + 1] ?? ""], context));
        if (
          [">", ">>", ">|", ">&", "<>"].includes(rawWords[i]) &&
          protectedPath(rawWords[i + 1] ?? "", context.locations)
        )
          finding = strongest(finding, "tamper");
        if ([">", ">>", ">|", "<>", ">&"].includes(rawWords[i]) &&
            !(rawWords[i] === ">&" && /^(?:\d+|-)$/.test(rawWords[i + 1] ?? ""))) {
          otherWrites = true;
          recordWrite(rawWords[i + 1], context.locations);
        }
        i++;
      } else {
        words.push(rawWords[i]);
        sources.push(rawSources[i]);
      }
    }
    const resolved = resolveCommand(words);
    if (resolved.wrappers.some(({ name }) => ["xargs", "parallel", "watch"].includes(name)))
      context = { ...context, locations: { ...context.locations, repeated: true } };
    if (context.gitBindings) recordGitBindings(words, context.gitBindings, context.statement);
    if (context.backupBindings) recordGitBindings(words, context.backupBindings, context.statement, backupVariable);
    const writeLocations = wrapperLocations(words, resolved, context.locations);
    const wrapperReadOnly = readOnlyCommand(
      path.basename(words[resolved.index] ?? ""), words.slice(resolved.index + 1),
      gitEnvironment(words, context.bindings),
    );
    if (!wrapperReadOnly) {
      let directories = context.locations;
      for (const wrapper of resolved.wrappers) {
        for (let j = wrapper.index + 1; j < wrapper.target; j++) {
          if (!words[j]?.startsWith("-")) continue;
          const bundle = optionBundle(words, j, wrapperOptions[wrapper.name]);
          for (const flag of bundle.flags)
            if ((wrapper.name === "env" && ["-C", "--chdir"].includes(flag.name)) ||
                (wrapper.name === "sudo" && ["-D", "--chdir"].includes(flag.name)))
              recordWrite(flag.value, directories, false, false, true);
          j = bundle.next - 1;
        }
        directories = wrapperLocations(words, { ...resolved, wrappers: [wrapper] }, directories);
      }
    }
    let outputLocations = context.locations;
    for (const wrapper of resolved.wrappers) {
      const layer = { ...resolved, wrappers: [wrapper] };
      otherWrites ||= wrapperTargets(words, layer).length > 0;
      for (const target of wrapperTargets(words, { ...resolved, wrappers: [wrapper] })) recordWrite(target, outputLocations);
      outputLocations = wrapperLocations(words, layer, outputLocations);
    }
    if (createsLink(path.basename(words[resolved.index] ?? ""), words.slice(resolved.index + 1)))
      recordWrite(undefined, writeLocations);
    recordCommandWrites(words, resolved, writeLocations, context, literalInput, sources.slice(resolved.index + 1), otherWrites, fedStdin);
    if (wrapperTargets(words, resolved).some((word) => protectedPath(word, context.locations)))
      finding = strongest(finding, "tamper");
    if (words.some((word) => gitConfigEnvironment(word, words))) finding = strongest(finding, "tamper");
    if (path.basename(words[resolved.index] ?? "") === "rg") {
      for (let j = resolved.index + 1; j < words.length; j++) {
        if (words[j] === "--") break;
        if (/^--pre(?:=|$)/.test(words[j])) {
          const flag = option(words, j, new Set(["--pre", "--pre-glob"]));
          finding = strongest(finding, inspect(flag.value ?? "", depth + 1, { ...context, locations: { ...context.locations, repeated: true } }, `pre:${j}`));
          j = flag.next - 1;
        }
      }
    }
    const data = resolved.split || resolved.shell ? new Set<number>() : dataArguments(words, resolved.index);
    if (pipeOutput && ["echo", "printf"].includes(path.basename(words[resolved.index] ?? ""))) {
      for (let i = resolved.index + 1; i < words.length; i++) data.add(i);
    }
    for (const index of data) {
      words[index] = "__data__";
      sources[index] = "'__data__'";
    }
    // gh can be launched by any wrapper. A field value or a whole script string is not a
    // command word, but a standalone expansion/glob can resolve to gh at any position.
    for (let j = 0; j < words.length; j++) {
      const base = path.basename(words[j]);
      const dynamic = nonliteral.test(words[j]) && !/[\s=]/.test(words[j]) && !words[j].startsWith("-");
      if (base === "gh" || dynamic) {
        const args = words.slice(j + 1);
        finding = strongest(finding, ghFinding(args, base === "gh" || words[j].includes("gh")));
        if (args[skipFlags(args, 0)] === "api" && issueMutation.test(rawWords.slice(j + 1).join(" ")))
          finding = strongest(finding, "write");
      }
      if (base === "git") {
        finding = strongest(finding, gitFinding(words.slice(j + 1), gitEnvironment(words, context.bindings)));
        if (
          words.some(
            (word) =>
              /^GIT_(?:EXTERNAL_DIFF|SSH_COMMAND|SSH|ASKPASS|EDITOR|PAGER|SEQUENCE_EDITOR)=/.test(word) &&
              !gitPagerPrefixAllowed(word, words, context.gitBindings, context.statement),
          )
        )
          finding = strongest(finding, "tamper");
      }
    }
    for (const { name: wrapper, target: i, index: wrapperIndex, informational } of resolved.wrappers) {
      if (
        ["xargs", "parallel"].includes(wrapper) &&
        executesArguments(path.basename(words[i] ?? "")) &&
        !(wrapper === "xargs" && literalGhSubcommand(words, sources, i))
      )
        finding = strongest(finding, "write");
      if (
        wrapper === "env" &&
        i >= words.length &&
        !resolved.wrappers.some((entry) => entry.index < wrapperIndex && ["xargs", "parallel"].includes(entry.name)) &&
        !informational
      )
        finding = strongest(finding, "token");
    }
    if (resolved.shell) {
      const flag = resolved.shell;
      finding = strongest(finding, ordinaryFinding(words.slice(0, flag.index), sources.slice(0, flag.index), context));
      return strongest(finding, inspect(flag.value ?? "", depth + 1, context));
    }
    if (resolved.split) {
      const flag = resolved.split;
      const rest = words
        .slice(flag.next)
        .map((word, index) =>
          expandingTilde(sources[flag.next + index])
            ? sources[flag.next + index]
            : `'${word.replaceAll("'", "'\\''")}'`,
        )
        .join(" ");
      finding = strongest(finding, ordinaryFinding(words.slice(0, flag.index), sources.slice(0, flag.index), context));
      return strongest(finding, inspect(`env ${flag.value ?? ""} ${rest}`, depth + 1, context));
    }
    const i = resolved.index;
    const command = path.basename(words[i] ?? "");
    const args = words.slice(i + 1);
    if (command === "find") {
      for (const [index, child] of findChildren(args, sources.slice(i + 1)).entries()) {
        const statement = context.gitBindings
          ? writtenStatement(context.gitBindings, context.statement, `find:${index}`, child)
          : child;
        finding = strongest(
          finding,
          commandFinding(
            child,
            depth + 1,
            {
              ...context,
              statement,
              locations: { ...context.locations, statement, repeated: true },
            },
            findChildSources.get(child),
          ),
        );
      }
    }
    if (credentialCommand(command, args)) finding = strongest(finding, "token");
    if (readsCredentialDirectory(command, args, context.dotglob)) finding = strongest(finding, "token");
    // Unlike field values, a command substitution can contain spaces or '=' and still be gh.
    // Always inspect the actual command after assignments and wrappers have been skipped.
    if (command === "gh" || nonliteral.test(words[i] ?? "")) {
      finding = strongest(finding, ghFinding(args, command === "gh" || (words[i] ?? "").includes("gh")));
    }
    if (["curl", "wget", "http", "xh"].includes(command) && issueMutation.test(args.join(" ")))
      finding = strongest(finding, "write");
    if (
      tamperCommand(
        command,
        args,
        words.slice(0, i).some((word) => assignment.test(word)),
        gitEnvironment(words, context.bindings),
        context.locations,
        sources.slice(i + 1),
      )
    )
      finding = strongest(finding, "tamper");
    if (command === "git") {
      for (const { value, index } of gitShellPrograms(args))
        finding = strongest(finding, inspect(value, depth + 1, { ...context, locations: { ...context.locations, repeated: true } }, `git:${index}`));
    }
    if (command === "sed" && !sedSafe(args)) finding = strongest(finding, "write");
    if (shells.has(command)) {
      const c = args.findIndex((arg) => /^-[^-]*c/.test(arg));
      if (c >= 0 && typeof args[c + 1] === "string") {
        const codeIndex = i + c + 2;
        finding = strongest(
          finding,
          ordinaryFinding(
            words.filter((_, j) => j !== codeIndex),
            sources.filter((_, j) => j !== codeIndex),
            context,
          ),
        );
        const dotglob =
          context.dotglob ||
          args.some((arg, j) => ["-O", "-o"].includes(arg) && /^(?:dotglob|glob_?dots)$/.test(args[j + 1] ?? ""));
        finding = strongest(finding, inspect(args[c + 1], depth + 1, { ...context, dotglob }));
        return finding;
      }
    }
    const scanEnd = command === "eval" ? i + 1 : words.length;
    finding = strongest(finding, ordinaryFinding(words.slice(0, scanEnd), sources.slice(0, scanEnd), context));
    const programs = interpreter.test(command) ? inlinePrograms(command, args) : [];
    for (const code of programs) {
      if (code !== undefined && inlineCredentials(code, command)) finding = strongest(finding, "token");
      if (code !== undefined && launchesProcess(code, command)) finding = strongest(finding, "write");
    }
    if (
      (fedStdin || stdinOperand(args)) &&
      (shells.has(command) || schedulers.has(command) || interpreter.test(command)) &&
      (stdinProgramFile(command, args) || (programs.length === 0 && readsStdin(command, args)))
    ) {
      finding = strongest(
        finding,
        literalInput === undefined ? "write" : interpreterInput(command, literalInput, depth, context),
      );
    }
    if (command === "eval") {
      if (sources.slice(i + 1).some((source) => !expandWord(source, new Map()).literal))
        finding = strongest(finding, "write");
      finding = strongest(finding, inspect(args.join(" "), depth + 1, context, "eval"));
    }
    return finding;
  } catch {
    return strongest(finding, "complex");
  }
}

function findOwnArguments(args: string[]): string[] {
  const own: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (["-exec", "-execdir", "-ok", "-okdir"].includes(args[i])) {
      while (i < args.length && ![";", "+"].includes(args[i])) i++;
    } else own.push(args[i]);
  }
  return own;
}

function looseWords(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, "")
    .replace(/['"\\[\],]/g, " ")
    .split(/[\s;|&(){}<>`!]+/)
    .filter(Boolean);
}

function looseEmbeddedFinding(text: string, depth = 0): Finding {
  if (depth > 32) return "complex";
  let finding: Finding;
  try {
    // Unwrap quoted script strings and argument arrays while preserving each API argument.
    // Flattening quotes/braces would turn a valid GraphQL read query into an opaque write.
    const parsed = tokenize(text, true);
    if (parsed.incomplete) throw new Error("incomplete embedded syntax");
    for (const words of parsed.commands) {
      for (let i = 0; i < words.length; i++) {
        if (path.basename(words[i]) === "gh" && ["api", "auth", "config"].includes(words[skipFlags(words, i + 1)])) {
          finding = strongest(finding, ghFinding(words.slice(i + 1)));
        } else if (path.basename(words[i]) === "git" && gitFinding(words.slice(i + 1)) === "token") {
          finding = strongest(finding, "token");
        } else if (words[i] !== text && /\b(?:gh|git)\b/.test(words[i])) {
          finding = strongest(finding, looseEmbeddedFinding(words[i], depth + 1));
        }
      }
    }
  } catch {
    // If an embedded language's quoting cannot be parsed, retain the conservative raw scan.
    const words = looseWords(text);
    for (let i = 0; i < words.length; i++) {
      if (path.basename(words[i]) === "gh" && ["api", "auth", "config"].includes(words[skipFlags(words, i + 1)])) {
        finding = strongest(finding, ghFinding(words.slice(i + 1)));
      }
      if (path.basename(words[i]) === "git" && gitFinding(words.slice(i + 1)) === "token")
        finding = strongest(finding, "token");
    }
  }
  return finding;
}

function looseFinding(text: string): Finding {
  const raw = text.replace(/\\\r?\n/g, "").replace(/['"\\]/g, "");
  let finding: Finding = privateTerms.test(raw) ? "private-terms" : undefined;
  if (githubEndpoint.test(raw)) finding = strongest(finding, "write");
  const loose = looseWords(text);
  for (let i = 0; i < loose.length; i++) {
    if (path.basename(loose[i]) === "gh" && ["issue", "label", "alias", "extension"].includes(loose[i + 1]))
      finding = strongest(finding, ghFinding(loose.slice(i + 1)));
  }
  return strongest(finding, looseEmbeddedFinding(text));
}

function expandedCommand(
  original: string[],
  rawSources: string[],
  bindings: Map<string, string>,
): { words: string[]; sources: string[] }[] {
  const words: string[] = [];
  const sources: string[] = [];
  const operators = new Set<number>();
  let expandedCount = 0;
  let commandRange: [number, number] | undefined;
  const commandIndex = resolveCommand(original).index;
  for (let i = 0; i < original.length; i++) {
    if (isOperator(original, i)) {
      operators.add(words.length);
      words.push(original[i]);
      sources.push(rawSources[i]);
      continue;
    }
    const alternatives = braceWords(rawSources[i]);
    if (alternatives.length > 1) expandedCount += alternatives.length;
    if (expandedCount > 256) throw new AnalysisLimit();
    const start = words.length;
    for (const source of alternatives) {
      if (source === "" && alternatives.length > 1) continue;
      words.push(expandWord(source, bindings).value);
      sources.push(source);
    }
    if (i === commandIndex && words.length - start > 1) commandRange = [start, words.length];
  }
  operatorTokens.set(words, operators);
  const variants = [{ words, sources }];
  if (commandRange) {
    const [start, end] = commandRange;
    for (let chosen = start; chosen < end; chosen++) {
      const indices = words.map((_, i) => i).filter((i) => i < start || i >= end || i === chosen);
      const alternative = indices.map((i) => words[i]);
      operatorTokens.set(alternative, new Set(indices.flatMap((i, index) => (operators.has(i) ? [index] : []))));
      variants.push({ words: alternative, sources: indices.map((i) => sources[i]) });
    }
  }
  return variants;
}

function inspect(text: string, depth = 0, inherited?: Context, site = "shell"): Finding {
  if (depth > 32) return "complex";
  const analysis = inherited?.analysis ?? { work: 0, characters: 0, exhausted: false, bodies: new WeakMap() };
  let cached: Map<Values | undefined, Finding> | undefined;
  if (inherited?.statement) {
    const cacheOwner = inherited.statement;
    let bodies = analysis.bodies.get(cacheOwner);
    if (!bodies) {
      bodies = new Map();
      analysis.bodies.set(cacheOwner, bodies);
    }
    const key = JSON.stringify([
      site,
      text,
      inherited.locations?.cwdCandidates ?? inherited.locations?.cwd,
      inherited.dotglob,
    ]);
    cached = bodies.get(key);
    if (!cached) {
      cached = new Map();
      bodies.set(key, cached);
    }
    if (cached.has(inherited.values)) return cached.get(inherited.values);
  }
  analysis.characters += text.length;
  if (analysis.exhausted || analysis.characters > 262144) {
    analysis.exhausted = true;
    return "complex";
  }
  let dotglob = inherited?.dotglob ?? false;
  let execInput = false;
  let finding: Finding;
  const gitBindings = inherited?.gitBindings ?? { runsGit: false, bindings: [] };
  const backupBindings = inherited?.backupBindings ?? { runsGit: false, bindings: [] };
  // Intern the containing body once; each statement uses only its small position key.
  const bodyIdentity = JSON.stringify([site, text]);
  const bodyOwner = inherited?.statement
    ? writtenStatement(gitBindings, inherited.statement, bodyIdentity, [])
    : undefined;
  const writes = inherited?.locations?.writes ?? { copies: writeIndex(), writes: writeIndex(), unknown: [], blocked: false, analysis };
  try {
    const parsed = tokenize(text);
    analysisWork(analysis, parsed.commands.length);
    const inputsByStatement = new Map<string[], typeof parsed.inputs>();
    const nestedByStatement = new Map<string[], typeof parsed.nested>();
    for (const input of parsed.inputs) {
      const inputs = inputsByStatement.get(input.words) ?? [];
      inputs.push(input);
      inputsByStatement.set(input.words, inputs);
    }
    for (const nested of parsed.nested) {
      const bodies = nestedByStatement.get(nested.words) ?? [];
      bodies.push(nested);
      nestedByStatement.set(nested.words, bodies);
    }
    const producers = new Set(parsed.pipes.values());
    if (parsed.incomplete) finding = "complex";
    if (parsed.credentials) finding = "token";
    let values: Values;
    try {
      values = collectValues(parsed, inherited?.values, analysis);
    } catch {
      if (analysis.exhausted) return "complex";
      finding = strongest(finding, "complex");
      values = inherited?.values ?? new Map();
    }
    const cwdCandidates = new Set<string | undefined>(
      inherited?.locations?.cwdCandidates ?? [
        typeof inherited?.locations?.cwd === "string" ? inherited.locations.cwd : undefined,
      ],
    );
    const configRoots = configBindingRoots(parsed, values, inherited?.locations);
    const loops: number[] = [];
    for (const [statementIndex, original] of parsed.commands.entries()) {
      const positionKey = String(statementIndex);
      const statement = writtenStatement(gitBindings, bodyOwner, positionKey, original);
      const rawSources = parsed.sources.get(original) ?? original;
      let loopIndex = 0;
      while (["do", "then", "else", "!"].includes(original[loopIndex])) loopIndex++;
      const loopCommand = original[loopIndex];
      if (loopCommand === "done") loops.pop();
      if (["for", "select", "while", "until"].includes(loopCommand)) {
        const list = rawSources
          .slice(loopIndex + 3)
          .flatMap((raw) => braceWords(raw))
          .map((raw) => expandWord(raw, new Map()));
        loops.push(list.length && list.every(({ literal }) => literal) ? list.length : 1);
        if (loops.reduce((count, size) => count * size, 1) > 64) finding = strongest(finding, "complex");
      }
      const upstream = parsed.pipes.get(original);
      const relatedSources = [...rawSources, ...(upstream ? (parsed.sources.get(upstream) ?? upstream) : [])];
      let variants: Map<string, string>[];
      const nextDirectories = new Set<string | undefined>();
      try {
        variants = bindingVariants(relatedSources, values);
      } catch {
        finding = strongest(finding, "complex");
        variants = [new Map()];
      }
      for (const bindings of variants) {
        const context: Context = {
          bindings,
          values,
          dotglob,
          locations: {
            ...inherited?.locations,
            ...configRoots,
            cwdCandidates: [...cwdCandidates],
            writes,
            statement,
            repeated: inherited?.locations?.repeated || loops.length > 0 || parsed.repeated.has(original),
            backupBound: backupBindings.bindings.length > 0,
          },
          gitBindings,
          backupBindings,
          statement,
          analysis,
        };
        for (const { words, sources } of expandedCommand(original, rawSources, context.bindings)) {
          const commandWords = withoutRedirects(words);
          const directoryCommand = resolveCommand(commandWords).index;
          if (["cd", "pushd"].includes(commandWords[directoryCommand])) {
            const operands = commandWords
              .slice(directoryCommand + 1)
              .filter((word) => !["--", "-L", "-P", "-e"].includes(word));
            const target = operands[0] ?? "~";
            for (const candidate of candidateLocations(context.locations))
              nextDirectories.add(
                target === "-" || /^[-+]\d+$/.test(target) ? undefined : absoluteLocation(target, candidate),
              );
          }
          for (const word of original) {
            if (word.startsWith("GLOBIGNORE=")) context.dotglob = true;
          }
          if (
            (words.includes("shopt") && words.includes("-s") && words.includes("dotglob")) ||
            (words.includes("setopt") && words.some((word) => /^(?:globdots|glob_dots)$/.test(word)))
          )
            context.dotglob = true;
          const producer = parsed.pipes.get(original);
          let literalInput = producer && literalProducer(producer, parsed.sources.get(producer) ?? producer, context);
          let pipeBody = producer && literalProducer(producer, parsed.sources.get(producer) ?? producer, context, true);
          if (producer && withoutRedirects(producer).length === 1 && path.basename(producer[0]) === "cat") {
            const produced = inputsByStatement.get(producer)?.at(-1);
            const lastInput = producer
              .filter((word, i) => isOperator(producer, i) && ["<", "<>", "<&", "<<", "<<-", "<<<"].includes(word))
              .at(-1);
            if (produced && ["<<", "<<-", "<<<"].includes(lastInput ?? "")) {
              pipeBody = produced.body;
              if (produced.literal) literalInput = produced.body;
            }
          }
          const inputs = inputsByStatement.get(original) ?? [];
          const inputOperator = original
            .filter((word, i) => isOperator(original, i) && ["<", "<>", "<&", "<<", "<<-", "<<<"].includes(word))
            .at(-1);
          if (inputOperator && resolveCommand(withoutRedirects(words)).wrappers.some(({ name }) => name === "exec"))
            execInput = true;
          if (inputOperator) {
            pipeBody = undefined;
            literalInput = undefined;
            const input = inputs.at(-1);
            if (["<<", "<<-", "<<<"].includes(inputOperator) && input?.literal) literalInput = input.body;
          }
          if (parsed.scoped.has(original)) literalInput = undefined;
          const pipeOutput = producers.has(original) && literalProducer(original, sources, context) !== undefined;
          finding = strongest(
            finding,
            commandFinding(
              words,
              depth,
              context,
              sources,
              literalInput,
              pipeOutput,
              parsed.fed.has(original) || parsed.scoped.has(original) || execInput || !!inputOperator,
            ),
          );
          for (const [index, nested] of (nestedByStatement.get(original) ?? []).entries())
            finding = strongest(finding, inspect(nested.body, depth + 1, context, `substitution:${index}`));
          const inputWords = withoutRedirects(words);
          const resolved = resolveCommand(inputWords);
          const receiver = path.basename(inputWords[resolved.index] ?? "");
          const codeInput = !dataReceiver(inputWords, resolved);
          if (codeInput && pipeBody !== undefined)
            finding = strongest(finding, interpreterInput(receiver, pipeBody, depth, context, "stdin"));
          for (const [inputIndex, input] of inputs.entries()) {
            if (codeInput)
              finding = strongest(
                finding,
                interpreterInput(
                  receiver,
                  input.body,
                  depth,
                  context,
                  inputIndex === inputs.length - 1 ? "stdin" : `heredoc:${inputIndex}`,
                ),
              );
            if (input.expand) {
              const expanded = tokenize(input.body, false, true);
              if (expanded.incomplete) finding = strongest(finding, "complex");
              if (expanded.credentials) finding = "token";
              for (const [index, nested] of expanded.nested.entries())
                finding = strongest(finding, inspect(nested.body, depth + 1, context, `input:${inputIndex}:${index}`));
            }
            if (
              issueMutation.test(input.body) &&
              receiver === "gh" &&
              inputWords[skipFlags(inputWords, resolved.index + 1)] === "api"
            )
              finding = strongest(finding, "write");
          }
          dotglob ||= context.dotglob;
        }
      }
      for (const directory of nextDirectories) cwdCandidates.add(directory);
      if (cwdCandidates.size > 8) {
        cwdCandidates.clear();
        cwdCandidates.add(undefined);
      }
    }
  } catch {
    if (analysis.exhausted) return "complex";
    finding = strongest(finding, "complex");
    // Broken quoting must not suppress a write. Keep the conservative loose/raw fallback.
    finding = strongest(finding, looseFinding(text));
    const words = text
      .replace(/['"\\]/g, "")
      .split(/[\s;|&(){}<>`]+/)
      .filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      if (path.basename(words[i]) === "gh" || nonliteral.test(words[i]))
        finding = strongest(
          finding,
          ghFinding(words.slice(i + 1), path.basename(words[i]) === "gh" || words[i].includes("gh")),
        );
    }
  }
  if (analysis.exhausted) return "complex";
  try {
    if (depth === 0 && (gitBindingsTamper(gitBindings) || writes.blocked))
      finding = strongest(finding, "tamper");
  } catch {
    return "complex";
  }
  cached?.set(inherited?.values, finding);
  return finding;
}

function mainCheckout(cwd: unknown): boolean {
  const root = process.env.CLAUDE_PROJECT_DIR || cwd;
  if (typeof root !== "string" || !root) return false;
  // Ignore inherited GIT_DIR/GIT_COMMON_DIR/config overrides. Only this fixed, read-only
  // lookup runs, and only after a write matched. Failure or timeout means worker/deny.
  const git = spawnSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 1500,
    maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull },
  });
  const dirs = git.stdout?.trim().split(/\r?\n/);
  return (
    !git.error &&
    git.status === 0 &&
    dirs?.length === 2 &&
    dirs.every((dir) => path.isAbsolute(dir)) &&
    dirs[0] === dirs[1]
  );
}

function strictGraphqlInput(command: string, cwd: unknown): boolean {
  // Match raw text, without shell parsing, expansion, path normalization, or a newline-tolerant $.
  const match = /^gh api graphql (?:(?:--hostname[ =]github\.com )?--input[ =]('[A-Za-z0-9._/-]+'|[A-Za-z0-9._/-]+)|--input[ =]('[A-Za-z0-9._/-]+'|[A-Za-z0-9._/-]+) --hostname[ =]github\.com)(?![\s\S])/.exec(command);
  if (!match || typeof cwd !== "string") return false;
  const raw = match[1] ?? match[2];
  const operand = raw.startsWith("'") ? raw.slice(1, -1) : raw;
  try {
    const git = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 1500, maxBuffer: 64 * 1024,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull },
    });
    if (git.error || git.status !== 0 || typeof git.stdout !== "string") return false;
    const root = git.stdout.replace(/\n$/, "");
    if (!/^\/[A-Za-z0-9._/-]+(?![\s\S])/.test(root) || root.split("/").some(part => part === "." || part === "..") || operand.includes("//")) return false;
    const relative = operand.startsWith(`${root}/`) ? operand.slice(root.length + 1) : operand;
    if (!/^\.wt\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$/.test(relative)) return false;
    if (relative === operand && cwd !== root) return false;
    const directory = `${root}/.wt`;
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== `${realpathSync(root)}/.wt`) return false;
    const fd = openSync(`${root}/${relative}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const limit = 64 * 1024;
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > limit) return false;
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > limit) return false;
      const json = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      const body = JSON.parse(json);
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.query !== "string" ||
          Object.keys(body).some(key => key !== "query" && key !== "variables")) return false;
      // JSON.parse validates syntax; scan its string/structural tokens to retain top-level duplicates.
      const tokens = json.match(/"(?:\\.|[^"\\])*"|[{}[\]:]/g) ?? [];
      const keys = new Set<string>();
      let depth = 0;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === "{" || token === "[") depth++;
        else if (token === "}" || token === "]") depth--;
        else if (depth === 1 && tokens[i + 1] === ":") {
          const key = JSON.parse(token);
          if (keys.has(key)) return false;
          keys.add(key);
        }
      }
      return !issueMutation.test(body.query) && !graphqlWrite(body.query);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function decide(permissionDecision: "ask" | "deny", permissionDecisionReason: string): void {
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } })}\n`,
  );
}

let input: { tool_input?: { command?: unknown }; cwd?: unknown };
try {
  input = JSON.parse(readFileSync(0, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("not an object");
} catch {
  process.stderr.write("BLOCKED: guard-github-writes: unreadable hook input.\n");
  process.exit(2);
}
// Bash and Monitor both supply tool_input.command. Other inputs need no decision.
const command = input.tool_input?.command;
if (typeof command === "string") {
  const finding = inspect(command, 0, {
    bindings: new Map(),
    dotglob: false,
    locations: { cwd: input.cwd, projectDir: process.env.CLAUDE_PROJECT_DIR, home: process.env.HOME, tmpdir: tmpdir() },
  });
  if (finding === "token") {
    decide(
      "deny",
      "Agents never handle tokens; authentication changes, credential extraction and environment dumps are forbidden. Use printenv NAME for one non-secret variable.",
    );
  } else if (finding === "private-terms") {
    decide(
      "deny",
      "Agents never read or change .private-terms. A text search can use private-terms without the leading dot.",
    );
  } else if (finding === "complex") {
    decide("deny", "too complex to check; split the command");
  } else if (finding === "tamper") {
    decide(
      "deny",
      "Agents never change guard hooks, Claude settings, or git metadata used to locate the hooks. Workers change worktrees only through bin/wt. These direct changes are denied in the main checkout too; the owner maintains the guard.",
    );
  } else if (finding === "write" && !strictGraphqlInput(command, input.cwd)) {
    if (mainCheckout(input.cwd)) {
      decide(
        "ask",
        `This command changes a GitHub issue or label with the owner's login. Confirm: ${command.replace(/\s/g, " ").slice(0, 200)}`,
      );
    } else {
      decide(
        "deny",
        "Workers never change GitHub issues or labels. The owner does, through /e-issue in the main checkout (a failed git lookup also blocks writes).",
      );
    }
  }
}
