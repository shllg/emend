/** Bypass Vitest's console reporter so each measurement remains one JSON line. */
export function emitBench(measurement: { bench: string } & Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(measurement)}\n`);
}
