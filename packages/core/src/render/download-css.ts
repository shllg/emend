/** CSS Syntax Level 3 tokenization. Offsets refer to the original, unpreprocessed source. */
export type CssToken = {
  kind:
    | "space"
    | "comment"
    | "string"
    | "bad-string"
    | "url"
    | "bad-url"
    | "function"
    | "at"
    | "hash"
    | "ident"
    | "number"
    | "percentage"
    | "dimension"
    | "delim"
    | "cdo"
    | "cdc"
    | "punct";
  start: number;
  end: number;
  value: string;
};
export const asciiLower = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());
export const isImageSet = (name: string) => name === "image-set" || name === "-webkit-image-set";
export function utf8Length(value: string, start = 0, end = value.length): number {
  let bytes = 0;
  for (let i = start; i < end; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < end &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
/** Bound piece metadata even for token-dense output or heavily escaped token values. */
export class CssTextBuffer {
  private pieces: string[] = [];
  private chunks: string[] = [];
  push(value: string): void {
    if (!value) return;
    this.pieces.push(value);
    if (this.pieces.length === 4096) {
      this.chunks.push(this.pieces.join(""));
      this.pieces.length = 0;
    }
  }
  finish(): string {
    if (this.pieces.length) {
      this.chunks.push(this.pieces.join(""));
      this.pieces.length = 0;
    }
    return this.chunks.join("");
  }
}

/** Bytes for bracket/context flags; wider entries only for open image-set source offsets. */
export class CssStack {
  private values: Uint8Array | Uint32Array;
  length = 0;
  constructor(wide = false) {
    this.values = wide ? new Uint32Array(32) : new Uint8Array(32);
  }
  top(): number | undefined {
    return this.length ? this.values[this.length - 1] : undefined;
  }
  push(value: number): void {
    if (this.length === this.values.length) {
      const grown =
        this.values instanceof Uint8Array ? new Uint8Array(this.length * 2) : new Uint32Array(this.length * 2);
      grown.set(this.values);
      this.values = grown;
    }
    this.values[this.length++] = value;
  }
  pop(): number | undefined {
    if (!this.length) return;
    return this.values[--this.length];
  }
}

const digit = (c: string) => c >= "0" && c <= "9";
const hex = (c: string) => digit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const newline = (c: string) => c === "\n" || c === "\r" || c === "\f";
const space = (c: string) => c === " " || c === "\t" || newline(c);
const nameStart = (c: string) =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "\0" || c.charCodeAt(0) >= 0x80;
const nameChar = (c: string) => nameStart(c) || digit(c) || c === "-";

export function* cssTokenize(source: string): Generator<CssToken> {
  let pos = 0;
  const at = (i: number) => source.charAt(i);
  const validEscape = (i: number) => at(i) === "\\" && !newline(at(i + 1));
  const startsIdent = (i: number) =>
    nameStart(at(i)) ||
    validEscape(i) ||
    (at(i) === "-" && (nameStart(at(i + 1)) || at(i + 1) === "-" || validEscape(i + 1)));
  const startsNumber = (i: number) =>
    digit(at(i)) ||
    (at(i) === "." && digit(at(i + 1))) ||
    ((at(i) === "+" || at(i) === "-") && (digit(at(i + 1)) || (at(i + 1) === "." && digit(at(i + 2)))));
  const skipNewline = () => {
    if (at(pos++) === "\r" && at(pos) === "\n") pos++;
  };
  const character = () => {
    const code = source.codePointAt(pos) ?? 0;
    pos += code > 0xffff ? 2 : 1;
    return code === 0 || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
  };
  const consumeEscape = () => {
    pos++; // backslash
    if (pos === source.length) return "\ufffd";
    if (!hex(at(pos))) return character();
    const start = pos;
    while (pos < start + 6 && hex(at(pos))) pos++;
    const code = Number.parseInt(source.slice(start, pos), 16);
    if (space(at(pos))) skipNewline();
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
  };
  const name = () => {
    const parts = new CssTextBuffer();
    while (pos < source.length) {
      if (nameChar(at(pos))) {
        const start = pos;
        while (
          nameChar(at(pos)) &&
          at(pos) !== "\0" &&
          !(source.charCodeAt(pos) >= 0xd800 && source.charCodeAt(pos) <= 0xdfff)
        )
          pos++;
        if (pos > start) parts.push(source.slice(start, pos));
        else parts.push(character());
      } else if (validEscape(pos)) parts.push(consumeEscape());
      else break;
    }
    return parts.finish();
  };
  const badUrl = () => {
    while (pos < source.length) {
      if (at(pos) === ")") {
        pos++;
        break;
      }
      if (validEscape(pos)) consumeEscape();
      else pos++;
    }
  };
  while (pos < source.length) {
    const start = pos;
    let kind: CssToken["kind"] = "delim";
    let value = "";
    const c = at(pos);
    if (space(c)) {
      kind = "space";
      do {
        pos++;
      } while (space(at(pos)));
    } else if (c === "/" && at(pos + 1) === "*") {
      kind = "comment";
      pos += 2;
      while (pos < source.length && !(at(pos) === "*" && at(pos + 1) === "/")) pos++;
      pos = Math.min(pos + 2, source.length);
    } else if (c === '"' || c === "'") {
      kind = "string";
      pos++;
      const parts = new CssTextBuffer();
      while (pos < source.length) {
        if (at(pos) === c) {
          pos++;
          break;
        }
        if (newline(at(pos))) {
          kind = "bad-string";
          break;
        }
        if (at(pos) === "\\") {
          if (pos + 1 === source.length) {
            pos++;
            break;
          }
          if (newline(at(pos + 1))) {
            pos++;
            skipNewline();
          } else parts.push(consumeEscape());
        } else {
          const from = pos;
          while (
            pos < source.length &&
            at(pos) !== c &&
            at(pos) !== "\\" &&
            !newline(at(pos)) &&
            at(pos) !== "\0" &&
            !(source.charCodeAt(pos) >= 0xd800 && source.charCodeAt(pos) <= 0xdfff)
          )
            pos++;
          if (pos > from) parts.push(source.slice(from, pos));
          else parts.push(character());
        }
      }
      value = parts.finish();
    } else if (source.startsWith("<!--", pos)) {
      kind = "cdo";
      pos += 4;
    } else if (source.startsWith("-->", pos)) {
      kind = "cdc";
      pos += 3;
    } else if (startsNumber(pos)) {
      kind = "number";
      if (c === "+" || c === "-") pos++;
      while (digit(at(pos))) pos++;
      if (at(pos) === "." && digit(at(pos + 1))) {
        pos += 2;
        while (digit(at(pos))) pos++;
      }
      if (
        (at(pos) === "e" || at(pos) === "E") &&
        (digit(at(pos + 1)) || ((at(pos + 1) === "+" || at(pos + 1) === "-") && digit(at(pos + 2))))
      ) {
        pos++;
        if (at(pos) === "+" || at(pos) === "-") pos++;
        while (digit(at(pos))) pos++;
      }
      if (startsIdent(pos)) {
        kind = "dimension";
        value = name();
      } else if (at(pos) === "%") {
        kind = "percentage";
        pos++;
      }
    } else if (c === "@" && startsIdent(pos + 1)) {
      kind = "at";
      pos++;
      value = name();
    } else if (c === "#" && (nameChar(at(pos + 1)) || validEscape(pos + 1))) {
      kind = "hash";
      pos++;
      value = name();
    } else if (startsIdent(pos)) {
      kind = "ident";
      value = name();
      if (at(pos) === "(") {
        pos++;
        kind = "function";
        if (asciiLower(value) === "url") {
          let look = pos;
          while (space(at(look))) look++;
          if (at(look) !== '"' && at(look) !== "'") {
            pos = look;
            kind = "url";
            const parts = new CssTextBuffer();
            while (pos < source.length) {
              const next = at(pos);
              if (next === ")") {
                pos++;
                break;
              }
              if (space(next)) {
                while (space(at(pos))) pos++;
                if (at(pos) === ")") pos++;
                else if (pos < source.length) {
                  kind = "bad-url";
                  badUrl();
                }
                break;
              }
              if (
                next === '"' ||
                next === "'" ||
                next === "(" ||
                (next.charCodeAt(0) <= 8 && next !== "\0") ||
                next === "\v" ||
                (next.charCodeAt(0) >= 14 && next.charCodeAt(0) <= 31) ||
                next === "\x7f"
              ) {
                kind = "bad-url";
                badUrl();
                break;
              }
              if (next === "\\") {
                if (!validEscape(pos)) {
                  kind = "bad-url";
                  badUrl();
                  break;
                }
                parts.push(consumeEscape());
              } else parts.push(character());
            }
            value = parts.finish();
          }
        }
      }
    } else {
      pos++;
      value = c;
      if (":;,()[]{}".includes(c)) kind = "punct";
      else if (c === "\0") value = "\ufffd";
    }
    yield { kind, start, end: pos, value };
  }
}
