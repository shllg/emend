/** A text doc is UTF-8 without NUL. Strip one leading BOM in every consumer. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Error("not a text file");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}
