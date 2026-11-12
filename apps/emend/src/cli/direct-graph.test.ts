// This guard catches honest refactors that pull reviewer-only writes into an agent
// process, not deliberately obfuscated repo code (review covers that). At the few
// sensitive sites it rejects shapes it cannot prove safe; after fix round 2 it stops growing.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transform } from "esbuild";
import { expect, onTestFinished, test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
async function sources(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => (entry.isDirectory() ? sources(join(folder, entry.name)) : [join(folder, entry.name)])),
    )
  )
    .flat()
    .filter((path) => path.endsWith(".ts") && !basename(path).endsWith(".test.ts"));
}

const parseOptions = {
  bundle: true,
  write: false,
  metafile: true as const,
  platform: "node" as const,
  format: "esm" as const,
  packages: "external" as const,
  treeShaking: false,
  logLevel: "silent" as const,
  tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
  logOverride: { "unsupported-dynamic-import": "warning" as const, "unsupported-require-call": "warning" as const },
};
async function parsedSource(path: string) {
  // esbuild parses TS, removes comments/types and normalizes string quoting before
  // the conservative call checks below. Module edges come only from its metafile.
  return (
    await transform(await readFile(path, "utf8"), {
      loader: "ts",
      minify: false,
      tsconfigRaw: parseOptions.tsconfigRaw,
    })
  ).code;
}
async function assertOnlyOpen(root: string) {
  const callers: string[] = [];
  for (const path of await sources(root)) {
    const source = await parsedSource(path);
    if (/\b(?<!function )ensureServer\s*\(/.test(source) || /\bensureServer\s+as\s+\w+/.test(source))
      callers.push(relative(root, path));
  }
  expect(callers.filter((path) => path !== "cli/commands/open.ts")).toEqual([]);
}

test("only the reviewer open command calls ensureServer", () => assertOnlyOpen(root));

const forbidden = new Set([
  "server/routes/threads.ts",
  "server/routes/comments.ts",
  "server/routes/sends.ts",
  "db/repo/threads.ts",
  "server/mailbox/sends.ts",
  "server/auth/pairings.ts",
  "server/auth/sessions.ts",
  "server/routes/pairings.ts",
  "server/routes/session.ts",
]);
const reviewerTables = ["sends", "pairings", "devices"];
const tableBindings = new Map<
  string,
  { reason: string; tables: readonly string[]; updates: Readonly<Record<string, readonly string[]>> }
>([
  [
    "server/mailbox/payload.ts",
    { reason: "Reads Sends to size and assemble agent hand-offs.", tables: ["sends"], updates: {} },
  ],
  [
    "server/mailbox/take.ts",
    {
      reason: "Claims, releases and sets aside Sends using only delivery metadata.",
      tables: ["sends"],
      updates: { sends: ["deliveryId", "setAsideAt"] },
    },
  ],
  [
    "server/auth/tokens.ts",
    {
      reason: "Reads devices to validate credentials; reached code never writes devices.",
      tables: ["devices"],
      updates: {},
    },
  ],
  [
    "db/client.ts",
    {
      reason: "Binds only the schema namespace to the query client; no named tables or raw reads.",
      tables: [],
      updates: {},
    },
  ],
]);
const mayBindTable = (name: string, table: string) => tableBindings.get(name)?.tables.includes(table) ?? false;
const valueRules = [
  { table: "reviews", key: "state", allowed: (value: string) => value !== "approved" },
  { table: "comments", key: "author", allowed: (value: string) => value === "agent" },
  { table: "tokens", key: "kind", allowed: (value: string) => ["admin", "agent"].includes(value) },
];
const sensitiveTables = [...reviewerTables, ...valueRules.map((rule) => rule.table)];
// These modules have real multiline templates after esbuild's normalization.
// Only templates get this exemption; a quoted match spanning lines still fails.
// SQL templates are still scanned, and the fixed inline worker is walked separately.
const multilineTemplates = new Map([
  ["main.ts", "CLI help, version output and diagnostics contain newlines."],
  ["server/mailbox/payload.ts", "Multiline SQL reads size and assemble hand-off payloads."],
  ["server/mailbox/take.ts", "Multiline SQL reads select and size pending Sends and comments."],
  ["server/publish/changed.ts", "Multiline SQL inserts changed-block IDs, not reviewer data."],
  ["db/client.ts", "The fixed transactionWorkerSource is parsed and checked separately."],
  ["cli/http.ts", "JSON output and diagnostics end with a newline."],
  ["cli/git.ts", "The object-format probe compares a newline-terminated result."],
  ["cli/config.ts", "Config diagnostics end with a newline."],
  ["cli/publish/assets.ts", "Skipped-asset diagnostics end with a newline."],
  ["cli/publish/collect.ts", "Nested-repository diagnostics end with a newline."],
  ["cli/publish/sides.ts", "Synthetic submodule content ends with a newline."],
  ["cli/commands/publish.ts", "Publish diagnostics end with a newline."],
  ["cli/commands/feedback.ts", "The reply hint on stderr ends with a newline."],
  ["cli/commands/mcp.ts", "MCP JSON output ends with a newline."],
]);
const nonSqlQuotes = new Map<string, { reason: string; accepts: (quote: string, content: string) => boolean }>([
  ["cli.ts", { reason: "update names a CLI command.", accepts: (_quote, content) => content === "update" }],
  [
    "main.ts",
    {
      reason: "update names a CLI command.",
      accepts: (_quote, content) => content === "update",
    },
  ],
]);
const workerSpawners = new Set(["db/client.ts", "server/publish/executor.ts"]);
// Receivers use parentPort (and the inline worker's workerData), never construct workers.
const workerReceivers = new Set(["server/publish/worker.ts", "db/client.ts inline worker"]);

function bindings(source: string, name: string) {
  const names = new Set([name]);
  for (const match of source.matchAll(new RegExp(`\\b${name}(?:\\s+as\\s+|\\s*:\\s*)([\\w$]+)`, "g")))
    if (match[1]) names.add(match[1]);
  // Follow ordinary local aliases as well as renamed imports/destructuring.
  let previousSize = 0;
  while (previousSize !== names.size) {
    previousSize = names.size;
    for (const match of source.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+\.)?([\w$]+)\s*[;,]/g))
      if (match[1] && names.has(match[2] ?? "")) names.add(match[1]);
  }
  // Match aliases at call sites, without rewriting string values such as "reviewer".
  return `(?:${[...names].map((value) => value.replaceAll("$", "\\$")).join("|")})`;
}

// Split only the arguments/properties at a sensitive call site. esbuild has
// already parsed the module; nested expressions and quoted commas stay intact.
function delimited(source: string, start: number) {
  const closing: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack = [closing[source[start] ?? ""]];
  const parts: string[] = [];
  let begin = start + 1;
  let quote = "";
  for (let index = begin; index < source.length; index++) {
    const char = source[index] ?? "";
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
    } else if ("\"'`".includes(char)) quote = char;
    else if (closing[char]) stack.push(closing[char]);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) {
        parts.push(source.slice(begin, index).trim());
        return { parts: parts.filter(Boolean), end: index + 1 };
      }
    } else if (char === "," && stack.length === 1) {
      parts.push(source.slice(begin, index).trim());
      begin = index + 1;
    }
  }
  throw new Error("unresolved sensitive call");
}

function literal(value: string | undefined): string | undefined {
  if (value && /^'[^'\\]*'$/.test(value)) return value.slice(1, -1);
  if (value && /^`[^`\\]*`$/.test(value) && !value.includes("${")) return value.slice(1, -1);
  if (value && /^"(?:[^"\\]|\\.)*"$/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      /* Not a literal in the original TS source. */
    }
  }
  return undefined;
}

function safeProperty(value: string | undefined, key: string, allowed: (value: string) => boolean, required: boolean) {
  if (!value?.startsWith("{")) return false;
  const object = delimited(value, 0);
  if (object.end !== value.length) return false;
  let found = false;
  for (const property of object.parts) {
    if (!/^(?:[\w$]+|"(?:[^"\\]|\\.)*")\s*:|^[\w$]+$/.test(property)) return false;
    if (new RegExp(`^(?:${key}|"${key}")(?:\\s*:|$)`).test(property)) {
      found = true;
      const field = literal(property.slice(property.indexOf(":") + 1).trim());
      if (field === undefined || !allowed(field)) return false;
    }
  }
  return found || !required;
}

// Only statically named keys can authorize delivery updates or conflict-update objects.
function namedProperties(value: string | undefined, allowShorthand = false): Map<string, string> | undefined {
  if (!value?.startsWith("{")) return undefined;
  const object = delimited(value, 0);
  if (object.end !== value.length) return undefined;
  const fields = new Map<string, string>();
  for (const property of object.parts) {
    // A shorthand names its key, but does not prove its value is a literal.
    if (allowShorthand && /^[\w$]+$/.test(property)) {
      fields.set(property, property);
      continue;
    }
    const match = /^([\w$]+|"(?:[^"\\]|\\.)*"|'[^']*')\s*:\s*([\s\S]+)$/.exec(property);
    if (!match?.[1] || !match[2]) return undefined;
    const key = literal(match[1]) ?? match[1];
    if (fields.has(key)) return undefined;
    fields.set(key, match[2]);
  }
  return fields;
}

// SQL checks understand only named tables, explicit assignment keys and VALUES
// lists. At these sensitive writes, anything outside that small grammar fails.
function sqlTokens(value: string): string[] {
  return (
    value.match(
      /--[^\n]*|\/\*[\s\S]*?\*\/|\$\{[^}]*\}|'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[\w$]+|[^\s]/g,
    ) ?? []
  ).filter((token) => !token.startsWith("--") && !token.startsWith("/*"));
}
function sqlName(value: string | undefined): string {
  return (value ?? "").replace(/^\$\{\s*|\s*\}$/g, "").replace(/["'`[\]]/g, "");
}
function sqlParts(tokens: string[]): string[][] {
  const parts: string[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token === "(") depth++;
    if (token === ")") depth--;
    if (token === "," && depth === 0) parts.push([]);
    else parts.at(-1)?.push(token);
  }
  return parts;
}
function sqlList(tokens: string[], start: number) {
  if (tokens[start] !== "(") return undefined;
  let depth = 1;
  for (let index = start + 1; index < tokens.length; index++) {
    if (tokens[index] === "(") depth++;
    if (tokens[index] === ")" && --depth === 0)
      return { parts: sqlParts(tokens.slice(start + 1, index)), end: index + 1 };
  }
  return undefined;
}
function sqlAssignments(tokens: string[], start: number) {
  let end = start;
  let depth = 0;
  for (; end < tokens.length; end++) {
    const token = tokens[end] ?? "";
    if (depth === 0 && /^(?:where|returning|order|limit|on|;)$/i.test(token)) break;
    if (token === "(") depth++;
    if (token === ")") depth--;
  }
  return sqlParts(tokens.slice(start, end));
}
function sqlString(tokens: string[]): string | undefined {
  const value = tokens[0];
  // SQLite double quotes can refer to a column, so only single quotes prove a string.
  return tokens.length === 1 && value && /^'(?:[^']|'')*'$/.test(value)
    ? value.slice(1, -1).replaceAll("''", "'")
    : undefined;
}
function assertAgentSql(
  source: string,
  name: string,
  schemaSpecifiers: ReadonlySet<string>,
  fail: (reason: string) => never,
) {
  const tableName = (value: string | undefined) =>
    sensitiveTables.find((table) =>
      new RegExp(`^(?:[\\w$]+\\.)?${bindings(source, table)}$`, "i").test(sqlName(value)),
    );
  for (const match of source.matchAll(new RegExp(`\\b${bindings(source, "sql")}\\.identifier\\s*\\(`, "g"))) {
    const args = delimited(source, match.index + match[0].length - 1);
    if (tableName(literal(args.parts[0]))) fail("sensitive SQL identifier");
  }
  // Generated migration DDL names every table; it is exempt from SQL scanning only.
  if (name === "db/migrations.gen.ts") return;
  const schemaNames: string[] = [];
  for (const match of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*("(?:[^"\\]|\\.)*")/g)) {
    if (!schemaSpecifiers.has(literal(match[2]) ?? "")) continue;
    for (const member of (match[1] ?? "").split(",")) {
      const imported = /^\s*([\w$]+)/.exec(member)?.[1];
      if (imported) schemaNames.push(bindings(source, imported));
    }
  }
  const quoted = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  // Overlapping starts recover SQL after the schema's nested enum templates:
  // exempting a quote span must not let its closing quote hide the next query.
  const quotes = [...source.matchAll(name === "db/schema.ts" ? new RegExp(`(?=(${quoted.source}))`, "g") : quoted)].map(
    (match) => match[name === "db/schema.ts" ? 1 : 0] ?? "",
  );
  // Schema enum constraints nest quotes/templates (schema.ts:51). Only the
  // quote-span rejection is exempt; every extracted SQL write is still checked.
  for (const quote of quotes)
    if (name !== "db/schema.ts" && /[\r\n]/.test(quote) && !(quote.startsWith("`") && multilineTemplates.has(name)))
      fail("multiline quote scan");
  const reviewAssignments = (assignments: string[][]) => {
    for (const assignment of assignments) {
      if (!assignment[0] || assignment[0].startsWith("${") || assignment[1] !== "=" || assignment.length < 3)
        fail("review state SQL");
      if (sqlName(assignment[0]).toLowerCase() === "state") {
        const state = sqlString(assignment.slice(2));
        if (state === undefined || state === "approved") fail("review state SQL");
      }
    }
  };
  for (const quote of quotes) {
    const query = literal(quote) ?? quote.slice(1, -1);
    if (nonSqlQuotes.get(name)?.accepts(quote, query)) continue;
    if (!/\b(?:select|insert|replace|update|delete|with|from|join|create|alter|drop)\b/i.test(query)) continue;
    if (name === "db/client.ts" && /\bselect\b/i.test(query)) fail("reviewer SQL binding");
    // Static main help names the devices command; all SQL write checks still apply.
    const help = name === "main.ts" && quote.startsWith("`") && query.startsWith("Usage:\n") && !query.includes("${");
    if (
      !help &&
      reviewerTables.some(
        (table) => !mayBindTable(name, table) && new RegExp(`\\b${bindings(source, table)}\\b`, "i").test(query),
      )
    )
      fail("reviewer SQL binding");
    const tokens = sqlTokens(query);
    for (let index = 0; index < tokens.length; index++) {
      const verb = tokens[index]?.toLowerCase();
      if (!verb || !["insert", "replace", "update", "delete"].includes(verb)) continue;
      if (tokens.length === 1) fail("unresolved SQL write target");
      let cursor = index + 1;
      if (tokens[cursor]?.toLowerCase() === "or") cursor += 2;
      // An interior prose word ("needs an update.") is not an UPDATE statement.
      if (verb === "update" && index > 0 && !tokens.slice(cursor).some((token) => token.toLowerCase() === "set"))
        continue;
      if (verb !== "update") {
        if (tokens[cursor]?.toLowerCase() !== (verb === "delete" ? "from" : "into")) continue;
        cursor++;
      }
      if (tokens[cursor + 1] === ".") cursor += 2;
      const target = tokens[cursor++];
      const table = tableName(target);
      if (target?.includes("${")) {
        if (!table && !schemaNames.some((binding) => new RegExp(`^${binding}$`).test(sqlName(target))))
          fail("unresolved SQL write target");
      } else if (!target || target === "$" || !/^(?:[\w$]+|"[^"]+"|'[^']+'|`[^`]+`|\[[^\]]+\])$/.test(target))
        fail("unresolved SQL write target");
      if (!table) continue;
      if (table !== "reviews") {
        // No reached code needs raw writes to these tables, even delivery columns.
        fail("reviewer table SQL");
      } else if (verb === "update") {
        if (tokens[cursor++]?.toLowerCase() !== "set") fail("review state SQL");
        reviewAssignments(sqlAssignments(tokens, cursor));
      } else if (verb === "insert" || verb === "replace") {
        const columns = sqlList(tokens, cursor);
        if (!columns || columns.parts.some((part) => part.length !== 1 || part[0]?.startsWith("${")))
          fail("review state SQL");
        const columnNames = columns.parts.map((part) => sqlName(part[0]).toLowerCase());
        if (new Set(columnNames).size !== columnNames.length) fail("review state SQL");
        cursor = columns.end;
        if (tokens[cursor++]?.toLowerCase() !== "values") fail("review state SQL");
        const stateIndex = columnNames.indexOf("state");
        do {
          const values = sqlList(tokens, cursor);
          if (!values || values.parts.length !== columns.parts.length) fail("review state SQL");
          if (stateIndex >= 0) {
            const state = sqlString(values.parts[stateIndex] ?? []);
            if (state === undefined || state === "approved") fail("review state SQL");
          }
          cursor = values.end;
          if (tokens[cursor] !== ",") break;
          cursor++;
        } while (cursor < tokens.length);
        // Inspect every conflict arm, including a second ON CONFLICT clause.
        for (let conflict = cursor; conflict < tokens.length && tokens[conflict] !== ";"; conflict++)
          if (tokens[conflict]?.toLowerCase() === "update" && tokens[conflict + 1]?.toLowerCase() === "set")
            reviewAssignments(sqlAssignments(tokens, conflict + 2));
      }
    }
  }
}

function assertAgentCalls(
  source: string,
  name: string,
  schemaSpecifiers: ReadonlySet<string> = new Set(),
  normalized = false,
  schemaTables: ReadonlySet<string> = new Set(sensitiveTables),
) {
  const table = (name: string) => `(?:[\\w$]+\\.)?${bindings(source, name)}`;
  const fail: (reason: string) => never = (reason) => {
    throw new Error(`forbidden ${reason}: ${name}`);
  };
  const schemaNamespaces = new Set(["schema"]);
  const nonSensitiveImports = new Set<string>();
  for (const match of source.matchAll(
    /\b(import|export)\s+(?:[\w$]+\s*,\s*)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]+\})\s+from\s+("(?:[^"\\]|\\.)*"|'[^']*')/g,
  )) {
    const members = match[2] ?? "";
    const schemaModule = schemaSpecifiers.has(literal(match[3]) ?? "");
    const namespace = /^\*\s+as\s+([\w$]+)$/.exec(members)?.[1];
    if (schemaModule && namespace) schemaNamespaces.add(namespace);
    if (members.startsWith("{")) {
      for (const member of members.slice(1, -1).split(",")) {
        const binding = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?/.exec(member);
        const imported = binding?.[1];
        if (!imported) continue;
        if (name === "db/client.ts" && (schemaModule || schemaTables.has(imported))) fail("reviewer table binding");
        if (schemaModule && match[1] === "import" && !sensitiveTables.includes(imported))
          nonSensitiveImports.add(binding[2] ?? imported);
      }
    }
    if (members.startsWith("*") && schemaModule && (name !== "db/client.ts" || !tableBindings.has(name)))
      fail("schema namespace binding");
    if (reviewerTables.some((key) => !mayBindTable(name, key) && new RegExp(`(?:^\\{|,)\\s*${key}\\b`).test(members)))
      fail("reviewer table binding");
  }
  for (const match of source.matchAll(/\b(?:import|require)\(\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\)/g)) {
    if (!schemaSpecifiers.has(literal(match[1]) ?? "")) continue;
    if (name !== "db/client.ts") fail("schema namespace binding");
    const binding = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*\(*\s*(?:await\s+)?$/.exec(source.slice(0, match.index));
    if (binding?.[1]) schemaNamespaces.add(binding[1]);
    if (/^\s*\)*\s*(?:\?\.|\.|\[)/.test(source.slice(match.index + match[0].length))) fail("reviewer table binding");
    if (/\b(?:const|let|var)\s*\{[^}]+\}\s*=\s*(?:await\s+)?$/.test(source.slice(0, match.index)))
      fail("reviewer table binding");
  }
  for (const match of source.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=/g))
    if (
      reviewerTables.some((key) => !mayBindTable(name, key) && new RegExp(`(?:^|,)\\s*${key}\\b`).test(match[1] ?? ""))
    )
      fail("reviewer table binding");
  if (name === "db/client.ts") {
    for (const namespace of schemaNamespaces) {
      const binding = bindings(source, namespace);
      if (
        new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]+\\}\\s*=\\s*${binding}\\b`).test(source) ||
        new RegExp(`(?<![\\w$./])${binding}\\s*(?:\\?\\.|\\.|\\[)`).test(source)
      )
        fail("reviewer table binding");
    }
  }
  const sensitiveTable = `(?:${reviewerTables
    .filter((target) => !mayBindTable(name, target))
    .map(table)
    .join("|")})`;
  if (new RegExp(`\\b(?:const|let|var)\\s+[\\w$]+\\s*=\\s*${sensitiveTable}\\s*[;,]`).test(source))
    fail("reviewer table binding");
  // Original comments and quoting can blind a text scan. SQL uses only esbuild's
  // comment-free output; the original pass below still checks literal call values.
  if (normalized) assertAgentSql(source, name, schemaSpecifiers, fail);
  const chainedSetters = new Set<number>();
  const checkColumns = (target: string, value: string | undefined) => {
    const allowed = tableBindings.get(name)?.updates[target];
    // Send delivery updates constrain keys; their values need not be literals.
    const fields = namedProperties(value, normalized || target === "sends");
    if (!allowed?.length || !fields || [...fields.keys()].some((key) => !allowed.includes(key)))
      fail("reviewer update columns");
  };
  for (const match of source.matchAll(/\.(?:insert|update)\s*\(/g)) {
    const args = delimited(source, match.index + match[0].length - 1);
    const target = args.parts[0] ?? "";
    const safe = args.parts.length === 1 && nonSensitiveImports.has(target);
    const reviewer = reviewerTables.find((key) => new RegExp(`^${table(key)}$`).test(target));
    // Only a named non-sensitive schema import proves that a chained setter may
    // skip the value rules. Unknown targets fall through to the all-setter scan.
    if (safe) {
      let end = args.end;
      for (;;) {
        const next = /^\s*\.([\w$]+)\s*\(/.exec(source.slice(end));
        if (!next) break;
        if (next[1] === "values" || next[1] === "set") chainedSetters.add(end + next[0].indexOf("."));
        end = delimited(source, end + next[0].length - 1).end;
      }
    }
    const declaration = /\b(const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?[\w$.]+\s*$/.exec(
      source.slice(0, match.index),
    );
    const retained = declaration?.[2];
    if (!retained || (!safe && !reviewer)) continue;
    // An immutable retained builder proves its original table. Mutable builders
    // and their aliases still get all value rules after possible reassignment.
    if (safe && declaration?.[1] !== "const") continue;
    const receiver = safe ? retained.replaceAll("$", "\\$") : bindings(source, retained);
    for (const use of source.matchAll(new RegExp(`\\b${receiver}(?=\\s*\\.)`, "g"))) {
      let end = use.index + use[0].length;
      for (;;) {
        const next = /^\s*\.([\w$]+)\s*\(/.exec(source.slice(end));
        if (!next) break;
        const values = delimited(source, end + next[0].length - 1);
        if (next[1] === "values" || next[1] === "set") {
          if (safe) chainedSetters.add(end + next[0].indexOf("."));
          // Preserve the split-chain reason for an uninspectable first patch.
          else if (values.parts[0]?.startsWith("{") || /^\s*\.set\s*\(/.test(source.slice(args.end)))
            checkColumns(reviewer ?? "", values.parts[0]);
        }
        end = values.end;
      }
    }
  }
  const tokenHelpers = ["createToken", "insertToken", "rotateLocalToken"];
  const forwardingBodies: { helper: string; start: number; end: number }[] = [];
  if (name === "server/auth/tokens.ts") {
    for (const match of source.matchAll(new RegExp(`\\bfunction\\s+(${tokenHelpers.join("|")})\\s*\\(`, "g"))) {
      const args = delimited(source, match.index + match[0].length - 1);
      if (!/^kind(?:\s*:|$)/.test(args.parts[2] ?? "")) continue;
      const body = /^\s*\{/.exec(source.slice(args.end));
      if (body) {
        const start = args.end + body[0].length - 1;
        forwardingBodies.push({ helper: match[1] ?? "", start, end: delimited(source, start).end });
      }
    }
  }
  const forwardsKind = (index: number, helper?: string) =>
    forwardingBodies.some((body) => index > body.start && index < body.end && (!helper || body.helper === helper));
  for (const target of sensitiveTables) {
    for (const match of source.matchAll(
      new RegExp(`\\.(insert|update|delete)\\s*\\(\\s*${table(target)}\\s*\\)`, "g"),
    )) {
      const method = match[1];
      if (reviewerTables.includes(target) && method !== "update") fail("reviewer insert or delete");
      if (method === "delete") continue;
      const setter = method === "insert" ? "values" : "set";
      const start = match.index + match[0].length;
      const chain = new RegExp(`^\\s*\\.${setter}\\s*\\(`).exec(source.slice(start));
      if (!chain) fail("split sensitive chain");
      const call = delimited(source, start + chain[0].length - 1);
      chainedSetters.add(start + chain[0].indexOf("."));
      if (call.parts.length !== 1) fail("sensitive write arguments");
      const checkValue = (value: string | undefined) => {
        if (reviewerTables.includes(target)) {
          checkColumns(target, value);
        }
        const rule = valueRules.find((rule) => rule.table === target);
        if (!rule) return;
        // The shared insertToken implementation forwards its kind parameter;
        // every external helper call must prove a literal local kind below.
        // This inherited exception covers only that insert, never other writes.
        if (target === "tokens" && method === "insert" && name === "server/auth/tokens.ts") {
          if (forwardsKind(match.index, "insertToken") && namedProperties(value, true)?.get("kind") === "kind") return;
        }
        if (!safeProperty(value, rule.key, rule.allowed, method === "insert" && target !== "reviews"))
          fail(`${target} ${rule.key} write`);
      };
      checkValue(call.parts[0]);
      let end = call.end;
      for (;;) {
        const next = /^\s*\.([\w$]+)\s*\(/.exec(source.slice(end));
        if (!next) break;
        const args = delimited(source, end + next[0].length - 1);
        if (next[1] === "values" || next[1] === "set") {
          if (args.parts.length !== 1) fail("sensitive write arguments");
          checkValue(args.parts[0]);
          chainedSetters.add(end + next[0].indexOf("."));
        }
        end = args.end;
      }
    }
  }
  // A later setter on a retained builder has lost its immediate table context.
  // Require an explicit object and prove all three value fields there. Zero-arg
  // collection iterators, Object.values and two-arg Map/byte setters are not writes.
  for (const match of source.matchAll(/\.(values|set)\s*\(/g)) {
    if (chainedSetters.has(match.index) || /\bObject$/.test(source.slice(0, match.index))) continue;
    const args = delimited(source, match.index + match[0].length - 1);
    if (args.parts.length !== 1) continue;
    const value = args.parts[0];
    // Queries.values(sql`...`) returns positional SQL rows; SQL scanning covers it.
    if (match[1] === "values" && new RegExp(`^${bindings(source, "sql")}\\s*\u0060`).test(value ?? "")) continue;
    if (!namedProperties(value, true)) fail("unresolved write value");
    for (const rule of valueRules)
      if (!safeProperty(value, rule.key, rule.allowed, false)) fail(`${rule.table} ${rule.key} write`);
  }
  // A conflict arm may live on a retained/reassigned/dynamic builder. Inspect
  // every call in the module without depending on its original insert chain.
  for (const match of source.matchAll(/\bonConflictDo(Update|Nothing)\s*\(/g)) {
    const args = delimited(source, match.index + match[0].length - 1);
    if (match[1] === "Nothing" && !args.parts.length) continue;
    const conflict = namedProperties(args.parts[0], normalized);
    if (match[1] === "Nothing") {
      if (
        args.parts.length !== 1 ||
        !conflict ||
        [...conflict.keys()].some((key) => !["target", "where"].includes(key))
      )
        fail("conflict do-nothing shape");
      continue;
    }
    const patch = conflict?.get("set");
    if (args.parts.length !== 1 || !conflict || !namedProperties(patch, true)) fail("conflict update shape");
    for (const rule of valueRules)
      if (!safeProperty(patch, rule.key, rule.allowed, false)) fail(`${rule.table} conflict ${rule.key} write`);
  }
  if (new RegExp(`\\b(?:${bindings(source, "createPairing")}|${bindings(source, "redeemPairing")})\\(`).test(source))
    fail("pairing mutation");
  {
    const helpers = tokenHelpers.map((helper) => bindings(source, helper)).join("|");
    for (const match of source.matchAll(new RegExp(`\\b(?:${helpers})\\s*\\(`, "g"))) {
      if (/\bfunction\s*$/.test(source.slice(0, match.index))) continue;
      const value = delimited(source, match.index + match[0].length - 1).parts[2];
      if (value === "kind" && forwardsKind(match.index)) continue;
      const kind = literal(value);
      if (kind !== "admin" && kind !== "agent") fail("token kind");
    }
  }
  if (/\bcreateRequire\b|\beval\s*\(|\bnew Function\b/.test(source)) fail("code loader");
  if (/\b(?:from\s*|import\s*(?:\(\s*)?|require\(\s*)"(?:node:)?vm"/.test(source)) fail("vm import");
  if (
    /\b(?:from\s*|import\s*(?:\(\s*)?|require\(\s*)"(?:node:)?worker_threads"/.test(source) &&
    !workerSpawners.has(name) &&
    !workerReceivers.has(name)
  )
    fail("worker import");
  if (
    !workerSpawners.has(name) &&
    new RegExp(`\\bnew\\s+(?:[\\w$]+\\.)?${bindings(source, "Worker")}\\s*\\(`).test(source)
  )
    fail("worker construction");
  if (new RegExp(`\\b[\\w$]+\\s*=\\s*(?:[\\w$]+\\.)?${bindings(source, "Worker")}\\b`).test(source))
    fail("worker constructor alias");
  return source;
}

async function assertAgentGraph(root: string, entries: string[]) {
  // The client cannot name any schema table, even through an ordinary barrel.
  // Read only declarations; fixtures may intentionally have no schema module.
  const schemaSource = await readFile(join(root, "db/schema.ts"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const schemaTables = new Set([
    ...sensitiveTables,
    ...[...schemaSource.matchAll(/\bexport\s+const\s+([\w$]+)/g)].map((match) => match[1] ?? ""),
  ]);
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry || seen.has(entry)) continue;
    const result = await build({ ...parseOptions, absWorkingDir: root, entryPoints: [entry] });
    if (result.warnings.length) throw new Error(`unresolved module: ${result.warnings.map((w) => w.text).join("; ")}`);
    const parsed = new Map(
      await Promise.all(
        Object.keys(result.metafile.inputs).map(async (input) => {
          const path = resolve(root, input);
          return [path, await parsedSource(path)] as const;
        }),
      ),
    );
    // Named re-exports can rename a schema table at each barrel. Propagate those
    // names before checking client imports, independently of traversal order.
    let previousSize = 0;
    while (previousSize !== schemaTables.size) {
      previousSize = schemaTables.size;
      for (const source of parsed.values())
        for (const match of source.matchAll(/\bexport\s*\{([^}]+)\}\s*from\b/g))
          for (const member of (match[1] ?? "").split(",")) {
            const alias = /^\s*([\w$]+)\s+as\s+([\w$]+)/.exec(member);
            if (alias?.[1] && alias[2] && schemaTables.has(alias[1])) schemaTables.add(alias[2]);
          }
    }
    for (const [input, metadata] of Object.entries(result.metafile.inputs)) {
      const path = resolve(root, input);
      if (seen.has(path)) continue;
      seen.add(path);
      const name = relative(root, path);
      if (forbidden.has(name)) throw new Error(`forbidden module: ${name}`);
      const schemaSpecifiers = new Set(
        metadata.imports
          .filter((edge) => !edge.external && relative(root, resolve(root, edge.path)) === "db/schema.ts")
          .flatMap((edge) => (edge.original ? [edge.original] : [])),
      );
      const source = assertAgentCalls(parsed.get(path) ?? "", name, schemaSpecifiers, true, schemaTables);
      // Transform folds string concatenation even without minification. Check
      // original call expressions too, so a folded expression is never a literal.
      assertAgentCalls(await readFile(path, "utf8"), name, schemaSpecifiers, false, schemaTables);
      // A computed glob can be bundled by esbuild but still violates this boundary.
      for (const call of source.matchAll(/\b(?:import|require)\(([^\n]*)/g))
        if (!/^"(?:[^"\\]|\\.)*"\s*\)/.test(call[1] ?? "")) throw new Error(`unresolved import: ${name}`);
      for (const call of source.matchAll(
        new RegExp(`new (?:[\\w$]+\\.)?${bindings(source, "Worker")}\\(([\\s\\S]*?)(?=,\\s*\\{|\\);)`, "g"),
      )) {
        const target = call[1]?.trim() ?? "";
        const literal = /^new URL\(("(?:[^"\\]|\\.)*"), import\.meta\.url\)$/.exec(target);
        if (literal?.[1]) {
          pending.push(fileURLToPath(new URL(JSON.parse(literal[1]), pathToFileURL(path))));
        } else if (
          name === "server/publish/executor.ts" &&
          target ===
            'new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./publish-worker.mjs", import.meta.url)'
        ) {
          pending.push(resolve(dirname(path), "worker.ts"));
        } else if (name === "db/client.ts" && target === "transactionWorkerSource") {
          const inline = /const transactionWorkerSource = `([^`]*?)`;/s.exec(source)?.[1];
          if (!inline || inline.includes("${")) throw new Error(`unresolved worker: ${name}`);
          assertAgentCalls((await transform(inline)).code, `${name} inline worker`, new Set(), true);
          assertAgentCalls(inline, `${name} inline worker`);
          const worker = await build({ ...parseOptions, stdin: { contents: inline, resolveDir: dirname(path) } });
          if (worker.warnings.length || Object.keys(worker.metafile.inputs).some((input) => input !== "<stdin>"))
            throw new Error(`unresolved inline worker: ${name}`);
        } else if (/^"[^"\\]+"$/.test(target)) {
          const value: string = JSON.parse(target);
          pending.push(value.startsWith("file:") ? fileURLToPath(value) : resolve(dirname(path), value));
        } else throw new Error(`unresolved worker: ${name}`);
      }
    }
  }
  return seen;
}

test("all agent entry graphs exclude reviewer mutations, including workers", async () => {
  const seen = await assertAgentGraph(root, [
    ...(await sources(join(root, "cli/direct"))),
    ...["publish", "wait", "feedback", "reply", "mcp"].map((name) => join(root, `cli/commands/${name}.ts`)),
    join(root, "mcp/server.ts"),
  ]);
  for (const name of ["server/mailbox/take.ts", "server/publish/ingest.ts", "server/publish/worker.ts"])
    expect(seen.has(join(root, name)), name).toBe(true);
});

async function fixture(modules: Record<string, string>) {
  const folder = await mkdtemp(join(tmpdir(), "emend-graph-test-"));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(modules)) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), source);
  }
  return folder;
}

test.each([
  ["dynamic import", 'export const load = () => import("./server/routes/sends.ts");'],
  ["re-export", 'export { forbidden as harmless } from "./server/routes/sends.ts";'],
  ["aliased import", 'import { forbidden as harmless } from "./server/routes/sends.ts"; harmless();'],
])("graph rejects a forbidden module through %s", async (_name, entry) => {
  const folder = await fixture({ "entry.ts": entry, "server/routes/sends.ts": "export function forbidden() {}" });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
    "forbidden module: server/routes/sends.ts",
  );
});

test("an allowlisted spawner still follows file URL workers to forbidden modules", async () => {
  const folder = await fixture({
    "db/client.ts":
      'import { Worker } from "node:worker_threads"; new Worker(new URL("../server/routes/sends.ts", import.meta.url));',
    "server/routes/sends.ts": "export const value = 42;",
  });
  await expect(assertAgentGraph(folder, [join(folder, "db/client.ts")])).rejects.toThrow(
    "forbidden module: server/routes/sends.ts",
  );
});

test("an allowlisted spawner still refuses a computed worker target", async () => {
  const folder = await fixture({
    "db/client.ts": 'import { Worker } from "node:worker_threads"; export const load = (url) => new Worker(url);',
  });
  await expect(assertAgentGraph(folder, [join(folder, "db/client.ts")])).rejects.toThrow("unresolved worker");
});

test.each([
  ["export const load = (path) => import(path);", /unresolved (?:module|import)/],
  ["export const load = (path) => require(path);", /unresolved (?:module|import)/],
  [
    'import { Worker } from "node:worker_threads"; export const load = (path) => new Worker(path);',
    "forbidden worker import",
  ],
  ["export const act = (q) => q.insert(sends).values({});", "forbidden reviewer insert or delete"],
  ['export const act = (q) => q.insert(comments).values({ author: "user" });', "forbidden comments author write"],
  ['export const act = (q) => q.update(reviews).set({ state: "approved" });', "forbidden reviews state write"],
  ['export const act = (q) => q.insert(reviews).values({ state: "approved" });', "forbidden reviews state write"],
  ['export const act = (q) => q.insert(tokens).values({ kind: "reviewer" });', "forbidden tokens kind write"],
  ["export const act = (q) => q.exec(`update pairings set used_at = 1`);", "forbidden reviewer SQL binding"],
  ["export const act = (q) => createPairing(q);", "forbidden pairing mutation"],
  ["export const act = (q) => redeemPairing(q);", "forbidden pairing mutation"],
  ['export const act = (q) => createToken(q, "owner", "reviewer");', "forbidden token kind"],
  ['export const act = (q) => insertToken(q, "owner", "reviewer", {});', "forbidden token kind"],
  ["export const act = (q) => q.insert(pairings).values({});", "forbidden reviewer insert or delete"],
  ["export const act = (q) => q.update(pairings).set({ usedAt: 1 });", "forbidden reviewer update columns"],
] as const)("graph rejects an unsafe call inside an allowed module: %s", async (source, reason) => {
  const folder = await fixture({ "entry.ts": 'export * from "./allowed.ts";', "allowed.ts": source });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(reason);
});

test("source discovery includes a directory named test and excludes test basenames only", async () => {
  const folder = await fixture({ "test/entry.ts": "", "entry.test.ts": "", "test-support.ts": "" });
  expect((await sources(folder)).map((path) => relative(folder, path)).sort()).toEqual([
    "test-support.ts",
    "test/entry.ts",
  ]);
});

test("ensureServer scan refuses an aliased import in any directory", async () => {
  const folder = await fixture({
    "cli/commands/open.ts": "ensureServer();",
    "test/agent.ts": 'import { ensureServer as start } from "../server-client.ts"; start();',
    "server-client.ts": "export function ensureServer() {}",
  });
  await expect(assertOnlyOpen(folder)).rejects.toThrow("test/agent.ts");
});

test("an imported alias cannot rewrite the reviewer token literal out of a call check", async () => {
  const folder = await fixture({
    "server/mailbox/take.ts":
      'import { sends as reviewer } from "../../tables.ts"; export const act = (q) => { use(reviewer); return createToken(q, "owner", "reviewer"); };',
    "tables.ts": "export const sends = {};",
  });
  await expect(assertAgentGraph(folder, [join(folder, "server/mailbox/take.ts")])).rejects.toThrow(
    "forbidden token kind: server/mailbox/take.ts",
  );
});

test("the walker accepts safe modules and follows literal dynamic and worker entries", async () => {
  const folder = await fixture({
    "db/client.ts":
      'import { Worker as Thread } from "node:worker_threads"; export const load = () => import("../allowed.ts"); new Thread(new URL("../worker.ts", import.meta.url));',
    "allowed.ts": 'export { value as answer } from "./value.ts";',
    "value.ts": "export const value = 42;",
    "worker.ts": "export const value = 42;",
  });
  expect(
    [...(await assertAgentGraph(folder, [join(folder, "db/client.ts")]))].map((path) => relative(folder, path)).sort(),
  ).toEqual(["allowed.ts", "db/client.ts", "value.ts", "worker.ts"]);
});

test.each(["createToken", "insertToken", "rotateLocalToken"])(
  "graph requires literal local token kinds for %s, including imported aliases",
  async (helper) => {
    for (const kind of ['"reviewer"', '"machine"', "kind", '"ag" + "ent"', 'choose("agent")']) {
      const folder = await fixture({
        "entry.ts": 'export * from "./allowed.ts";',
        "allowed.ts": `import { ${helper} as issue } from "./helpers.ts"; const kind = "agent"; export const act = (q) => issue(q, owner(), ${kind}, {});`,
        "helpers.ts": `export function ${helper}() {}`,
      });
      await expect(assertAgentGraph(folder, [join(folder, "entry.ts")]), `${helper}: ${kind}`).rejects.toThrow(
        "forbidden token kind: allowed.ts",
      );
    }
  },
);

test.each([
  "{ state: nextState }",
  "{ state }",
  "{ ...patch }",
  "patch",
  '{ state: "open", ...patch }',
  '{ ...patch, state: "open" }',
  '{ state: "open", state: nextState }',
  '{ [key]: "approved" }',
])("graph rejects an unproven review state update: %s", async (value) => {
  const folder = await fixture({ "entry.ts": `export const act = (q) => q.update(reviews).set(${value});` });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
    value.includes('state: "open", state:')
      ? 'unresolved module: Duplicate key "state" in object literal'
      : "forbidden reviews state write: entry.ts",
  );
});

test.each(["sends", "pairings", "devices"])("graph rejects an unlisted binding of reviewer table %s", async (table) => {
  for (const source of [
    `import { ${table} } from "./db/schema.ts"; export const table = ${table};`,
    `import { ${table} as t } from "./db/schema.ts"; export const table = t;`,
    'import * as schema from "./db/schema.ts"; export const table = schema;',
    `const { ${table}: t } = schema; export const table = t;`,
  ]) {
    const folder = await fixture({ "entry.ts": source, "db/schema.ts": `export const ${table} = {};` });
    await expect(assertAgentGraph(folder, [join(folder, "entry.ts")]), source).rejects.toThrow(
      source.startsWith("import *")
        ? "forbidden schema namespace binding: entry.ts"
        : "forbidden reviewer table binding: entry.ts",
    );
  }
});

test.each(["sends", "pairings", "devices"])("graph rejects raw SQL inserts into reviewer table %s", async (table) => {
  for (const spelling of [
    table,
    `"${table}"`,
    `'${table}'`,
    `\u0060${table}\u0060`,
    `[${table}]`,
    `\u0024{${table}}`,
  ]) {
    const query = `INSERT INTO ${spelling} (id) VALUES (1)`;
    const literal = spelling.startsWith("${") ? `\u0060${query}\u0060` : JSON.stringify(query);
    const folder = await fixture({ "entry.ts": `export const act = (q) => q.run(${literal});` });
    await expect(assertAgentGraph(folder, [join(folder, "entry.ts")]), query).rejects.toThrow(
      "forbidden reviewer SQL binding: entry.ts",
    );
  }
});

test.each(["sends", "pairings", "devices"])(
  "an allowlisted module still cannot insert into %s through an alias",
  async (table) => {
    const entry = table === "devices" ? "server/auth/tokens.ts" : "server/mailbox/take.ts";
    for (const binding of [
      `import { ${table} as rows } from "../../db/schema.ts";`,
      `import { ${table} } from "../../db/schema.ts"; const rows = ${table};`,
      `import { ${table} } from "../../db/schema.ts"; const first = ${table}; const rows = first;`,
      `const { ${table}: rows } = schema;`,
    ]) {
      const folder = await fixture({
        [entry]: `${binding} export const act = (q) => q.insert(rows).values({});`,
        "db/schema.ts": `export const ${table} = {};`,
      });
      await expect(assertAgentGraph(folder, [join(folder, entry)])).rejects.toThrow(
        `forbidden reviewer ${table === "pairings" ? "table binding" : "insert or delete"}: ${entry}`,
      );
    }
  },
);

test("an allowlisted module still cannot insert through an interpolated table alias", async () => {
  const folder = await fixture({
    "server/mailbox/take.ts": `import { sends as rows } from "../../db/schema.ts"; export const act = (q) => q.run(sql\`INSERT INTO \${rows} (id) VALUES (1)\`);`,
    "db/schema.ts": "export const sends = {};",
  });
  await expect(assertAgentGraph(folder, [join(folder, "server/mailbox/take.ts")])).rejects.toThrow(
    "forbidden reviewer table SQL",
  );
});

test("allowlisted modules may read reviewer tables and claim Sends", async () => {
  const folder = await fixture({
    "server/mailbox/take.ts":
      'import { sends as rows } from "../../db/schema.ts"; export const act = (q) => q.update(rows).set({ deliveryId: id }).where(condition);',
    "server/mailbox/payload.ts": `const { sends: rows } = schema; export const act = (q) => q.run(sql\`SELECT * FROM \${rows}\`);`,
    "server/auth/tokens.ts":
      'import { devices } from "../../db/schema.ts"; export const act = (q) => q.select().from(devices);',
    "db/client.ts": 'import * as schema from "./schema.ts"; export const tables = schema;',
    "db/schema.ts": "export const sends = {}; export const devices = {};",
    "db/migrations.gen.ts": 'export const ddl = "CREATE TABLE sends (id text);";',
  });
  await expect(
    assertAgentGraph(folder, [
      join(folder, "server/mailbox/take.ts"),
      join(folder, "server/mailbox/payload.ts"),
      join(folder, "server/auth/tokens.ts"),
      join(folder, "db/client.ts"),
      join(folder, "db/migrations.gen.ts"),
    ]),
  ).resolves.toBeInstanceOf(Set);
});

test("a table binding allowance does not permit a schema namespace outside db/client.ts", async () => {
  const folder = await fixture({
    "server/mailbox/take.ts": 'import * as schema from "../../db/schema.ts"; export const tables = schema;',
    "db/schema.ts": "export const sends = {};",
  });
  await expect(assertAgentGraph(folder, [join(folder, "server/mailbox/take.ts")])).rejects.toThrow(
    "forbidden schema namespace binding",
  );
});

test.each(["file", "inline"])("a %s worker receiver may use parentPort but cannot construct Worker", async (kind) => {
  for (const construct of [false, true]) {
    const source = `const { parentPort } = require("node:worker_threads"); parentPort.postMessage(42); ${construct ? 'new Worker(new URL("./other.ts", import.meta.url));' : ""}`;
    const entry = kind === "file" ? "server/publish/worker.ts" : "db/client.ts";
    const folder = await fixture({
      [entry]:
        kind === "file"
          ? source
          : `import { Worker } from "node:worker_threads"; const transactionWorkerSource = \u0060${source}\u0060; new Worker(transactionWorkerSource, { eval: true });`,
    });
    const walk = assertAgentGraph(folder, [join(folder, entry)]);
    if (construct) await expect(walk).rejects.toThrow("forbidden worker construction");
    else await expect(walk).resolves.toBeInstanceOf(Set);
  }
});

test.each([
  "{ author: kind }",
  "{ author }",
  "{ ...row }",
  "row",
  '{ author: "agent", ...row }',
  '{ ...row, author: "agent" }',
  '{ author: "agent", author: kind }',
  '{ author: "agent", [key]: value }',
])("graph rejects an unproven comment author: %s", async (value) => {
  const folder = await fixture({ "entry.ts": `export const act = (q) => q.insert(comments).values(${value});` });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
    value.includes('author: "agent", author:')
      ? 'unresolved module: Duplicate key "author" in object literal'
      : "forbidden comments author write: entry.ts",
  );
});

test.each([
  'import { createRequire as load } from "node:module"; export const req = load(import.meta.url);',
  'export const load = () => eval("42");',
  'export const load = new Function("return 42");',
  'import vm from "vm"; export const load = vm;',
  'export const load = require("node:vm");',
  'import { Worker } from "worker_threads"; export const load = Worker;',
  'import { Worker as W } from "node:worker_threads"; export const load = W;',
  'const { Worker: W } = require("node:worker_threads"); export const load = W;',
  'export const load = import("node:worker_threads");',
])("graph rejects code loading: %s", async (source) => {
  const folder = await fixture({ "entry.ts": source });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
    source.includes("worker_threads")
      ? "forbidden worker import: entry.ts"
      : source.includes("vm")
        ? "forbidden vm import: entry.ts"
        : source.includes("eval(")
          ? "unresolved module: Using direct eval with a bundler"
          : "forbidden code loader: entry.ts",
  );
});

test("an allowlisted worker spawner cannot assign Worker to another constructor", async () => {
  const folder = await fixture({
    "db/client.ts": 'import { Worker } from "node:worker_threads"; const W = Worker; new W(url);',
  });
  await expect(assertAgentGraph(folder, [join(folder, "db/client.ts")])).rejects.toThrow(
    "forbidden worker constructor alias: db/client.ts",
  );
});

test.each(["cli.ts", "main.ts"])("dispatcher %s is subject to the same call checks", async (name) => {
  assertAgentCalls(await parsedSource(join(root, name)), name, new Set(), true);
  assertAgentCalls(await readFile(join(root, name), "utf8"), name);
  const folder = await fixture({ [name]: 'const kind = "reviewer"; createToken(q, owner, kind);' });
  await expect(assertAgentGraph(folder, [join(folder, name)])).rejects.toThrow(`forbidden token kind: ${name}`);
});

test("literal local token kinds, open states and agent authors accept nested expressions", async () => {
  const folder = await fixture({
    "entry.ts": `
      import { createToken as issue, insertToken, rotateLocalToken } from "./helpers.ts";
      export async function act(q) {
        await issue(q, owner("synthetic", { nested: true }), "admin", { name: "reviewer" });
        await insertToken(q, "owner", "agent", {});
        await rotateLocalToken(q, "owner", "agent", instance(), now());
        await q.update(reviews).set({ title: title("a,b"), state: "open" });
        await q.update(reviews).set({ title: "Synthetic" });
        await q.insert(comments).values({ body: body({ a: 1, b: 2 }), author: "agent" });
      }
    `,
    "helpers.ts":
      "export function createToken() {} export function insertToken() {} export function rotateLocalToken() {}",
  });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).resolves.toBeInstanceOf(Set);
});

const sqliteWrites = [
  "INSERT",
  ...["ROLLBACK", "ABORT", "REPLACE", "FAIL", "IGNORE"].map((mode) => `INSERT OR ${mode}`),
  "REPLACE",
  "UPDATE",
  ...["ROLLBACK", "ABORT", "REPLACE", "FAIL", "IGNORE"].map((mode) => `UPDATE OR ${mode}`),
  "DELETE",
];
const sqlNames = (table: string) => [
  table,
  `"${table}"`,
  `'${table}'`,
  `[${table}]`,
  `\u0060${table}\u0060`,
  `\u0024{${table}}`,
];
const sqlModule = (query: string) =>
  `export const act = (q) => q.run(${query.includes("${") ? `\u0060${query}\u0060` : JSON.stringify(query)});`;

test.each(["sends", "pairings", "devices", "comments"].flatMap((table) => sqliteWrites.map((verb) => [table, verb])))(
  "raw SQL cannot write %s with %s, including in an allowlisted module",
  async (table, verb) => {
    const entry = table === "devices" ? "server/auth/tokens.ts" : "server/mailbox/take.ts";
    for (const name of sqlNames(table)) {
      const query = verb.startsWith("UPDATE")
        ? `${verb} ${name} SET kind = 'reviewer'`
        : verb === "DELETE"
          ? `DELETE FROM ${name}`
          : `${verb} INTO ${name} (author) VALUES ('agent')`;
      const folder = await fixture({ [entry]: sqlModule(query) });
      await expect(assertAgentGraph(folder, [join(folder, entry)]), query).rejects.toThrow(
        `forbidden reviewer ${table === "pairings" ? "SQL binding" : "table SQL"}: ${entry}`,
      );
    }
  },
);

test.each(["sends", "pairings", "devices"])("raw SQL reads bind %s even without an import", async (table) => {
  for (const name of sqlNames(table)) {
    const folder = await fixture({ "entry.ts": sqlModule(`SELECT * FROM ${name}`) });
    await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
      "forbidden reviewer SQL binding: entry.ts",
    );
  }
});

test.each(
  ["comments", "tokens", "reviews", "sends", "pairings", "devices"].flatMap((table) =>
    ["insert", "update"].map((method) => [table, method]),
  ),
)("sensitive %s %s builders must apply values immediately", async (table, method) => {
  const setter = method === "insert" ? "values" : "set";
  for (const source of [
    `export const act = (q) => { const b = q.${method}(${table}); return b.${setter}(patch); };`,
    `export const act = (q) => q.${method}(${table}).select(otherQuery);`,
  ]) {
    const folder = await fixture({ "server/auth/tokens.ts": source });
    await expect(assertAgentGraph(folder, [join(folder, "server/auth/tokens.ts")])).rejects.toThrow(
      reviewerTables.includes(table) && method === "insert"
        ? "forbidden reviewer insert or delete: server/auth/tokens.ts"
        : "forbidden split sensitive chain: server/auth/tokens.ts",
    );
  }
});

test.each([
  '{ kind: "approve" }',
  '{ deliveryId: null, instruction: "go" }',
  "{ [key]: null }",
  "{ ...patch }",
  "patch",
])("Send updates must name only allowed delivery columns: %s", async (value) => {
  const folder = await fixture({
    "server/mailbox/take.ts": `export const act = (q) => q.update(sends).set(${value});`,
  });
  await expect(assertAgentGraph(folder, [join(folder, "server/mailbox/take.ts")])).rejects.toThrow(
    "forbidden reviewer update columns: server/mailbox/take.ts",
  );
});

test("Send updates accept an allowed-key shorthand", async () => {
  const folder = await fixture({
    "server/mailbox/take.ts": "export const act = (q, deliveryId) => q.update(sends).set({ deliveryId });",
  });
  await expect(assertAgentGraph(folder, [join(folder, "server/mailbox/take.ts")])).resolves.toBeInstanceOf(Set);
});

test("Send updates reject a disallowed-key shorthand", async () => {
  const folder = await fixture({
    "server/mailbox/take.ts": "export const act = (q, instruction) => q.update(sends).set({ instruction });",
  });
  await expect(assertAgentGraph(folder, [join(folder, "server/mailbox/take.ts")])).rejects.toThrow(
    "forbidden reviewer update columns",
  );
});

test.each([
  ["server/mailbox/take.ts", "q.delete(sends)"],
  ["server/mailbox/payload.ts", "q.update(sends).set({ deliveryId: null })"],
  ["server/auth/tokens.ts", "q.update(devices).set({ lastSeenAt: now })"],
  ["server/auth/tokens.ts", "q.delete(devices)"],
  ["server/mailbox/take.ts", "q.delete(pairings)"],
])("binding allowance in %s does not permit %s", async (entry, call) => {
  const folder = await fixture({ [entry]: `export const act = (q) => ${call};` });
  await expect(assertAgentGraph(folder, [join(folder, entry)])).rejects.toThrow(
    `forbidden ${call.includes(".delete(") ? "reviewer insert or delete" : "reviewer update columns"}: ${entry}`,
  );
});

test.each([
  `UPDATE sends SET \${column} = NULL`,
  "UPDATE sends SET delivery_id = NULL, instruction = 'go'",
  "UPDATE sends SET (delivery_id, instruction) = (NULL, 'go')",
])("raw Send updates reject unknown or additional keys: %s", async (query) => {
  const folder = await fixture({ "server/mailbox/take.ts": sqlModule(query) });
  await expect(assertAgentGraph(folder, [join(folder, "server/mailbox/take.ts")])).rejects.toThrow(
    "forbidden reviewer table SQL: server/mailbox/take.ts",
  );
});

test.each([
  "q.insert(reviews).values({ state: nextState })",
  "q.insert(reviews).values({ state })",
  "q.insert(reviews).values({ ...row })",
  "q.insert(reviews).values(row)",
  'q.insert(reviews).values({ state: "open" }).onConflictDoUpdate({ set: { state: nextState } })',
  'q.insert(reviews).values({ state: "open" }).onConflictDoUpdate({ set: patch })',
  'q.insert(reviews).values({ state: "open" }).onConflictDoUpdate({ set: { ...patch } })',
  'q.insert(reviews).values({ state: "open" }).onConflictDoUpdate({ ...patch })',
  'q.insert(reviews).values({ state: "open" }).onConflictDoUpdate(patch)',
])("every review write must prove its state safe: %s", async (call) => {
  const folder = await fixture({ "entry.ts": `export const act = (q) => ${call};` });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
    call.includes("onConflictDoUpdate")
      ? call.includes("nextState")
        ? "forbidden reviews conflict state write: entry.ts"
        : "forbidden conflict update shape: entry.ts"
      : "forbidden reviews state write: entry.ts",
  );
});

test("a lone update outside the CLI entry modules is refused", async () => {
  const folder = await fixture({ "entry.ts": 'export const command = "update";' });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow("forbidden");
});

test.each([
  "update reviews set state = 'approved'",
  `UPDATE reviews SET state = \${nextState}`,
  "UPDATE OR REPLACE reviews SET state = next_state",
  `INSERT INTO reviews (state) VALUES (\${nextState})`,
  `INSERT INTO reviews (state) VALUES ('open'), (\${nextState})`,
  `REPLACE INTO reviews (state) VALUES (\${nextState})`,
  "INSERT INTO reviews (state, state) VALUES ('open', 'approved')",
  "INSERT INTO reviews SELECT * FROM source",
  "INSERT INTO reviews (state) VALUES ('open') ON CONFLICT (id) DO UPDATE SET state = excluded.state",
])("raw review writes must prove state safe: %s", async (query) => {
  const folder = await fixture({ "entry.ts": sqlModule(query) });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
    "forbidden review state SQL: entry.ts",
  );
});

test.each(["./db/schema.js", "./db/../db/schema.js"])(
  "schema namespaces follow esbuild's resolved path: %s",
  async (specifier) => {
    const folder = await fixture({
      "entry.ts": `import * as tables from "${specifier}"; export const rows = tables;`,
      "db/schema.ts": "export const sends = {};",
    });
    await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
      "forbidden schema namespace binding: entry.ts",
    );
  },
);

test.each(["sends", "pairings", "devices"])("re-exporting %s is a binding in the exporting module", async (table) => {
  const folder = await fixture({
    "entry.ts": `export { ${table} as rows } from "./db/schema.js";`,
    "db/schema.ts": `export const ${table} = {};`,
  });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
    "forbidden reviewer table binding: entry.ts",
  );
});

test("explicit delivery updates and literal open review writes remain safe", async () => {
  const folder = await fixture({
    "server/mailbox/take.ts":
      "export const act = (q) => q.update(sends).set({ deliveryId: deliveryId, setAsideAt: null });",
    "entry.ts": `export const act = (q) => q.insert(reviews).values({ state: "open" }).onConflictDoUpdate({ set: { state: "open" } }); ${sqlModule("INSERT INTO reviews (id, state) VALUES (1, 'open') ON CONFLICT (id) DO UPDATE SET state = 'open'").replace("act", "raw")}`,
  });
  await expect(
    assertAgentGraph(folder, [join(folder, "entry.ts"), join(folder, "server/mailbox/take.ts")]),
  ).resolves.toBeInstanceOf(Set);
});

const guardedValues = [
  { table: "reviews", key: "state", safe: '"open"', unsafe: '"approved"' },
  { table: "comments", key: "author", safe: '"agent"', unsafe: '"user"' },
  { table: "tokens", key: "kind", safe: '"agent"', unsafe: '"reviewer"' },
];

test.each(guardedValues)("all conflict arms check $table / $key independently of their builder", async (rule) => {
  const initial = `q.insert(${rule.table}).values({ ${rule.key}: ${rule.safe} })`;
  for (const value of [rule.unsafe, "nextValue", rule.key, `${rule.safe} + ""`]) {
    const patch = value === rule.key ? `{ ${rule.key} }` : `{ ${rule.key}: ${value} }`;
    for (const body of [
      `return ${initial}.onConflictDoUpdate({ set: ${patch} });`,
      `return ${initial}.$dynamic().onConflictDoUpdate({ set: ${patch} });`,
      `return ${initial}.onConflictDoNothing().onConflictDoUpdate({ set: ${patch} });`,
      `let b = ${initial}; if (condition) b = b.onConflictDoUpdate({ set: ${patch} }); return b;`,
      `const b = ${initial}.$dynamic(); return b.onConflictDoUpdate({ set: ${patch} });`,
      `return b.onConflictDoUpdate({ set: ${patch} });`,
      `return ${initial}.onConflictDoUpdate({ set: { ${rule.key}: ${rule.safe} } }).onConflictDoUpdate({ set: ${patch} });`,
    ]) {
      const folder = await fixture({ "entry.ts": `export function act(q) { ${body} }` });
      await expect
        .soft(assertAgentGraph(folder, [join(folder, "entry.ts")]), body)
        .rejects.toThrow(`forbidden ${rule.table} conflict ${rule.key} write: entry.ts`);
    }
  }
});

test.each(guardedValues)("updates check $table / $key with the same literal rule as inserts", async (rule) => {
  for (const patch of [
    `{ ${rule.key}: ${rule.unsafe} }`,
    `{ ${rule.key}: nextValue }`,
    `{ ${rule.key} }`,
    `{ ${rule.key}: ${rule.safe} + "" }`,
    `{ ${rule.key}: ${rule.safe}, ...patch }`,
    `{ [key]: ${rule.unsafe} }`,
    "patch",
  ]) {
    for (const name of ["entry.ts", "server/auth/tokens.ts"]) {
      const folder = await fixture({ [name]: `export const act = (q) => q.update(${rule.table}).set(${patch});` });
      await expect
        .soft(assertAgentGraph(folder, [join(folder, name)]), patch)
        .rejects.toThrow(`forbidden ${rule.table} ${rule.key} write: ${name}`);
    }
  }
});

test.each(["patch", "{ ...patch }", "{ set: patch }", "{ set: { ...patch } }", "{ set }"])(
  "standalone conflict updates reject an unprovable set: %s",
  async (value) => {
    const folder = await fixture({ "entry.ts": `export const act = (b) => b.onConflictDoUpdate(${value});` });
    await expect
      .soft(assertAgentGraph(folder, [join(folder, "entry.ts")]))
      .rejects.toThrow("forbidden conflict update shape: entry.ts");
  },
);

test.each(sqliteWrites)("raw token writes are forbidden with %s in every module", async (verb) => {
  for (const name of ["entry.ts", "server/auth/tokens.ts", "server/mailbox/take.ts", "db/client.ts"]) {
    for (const target of sqlNames("tokens")) {
      const query = verb.startsWith("UPDATE")
        ? `${verb} ${target} SET kind = 'agent'`
        : verb === "DELETE"
          ? `DELETE FROM ${target}`
          : `${verb} INTO ${target} (kind) VALUES ('agent')`;
      const folder = await fixture({ [name]: sqlModule(query) });
      await expect
        .soft(assertAgentGraph(folder, [join(folder, name)]), query)
        .rejects.toThrow(`forbidden reviewer table SQL: ${name}`);
    }
  }
});

test.each([
  'export const pattern = /"/; q.run("INSERT INTO tokens (kind) VALUES (\'reviewer\')");',
  "export const pattern = /'/; q.run(\"UPDATE reviews SET state = 'approved'\");",
  `export const text = \`outer \${tag\`'\${value.replaceAll("'", "''")}'\`} end\`; q.run("DELETE FROM tokens");`,
  'export const text = `first\nsecond`; q.run("DELETE FROM tokens");',
])("quote scans refuse a match spanning lines: %s", async (source) => {
  const folder = await fixture({ "entry.ts": source });
  await expect
    .soft(assertAgentGraph(folder, [join(folder, "entry.ts")]))
    .rejects.toThrow("forbidden multiline quote scan: entry.ts");
});

test.each(["INSERT INTO", "REPLACE INTO", "UPDATE", "DELETE FROM"])(
  "raw %s rejects unreadable interpolated targets",
  async (verb) => {
    for (const target of [`\${sql.identifier(name)}`, `\${chooseTable()}`, `\${schema[name]}`, `\${unknownTable}`]) {
      const query = `${verb} ${target} ${verb === "UPDATE" ? "SET kind = 'agent'" : "(kind) VALUES ('agent')"}`;
      const folder = await fixture({ "entry.ts": sqlModule(query) });
      await expect
        .soft(assertAgentGraph(folder, [join(folder, "entry.ts")]), query)
        .rejects.toThrow("forbidden unresolved SQL write target: entry.ts");
    }
  },
);

test.each(["sends", "pairings", "devices", "comments", "tokens", "reviews"])(
  "sql.identifier cannot bind sensitive table %s even in an allowlisted module",
  async (table) => {
    const name = "server/mailbox/take.ts";
    const folder = await fixture({ [name]: `export const target = sql.identifier("${table}");` });
    await expect
      .soft(assertAgentGraph(folder, [join(folder, name)]))
      .rejects.toThrow(`forbidden sensitive SQL identifier: ${name}`);
  },
);

test.each(["sends", "pairings", "devices"])("named bindings of %s are checked for every specifier", async (table) => {
  for (const specifier of ["./tables.ts", "synthetic-tables"]) {
    for (const statement of [
      `import { ${table} as rows } from "${specifier}"; export const use = () => rows;`,
      `export { ${table} as rows } from "${specifier}";`,
    ]) {
      const folder = await fixture({ "entry.ts": statement, "tables.ts": `export const ${table} = {};` });
      await expect
        .soft(assertAgentGraph(folder, [join(folder, "entry.ts")]))
        .rejects.toThrow("forbidden reviewer table binding: entry.ts");
    }
  }
});

test.each(["./db/schema.ts", "./db/schema.js", "./db/../db/schema.js"])(
  "dynamic schema import is a namespace binding: %s",
  async (specifier) => {
    const folder = await fixture({
      "entry.ts": `export const load = () => import("${specifier}");`,
      "db/schema.ts": "export const sends = {};",
    });
    await expect
      .soft(assertAgentGraph(folder, [join(folder, "entry.ts")]))
      .rejects.toThrow("forbidden schema namespace binding: entry.ts");
  },
);

test.each(["sends", "pairings", "devices"])("db/client may not bind %s outside its schema namespace", async (table) => {
  for (const source of [
    `import { ${table} } from "./schema.ts"; export const use = () => ${table};`,
    `export { ${table} as rows } from "./schema.ts";`,
    `const { ${table}: rows } = schema; export const use = () => rows;`,
    `const rows = schema.${table}; export const use = () => rows;`,
  ]) {
    const folder = await fixture({ "db/client.ts": source, "db/schema.ts": `export const ${table} = {};` });
    await expect
      .soft(assertAgentGraph(folder, [join(folder, "db/client.ts")]))
      .rejects.toThrow("forbidden reviewer table binding: db/client.ts");
  }
});

test.each(["sends", "pairings", "devices"])("db/client may not read %s with raw SQL", async (table) => {
  const folder = await fixture({ "db/client.ts": sqlModule(`SELECT * FROM ${table}`) });
  await expect
    .soft(assertAgentGraph(folder, [join(folder, "db/client.ts")]))
    .rejects.toThrow("forbidden reviewer SQL binding: db/client.ts");
});

test("take may claim Sends only through its checked Drizzle updates", async () => {
  const folder = await fixture({
    "server/mailbox/take.ts": sqlModule("UPDATE sends SET delivery_id = NULL, set_aside_at = 1 WHERE id = 2"),
  });
  await expect
    .soft(assertAgentGraph(folder, [join(folder, "server/mailbox/take.ts")]))
    .rejects.toThrow("forbidden reviewer table SQL: server/mailbox/take.ts");
});

test.each(['{ kind: "reviewer" }', "{ kind }", "row"])(
  "the token helper module cannot exempt additional inserts: %s",
  async (value) => {
    const folder = await fixture({
      "server/auth/tokens.ts": `export const act = (q) => q.insert(tokens).values(${value});`,
    });
    await expect(assertAgentGraph(folder, [join(folder, "server/auth/tokens.ts")])).rejects.toThrow(
      "forbidden tokens kind write: server/auth/tokens.ts",
    );
  },
);

test.each(["patch", "{ ...patch }", '{ set: { state: "approved" } }'])(
  "conflict-do-nothing arms must prove they contain no write: %s",
  async (value) => {
    const folder = await fixture({ "entry.ts": `export const act = (b) => b.onConflictDoNothing(${value});` });
    await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
      "forbidden conflict do-nothing shape: entry.ts",
    );
  },
);

test.each(guardedValues)("later chained setters still check $table / $key", async (rule) => {
  for (const method of ["insert", "update"]) {
    const setter = method === "insert" ? "values" : "set";
    const folder = await fixture({
      "entry.ts": `export const act = (q) => q.${method}(${rule.table}).${setter}({ ${rule.key}: ${rule.safe} }).$dynamic().${setter}({ ${rule.key}: ${rule.unsafe} });`,
    });
    await expect
      .soft(assertAgentGraph(folder, [join(folder, "entry.ts")]))
      .rejects.toThrow(`forbidden ${rule.table} ${rule.key} write: entry.ts`);
  }
});

test.each([`"\${unknownTable}"`, `[\${unknownTable}]`, "?", `\${schema[table]}`])(
  "unreadable SQL targets cannot hide behind quoting: %s",
  async (target) => {
    const folder = await fixture({ "entry.ts": sqlModule(`UPDATE ${target} SET state = 'open'`) });
    await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
      "forbidden unresolved SQL write target: entry.ts",
    );
  },
);

test.each(["comments", "tokens", "reviews", "changedBlocks"])(
  "db/client binds no named schema table or raw read of %s",
  async (table) => {
    for (const source of [
      `import { ${table} as rows } from "./schema.ts"; export const use = () => rows;`,
      `export { ${table} as rows } from "./schema.ts";`,
      `const { ${table}: rows } = schema; export const use = () => rows;`,
      `const rows = schema.${table}; export const use = () => rows;`,
      sqlModule(`SELECT * FROM ${table}`),
    ]) {
      const folder = await fixture({ "db/client.ts": source, "db/schema.ts": `export const ${table} = {};` });
      await expect
        .soft(assertAgentGraph(folder, [join(folder, "db/client.ts")]), source)
        .rejects.toThrow(
          source.includes("SELECT")
            ? "forbidden reviewer SQL binding: db/client.ts"
            : "forbidden reviewer table binding: db/client.ts",
        );
    }
  },
);

test.each(["server/mailbox/take.ts", "server/mailbox/payload.ts", "server/publish/changed.ts", "db/client.ts"])(
  "the multiline template exemption in %s still scans SQL and rejects spanning quotes",
  async (name) => {
    const folder = await fixture({
      [name]: "export const act = (q) => q.run(sql`UPDATE tokens\n SET kind = 'agent'`);",
    });
    await expect(assertAgentGraph(folder, [join(folder, name)])).rejects.toThrow(
      `forbidden reviewer table SQL: ${name}`,
    );
    const blind = await fixture({ [name]: 'export const pattern = /"/; q.run("DELETE FROM tokens");' });
    await expect(assertAgentGraph(blind, [join(blind, name)])).rejects.toThrow(
      `forbidden multiline quote scan: ${name}`,
    );
  },
);

test.each(guardedValues)("safe $table / $key writes and split conflict builders still pass", async (rule) => {
  const folder = await fixture({
    "entry.ts": `export async function act(q) {
      let b = q.insert(${rule.table}).values({ ${rule.key}: ${rule.safe} }).$dynamic();
      if (condition) b = b.onConflictDoNothing({ target: id });
      b = b.onConflictDoUpdate({ set: { ${rule.key}: ${rule.safe} } });
      b = b.values({ ${rule.key}: ${rule.safe} });
      await q.update(${rule.table}).set({ ${rule.key}: ${rule.safe} });
      await q.update(${rule.table}).set({ updatedAt: now });
      return b;
    }`,
  });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).resolves.toBeInstanceOf(Set);
});

test("known non-sensitive SQL targets and the database client's dynamic namespace still pass", async () => {
  const folder = await fixture({
    "entry.ts": `import { changedBlocks as rows } from "./db/schema.js"; ${sqlModule(`INSERT INTO \${rows} (id) VALUES (1)`)}`,
    "db/client.ts": 'export const load = () => import("./schema.js");',
    "db/schema.ts": "export const changedBlocks = {};",
  });
  await expect(
    assertAgentGraph(folder, [join(folder, "entry.ts"), join(folder, "db/client.ts")]),
  ).resolves.toBeInstanceOf(Set);
});

test.each(guardedValues)("retained builders still check every $table / $key setter", async (rule) => {
  for (const method of ["insert", "update"]) {
    const setter = method === "insert" ? "values" : "set";
    for (const patch of [`{ ${rule.key}: ${rule.unsafe} }`, `{ ${rule.key} }`, "patch"]) {
      const folder = await fixture({
        "entry.ts": `export function act(q) {
          let b = q.${method}(${rule.table}).${setter}({ ${rule.key}: ${rule.safe} }).$dynamic();
          if (condition) b = b.${setter}(${patch});
          return b;
        }`,
      });
      await expect
        .soft(assertAgentGraph(folder, [join(folder, "entry.ts")]), patch)
        .rejects.toThrow(
          patch === "patch"
            ? "forbidden unresolved write value: entry.ts"
            : `forbidden ${rule.table} ${rule.key} write: entry.ts`,
        );
    }
  }
});

test.each(["import", "export"])("%s bindings include the named part after a default import", async (kind) => {
  const source =
    kind === "import"
      ? 'import tables, { sends as rows } from "./tables.ts"; export const use = () => [tables, rows];'
      : 'export { default as tables, sends as rows } from "./tables.ts";';
  const folder = await fixture({ "entry.ts": source, "tables.ts": "export default {}; export const sends = {};" });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
    "forbidden reviewer table binding: entry.ts",
  );
});

test.each(guardedValues)("round 5: unknown targets must prove $table / $key values", async (rule) => {
  for (const target of ["table", "rows", "schema.changedBlocks", "chooseTable()"])
    for (const method of ["insert", "update"]) {
      const setter = method === "insert" ? "values" : "set";
      for (const body of [
        `return q.${method}(${target}).${setter}({ ${rule.key} });`,
        `const b = q.${method}(${target}); return b.${setter}({ ${rule.key} });`,
        `return q.${method}(${target}).${setter}({}).$dynamic().${setter}({ ${rule.key} });`,
      ]) {
        const folder = await fixture({ "entry.ts": `export function setValue(q, table, ${rule.key}) { ${body} }` });
        await expect
          .soft(assertAgentGraph(folder, [join(folder, "entry.ts")]), body)
          .rejects.toThrow(`forbidden ${rule.table} ${rule.key} write: entry.ts`);
      }
    }
});

test.each(["entry.ts", "server/mailbox/take.ts"])(
  "round 5: an import from an ordinary module does not prove a non-sensitive target in %s",
  async (name) => {
    const folder = await fixture({
      [name]:
        'import { changedBlocks as rows } from "synthetic-tables"; export const act = (q, state) => q.update(rows).set({ state });',
    });
    await expect(assertAgentGraph(folder, [join(folder, name)])).rejects.toThrow(
      `forbidden reviews state write: ${name}`,
    );
  },
);

test.each([
  'const b = q.update(sends); b.set({ instruction: "x" });',
  'const b = q.update(sends).set({ deliveryId }); b.set({ instruction: "x" });',
  'let b = q.update(sends).set({ deliveryId }).$dynamic(); if (condition) b = b.set({ instruction: "x" });',
  'const first = q.update(sends).set({ deliveryId }); const b = first; b.set({ instruction: "x" });',
  'const b = q.update(sends).set({ deliveryId }); b.$dynamic().set({ instruction: "x" });',
  'q.update(sends).set({ deliveryId }).$dynamic().set({ instruction: "x" });',
])("round 5: every Send setter checks its delivery keys: %s", async (body) => {
  const folder = await fixture({ "server/mailbox/take.ts": `export function act(q, deliveryId) { ${body} }` });
  await expect(assertAgentGraph(folder, [join(folder, "server/mailbox/take.ts")])).rejects.toThrow(
    "forbidden reviewer update columns: server/mailbox/take.ts",
  );
});

test.each(["createToken", "insertToken", "rotateLocalToken"])(
  "round 5: %s calls inside tokens.ts still prove their kind",
  async (helper) => {
    for (const body of [
      `export const act = (q, o) => ${helper}(q, o, "reviewer", {});`,
      `export function createToken(q, o, kind) { return ${helper}(q, o, "reviewer", {}); }`,
      `export function createToken(q, o, kind) { return ${helper}(q, o, kind + "", {}); }`,
      `export function createToken(q, o, other) { return ${helper}(q, o, kind, {}); }`,
      `export function createToken(q, o, kind) { return kind; } export const act = (q, o, kind) => ${helper}(q, o, kind, {});`,
    ]) {
      const folder = await fixture({ "server/auth/tokens.ts": body });
      await expect
        .soft(assertAgentGraph(folder, [join(folder, "server/auth/tokens.ts")]), body)
        .rejects.toThrow("forbidden token kind: server/auth/tokens.ts");
    }
  },
);

test.each([
  [
    `export const act = (q) => q.run(sql\`INSERT INTO \${sql.identifier(\`comments\`)} (author) VALUES ('user')\`);`,
    "sensitive SQL identifier",
  ],
  ["export const target = sql.identifier(`sends`);", "sensitive SQL identifier"],
  [
    `export const act = (q, name) => q.run(sql\`INSERT INTO \${sql.identifier(\`\${name}\`)} (id) VALUES (1)\`);`,
    "unresolved SQL write target",
  ],
  [
    `export const act = (q) => q.run(sql\`INSERT INTO \${choose(\`comments\`)} (id) VALUES (1)\`);`,
    "unresolved SQL write target",
  ],
  ['export const act = (q) => q.run("INSERT INTO $ (id) VALUES (1)");', "unresolved SQL write target"],
])("round 5: nested templates cannot hide SQL targets: %s", async (source, reason) => {
  const folder = await fixture({ "entry.ts": source });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(`forbidden ${reason}: entry.ts`);
});

test.each([
  ["INSERT INTO comments (author) VALUES ('agent')", "reviewer table SQL"],
  ["DELETE FROM tokens", "reviewer table SQL"],
  ["UPDATE reviews SET state = 'approved'", "review state SQL"],
  ["UPDATE sends SET delivery_id = NULL", "reviewer SQL binding"],
])("round 5: schema.ts still scans SQL writes: %s", async (query, reason) => {
  const folder = await fixture({ "db/schema.ts": sqlModule(query) });
  await expect(assertAgentGraph(folder, [join(folder, "db/schema.ts")])).rejects.toThrow(
    `forbidden ${reason}: db/schema.ts`,
  );
});

test.each(["comments", "tokens", "reviews", "changedBlocks"])(
  "round 5: db/client rejects named %s imports through every specifier",
  async (table) => {
    for (const specifier of ["../tables.ts", "synthetic-tables"])
      for (const statement of [
        `import { ${table} as rows } from "${specifier}"; export const use = () => rows;`,
        `export { ${table} as rows } from "${specifier}";`,
      ]) {
        const folder = await fixture({
          "db/client.ts": statement,
          "tables.ts": `export { ${table} } from "./db/schema.ts";`,
          "db/schema.ts": `export const ${table} = {};`,
        });
        await expect
          .soft(assertAgentGraph(folder, [join(folder, "db/client.ts")]), statement)
          .rejects.toThrow("forbidden reviewer table binding: db/client.ts");
      }
  },
);

test.each(["sends", "pairings", "devices", "comments", "tokens", "reviews"])(
  "round 5: db/client rejects every namespace read of %s",
  async (table) => {
    for (const source of [
      `import * as tables from "./schema.js"; export const use = () => tables.${table};`,
      `import * as tables from "./schema.js"; const first = tables; const rows = first; export const use = () => rows["${table}"];`,
      `export const use = async () => (await import("./schema.js")).${table};`,
      `const tables = await import("./schema.js"); const rows = tables; export const use = () => rows.${table};`,
      `export const use = () => require("./schema.js")["${table}"];`,
      `const tables = require("./schema.js"); const rows = tables; export const use = () => rows.${table};`,
    ]) {
      const folder = await fixture({ "db/client.ts": source, "db/schema.ts": `export const ${table} = {};` });
      await expect
        .soft(assertAgentGraph(folder, [join(folder, "db/client.ts")]), source)
        .rejects.toThrow("forbidden reviewer table binding: db/client.ts");
    }
  },
);

test.each(["./db/schema.ts", "./db/schema.js", "./db/../db/schema.js"])(
  "round 5: require is also a schema namespace binding: %s",
  async (specifier) => {
    const folder = await fixture({
      "entry.ts": `export const tables = require("${specifier}");`,
      "db/schema.ts": "export const comments = {};",
    });
    await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
      "forbidden schema namespace binding: entry.ts",
    );
  },
);

test.each([
  ["server/auth/tokens.ts", "pairings"],
  ["server/auth/tokens.ts", "sends"],
  ["server/mailbox/payload.ts", "devices"],
  ["server/mailbox/payload.ts", "pairings"],
  ["server/mailbox/take.ts", "devices"],
  ["server/mailbox/take.ts", "pairings"],
])("round 5: %s cannot bind unrelated reviewer table %s", async (name, table) => {
  for (const source of [
    `import { ${table} as rows } from "../../db/schema.ts"; export const use = () => rows;`,
    `export { ${table} as rows } from "synthetic-tables";`,
    `const { ${table}: rows } = schema; export const use = () => rows;`,
    `const rows = schema.${table}; export const use = () => rows;`,
    sqlModule(`SELECT * FROM ${table}`),
  ]) {
    const folder = await fixture({ [name]: source, "db/schema.ts": `export const ${table} = {};` });
    await expect
      .soft(assertAgentGraph(folder, [join(folder, name)]), source)
      .rejects.toThrow(`forbidden reviewer ${source.includes("SELECT") ? "SQL" : "table"} binding: ${name}`);
  }
});

test("round 5: reassigning a non-sensitive builder loses its value exemption", async () => {
  const folder = await fixture({
    "entry.ts": `import { changedBlocks as rows } from "./db/schema.js";
      export function act(q, table, state) {
        let b = q.update(rows).set({});
        if (condition) b = q.update(table).set({});
        return b.set({ state });
      }`,
    "db/schema.ts": "export const changedBlocks = {};",
  });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow(
    "forbidden reviews state write: entry.ts",
  );
});

test("round 5: schema enum templates cannot hide a later SQL write", async () => {
  const folder = await fixture({
    "db/schema.ts": `const enumCheck = (values) => sql\`in (\${sql.join(values.map((value) => sql.raw(\`'\${value.replaceAll("'", "''")}'\`)), sql\`, \`)})\`;
      export const act = (q) => q.run("DELETE FROM tokens");`,
  });
  await expect(assertAgentGraph(folder, [join(folder, "db/schema.ts")])).rejects.toThrow(
    "forbidden reviewer table SQL: db/schema.ts",
  );
});

test.each(["comments", "changedBlocks"])(
  "round 5: db/client cannot import a renamed %s from a barrel",
  async (table) => {
    const folder = await fixture({
      "db/client.ts": 'import { rows as table } from "../tables.ts"; export const use = () => table;',
      "tables.ts": `export { ${table} as rows } from "./db/schema.ts";`,
      "db/schema.ts": `export const ${table} = {};`,
    });
    await expect(assertAgentGraph(folder, [join(folder, "db/client.ts")])).rejects.toThrow(
      "forbidden reviewer table binding: db/client.ts",
    );
  },
);

test("round 5: named non-sensitive schema targets and their retained setters pass", async () => {
  const folder = await fixture({
    "entry.ts": `import { changedBlocks as rows } from "./db/../db/schema.js";
      export function act(q, state, author, kind) {
        const b = q.insert(rows).values({ state, author, kind });
        b.$dynamic().values({ state, author, kind });
        return q.update(rows).set({ state, author, kind });
      }`,
    "db/schema.ts": "export const changedBlocks = {};",
  });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).resolves.toBeInstanceOf(Set);
});

test("round 5: safe unknown setters and retained delivery updates pass", async () => {
  const folder = await fixture({
    "entry.ts":
      'export const act = (q, table) => q.update(table).set({ state: "open", author: "agent", kind: "agent" });',
    "server/mailbox/take.ts": `export function act(q, deliveryId) {
      const b = q.update(sends).set({ deliveryId });
      b.$dynamic().set({ setAsideAt: null });
      return b.set({ deliveryId: null });
    }`,
  });
  await expect(
    assertAgentGraph(folder, [join(folder, "entry.ts"), join(folder, "server/mailbox/take.ts")]),
  ).resolves.toBeInstanceOf(Set);
});

test.each(["createToken", "rotateLocalToken"])(
  "round 5: %s may forward only its own kind parameter",
  async (helper) => {
    const folder = await fixture({
      "server/auth/tokens.ts": `export function ${helper}(q: unknown, owner: string, kind: string, options = {}) {
      return insertToken(q, owner, kind, options);
    }
    export function insertToken(q, owner, kind, options) { return q.insert(tokens).values({ kind }); }
    export const act = (q, owner) => ${helper}(q, owner, "agent", {});`,
    });
    await expect(assertAgentGraph(folder, [join(folder, "server/auth/tokens.ts")])).resolves.toBeInstanceOf(Set);
  },
);

test.each(["import", "require"])("round 5: db/client may pass on a %s schema namespace", async (loader) => {
  const folder = await fixture({
    "db/client.ts": `export const tables = ${loader === "import" ? "await " : ""}${loader}("./schema.js");`,
    "db/schema.ts": "export const comments = {};",
  });
  await expect(assertAgentGraph(folder, [join(folder, "db/client.ts")])).resolves.toBeInstanceOf(Set);
});

test.each([
  'export const v = "update";',
  'export const v = "delete";',
  'export const act = (q) => q.run("update" + " tokens set kind = \'reviewer\'");',
  `const v = "update"; export const act = (q) => q.run(\`\${v} reviews set state = 'approved'\`);`,
])("rejects split and lone SQL verbs: %s", async (source) => {
  const folder = await fixture({ "entry.ts": source });
  await expect(assertAgentGraph(folder, [join(folder, "entry.ts")])).rejects.toThrow("forbidden");
});

test.each(["cli.ts", "main.ts"])("allows only the command name in %s", async (name) => {
  const folder = await fixture({ [name]: 'export const command = "update";' });
  await expect(assertAgentGraph(folder, [join(folder, name)])).resolves.toBeInstanceOf(Set);
  const bad = await fixture({ [name]: 'export const command = "delete";' });
  await expect(assertAgentGraph(bad, [join(bad, name)])).rejects.toThrow("forbidden");
});
test("allows the main Usage template including the inline update command", async () => {
  const folder = await fixture({ "main.ts": "export const help = `Usage:\n  emend update\n  emend devices`;" });
  await expect(assertAgentGraph(folder, [join(folder, "main.ts")])).resolves.toBeInstanceOf(Set);
});

test.each([
  "export const act = (q) => q.run(`Usage:\nUPDATE reviews SET state = 'approved'`.slice(7));",
  "export const act = (q) => q.run(`Usage:\nDELETE FROM tokens`.slice(7));",
  `const x = "UPDATE reviews SET state = 'approved'"; export const act = (q) => q.run(\`Usage:\n\${x}\`);`,
  `export const act = (q, x) => q.run(\`Usage:\n\${x} SELECT * FROM devices\`);`,
])("main Usage templates still reject SQL: %s", async (source) => {
  const folder = await fixture({ "main.ts": source });
  await expect(assertAgentGraph(folder, [join(folder, "main.ts")])).rejects.toThrow("forbidden");
});
