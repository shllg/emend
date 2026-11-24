/** Count the graph structured clone sends, without expanding shared objects or building JSON.
 * Buffer payloads are charged separately when read or before copying for dispatch. */
export function chargePlacementMetadata(value: unknown, charge: (bytes: number) => void): void {
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      charge(Buffer.byteLength(value));
      return;
    }
    if (value === null || typeof value !== "object") {
      charge(8);
      return;
    }
    if (seen.has(value)) return;
    charge(16);
    seen.add(value);
    if (value instanceof ArrayBuffer) return;
    if (value instanceof Map) {
      for (const [key, item] of value) {
        charge(8);
        visit(key);
        visit(item);
      }
    } else if (value instanceof Set || Array.isArray(value)) {
      for (const item of value) {
        charge(8);
        visit(item);
      }
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        charge(8);
        visit(key);
        visit(Reflect.get(value, key));
      }
    }
  };
  visit(value);
}
