// Polling uses the running test's budget. Keep this text guard independent of test discovery.
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const helper = "apps/emend/src/test/poll-until.ts";
const webSetup = "apps/web/src/test/setup.ts";
const rawWaitAllowed = new Set([
  helper,
  "apps/emend/src/cli/tailscale-process.test.ts",
  "apps/emend/src/cli/commands/serve-signals.test.ts",
]);
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Keep literals atomic so punctuation in strings, regexes and comments cannot end a call.
// Options must be literal objects: variables, spreads and computed keys fail closed.
function tokens(source: string): string[] {
  return (source.match(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[a-z]*|[$\w]+|[^\s]/g,
  ) ?? []).filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
}
const name = (token: string) => token.replace(/^["']|["']$/g, "");

function argumentsAt(parts: string[], opening: number): string[][] {
  const args: string[][] = [[]];
  const stack = [")"];
  const close: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  for (let i = opening + 1; i < parts.length; i++) {
    const token = parts[i];
    if (Object.hasOwn(close, token)) stack.push(close[token]);
    else if ([")", "]", "}"].includes(token)) {
      assert.equal(token, stack.pop(), "unbalanced polling call; update the guard for this syntax");
      if (!stack.length) return args;
    }
    if (token === "," && stack.length === 1) args.push([]);
    else args.at(-1)!.push(token);
  }
  assert.fail("unterminated polling call");
}

// Skip TypeScript type arguments such as `waitFor<HTMLElement>(`; returns the index after the closing `>`.
function afterTypeArguments(parts: string[], index: number): number {
  if (parts[index] !== "<") return index;
  let depth = 0;
  for (let i = index; i < parts.length && i < index + 200; i++) {
    if (parts[i] === "<") depth++;
    else if (parts[i] === ">" && parts[i - 1] !== "=" && --depth === 0) return i + 1;
    else if ([";", ")"].includes(parts[i]) && depth === 1) break;
  }
  return index;
}

// Vitest runs one current test and Testing Library has one global config, so polling deadlines need serial tests.
function checkSerial(path: string, parts: string[]): void {
  for (let i = 0; i < parts.length; i++) {
    if (name(parts[i]) !== "concurrent") continue;
    const where = `${path}: concurrent tests break the polling deadlines; run tests serially`;
    assert(parts[i - 1] !== ".", where);
    const inSequence = parts[i - 1] === "{" && parts[i - 2] === ":" && name(parts[i - 3]) === "sequence";
    if (parts[i + 1] === ":") assert(parts[i + 2] === "false" && !inSequence, where);
  }
}

function check(path: string, source: string): void {
  const parts = tokens(source);
  checkSerial(path, parts);
  const aliases = new Map<string, string>();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i + 1] === "as") aliases.set(parts[i + 2], parts[i]);
  }
  for (let i = 0; i < parts.length; i++) {
    const identifier = aliases.get(name(parts[i])) ?? name(parts[i]);
    if (identifier === "asyncUtilTimeout") {
      assert.equal(path, webSetup, `${path}: only the web setup may configure asyncUtilTimeout`);
    }
    if (!["waitFor", "waitUntil", "poll"].includes(identifier) && !/^find(?:All)?By\w+$/.test(identifier)) continue;
    const computed = parts[i - 1] === "[" && parts[i + 1] === "]";
    const receiver = parts[i - 2];
    const owner = aliases.get(receiver) ?? receiver;
    // vi.waitFor, vi.waitUntil and expect.poll default to 1000 ms; only the helper and step-7 files may call them.
    const raw =
      (["waitFor", "waitUntil"].includes(identifier) && ["vi", "vitest"].includes(owner)) ||
      (identifier === "poll" && owner === "expect");
    if (raw) {
      assert(rawWaitAllowed.has(path), `${path}: use an event or pollUntil instead of ${owner}.${identifier}`);
      continue;
    }
    if (identifier === "poll" || identifier === "waitUntil") continue;
    const opening = afterTypeArguments(parts, i + (computed ? 2 : 1));
    if (parts[opening] !== "(") continue;
    const args = argumentsAt(parts, opening);
    // Standalone findBy queries take a container before the usual three arguments.
    const options = args[identifier === "waitFor" ? 1 : args.length >= 4 && args[3].length ? 3 : 2];
    if (!options?.length || options.join("") === "undefined") continue;
    assert(options[0] === "{" && options.at(-1) === "}", `${path}: polling options must be a literal object`);
    assert(!options.includes("["), `${path}: computed polling option keys are not allowed`);
    assert(!options.join("").includes("..."), `${path}: polling options cannot contain spreads`);
    assert(!options.some((token) => name(token) === "timeout"), `${path}: set the test timeout, not a polling timeout`);
  }
}

test("polling waits inherit the test deadline", () => {
  const tests = globSync(["apps/**/src/**/*.test.{ts,tsx}", "packages/**/src/**/*.test.ts"], { cwd: root }).sort();
  assert(tests.length > 0, "no test sources found");
  for (const path of tests) check(path, read(path));
  // Also cover setup/helpers and production sources so a wrapper cannot hide an override.
  const sources = globSync(["apps/**/src/**/*.{ts,tsx}", "packages/**/src/**/*.ts"], { cwd: root });
  for (const path of sources) {
    if (!tests.includes(path)) check(path, read(path));
  }
  checkSerial("vitest.config.ts", tokens(read("vitest.config.ts")));
  assert(sources.includes(helper) && sources.includes(webSetup), "missing polling helper or web setup");
  const { scripts } = JSON.parse(read("package.json"));
  assert(scripts["test:harness"].split(" ").includes("scripts/polling-waits.test.ts"), "the harness must run this guard");
});

test("the guard rejects multiline waits, aliases and hidden options", () => {
  for (const source of [
    "waitFor(\n () => expect(value).toBe(true),\n { timeout: 12_000 },\n);",
    "screen.findByRole(\n 'button',\n { name: /save\\)/ },\n { timeout: 12_000 },\n);",
    "within(view).findAllByText('ready', {}, { 'timeout': 1000 });",
    "findByRole(container, 'button', { name: /save/ }, { timeout: 1000 });",
    "waitFor(() => ready(), options);",
    "waitFor(() => ready(), { ...options });",
    "waitFor(() => ready(), { ['timeout']: 1000 });",
    "waitFor(() => ready(), { timeout });",
    "import { waitFor as until } from '@testing-library/react'; until(() => ready(), { timeout: 1 });",
    "vi\n .waitFor(\n () => ready()\n);",
    "vi['waitFor'](() => ready());",
    "import { vi as mock } from 'vitest'; mock.waitFor(() => ready());",
    "configure({\n asyncUtilTimeout: 1000\n });",
    "await waitFor<HTMLElement>(() => ready(), { timeout: 1000 });",
    "await waitFor<Map<string, () => void>>(\n () => ready(),\n { timeout: 1000 },\n);",
    "screen.findByRole<HTMLButtonElement>('button', { name: /save/ }, { timeout: 1000 });",
    "await expect.poll(() => value).toBe(1);",
    "await expect\n .poll(() => value, { timeout: 5000 })\n .toBe(1);",
    "await expect['poll'](() => value).toBe(1);",
    "import { expect as check } from 'vitest'; await check.poll(() => value).toBe(1);",
    "await vi.waitUntil(() => ready());",
    "await vitest.waitUntil(() => ready(), { timeout: 5000 });",
    "await vi['waitUntil'](() => ready());",
    "test.concurrent('a', async () => {});",
    "it.concurrent('a', async () => {});",
    "describe.concurrent('a', () => {});",
    "test.concurrent.each([1])('a', async () => {});",
    "describe.concurrent.each([1])('a', () => {});",
    "test.skip.concurrent('a', async () => {});",
    "export default { test: { sequence: { concurrent: false, shuffle: true } } };",
    "export default { test: { 'sequence': { 'concurrent': false } } };",
    "export default { test: { sequence: { concurrent: true } } };",
    "export default { test: { concurrent: true } };",
    "test('a', { concurrent: true }, async () => {});",
  ]) assert.throws(() => check("apps/web/src/synthetic.test.tsx", source), undefined, source);
  assert.throws(() => check("apps/web/src/synthetic.test.tsx", "waitFor(() => ready(), { interval: 1 }"));
});

test("the guard accepts inherited deadlines and only the named exceptions", () => {
  for (const source of [
    "waitFor(() => expect(value).toBe(true));",
    "waitFor(() => expect(text).toMatch(/[(,)]/), { interval: 1 });",
    "screen.findByRole('button', { name: /save/ });",
    "screen.findAllByText('ready', {}, { interval: 1 });",
    "test('slow', { timeout: 20_000 }, async () => { await waitFor(() => ready()); });",
    "await waitFor<HTMLElement>(() => ready(), { interval: 1 });",
    "await waitFor<Map<string, () => void>>(() => ready());",
    "screen.findByRole<HTMLButtonElement>('button', { name: /save/ });",
    "const small = a < b; const large = c > d; waitFor(() => ready());",
    "expect(value).toBe(1); expect.soft(value).toBe(1);",
    "test('concurrent bootstraps leave both files', () => {}); // test.concurrent(",
    "self.addEventListener('install', (event) => event.waitUntil(ready()));",
    "const pollers = { poll: 1 }; pollers.poll(); waiter.waitUntil;",
  ]) check("apps/web/src/synthetic.test.tsx", source);
  for (const path of rawWaitAllowed) {
    for (const source of [
      "vi.waitFor(() => ready(), { timeout: 1000 });",
      "await expect.poll(() => value).toBe(1);",
      "await vi.waitUntil(() => ready());",
    ]) check(path, source);
  }
  check(webSetup, "beforeEach(({ task }) => configure({ asyncUtilTimeout: task.timeout }));");
  for (const source of ["vi.waitFor(() => ready());", "expect.poll(() => value);", "vi.waitUntil(() => ready());"])
    assert.throws(() => check(`prefix/${helper}`, source));
});
