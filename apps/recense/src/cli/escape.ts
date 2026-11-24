/** Controls and invisible characters: they hide or reorder text on a terminal. */
const invisibleRanges: readonly (readonly [number, number])[] = [
  [0, 31],
  [127, 159],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

function escapeControls(value: string, escaped: (code: number) => string): string {
  return Array.from(value, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return invisibleRanges.some(([from, to]) => code >= from && code <= to) ? escaped(code) : char;
  }).join("");
}

/** Keep untrusted paths and references visible on one terminal line. */
export function escapeReference(value: string): string {
  return escapeControls(value, (code) => `\\u{${code.toString(16)}}`);
}

/** One pasteable shell argument; ANSI-C quoting preserves names with terminal controls. */
export function quoteShellArgument(value: string): string {
  if (escapeReference(value) === value) return `'${value.replaceAll("'", "'\\''")}'`;
  const encoder = new TextEncoder();
  const quoted = escapeControls(value.replaceAll("\\", "\\\\").replaceAll("'", "\\'"), (code) =>
    Array.from(encoder.encode(String.fromCodePoint(code)), (byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join(
      "",
    ),
  );
  return `$'${quoted}'`;
}

/** Escape serialized JSON for a terminal without changing what JSON.parse returns. */
export function escapeJson(json: string): string {
  const shortEscapes: Record<string, string> = { b: "0008", f: "000c", n: "000a", r: "000d", t: "0009" };
  const expanded = json.replace(/\\./gs, (pair) => {
    const code = shortEscapes[pair[1] ?? ""];
    return code ? `\\u${code}` : pair;
  });
  const unit = (code: number) => `\\u${code.toString(16).padStart(4, "0")}`;
  // JSON escapes a code point above U+FFFF as its surrogate pair.
  return escapeControls(expanded, (code) =>
    code > 0xffff
      ? `${unit(0xd800 + ((code - 0x10000) >> 10))}${unit(0xdc00 + ((code - 0x10000) & 0x3ff))}`
      : unit(code),
  );
}
