export type UpdateSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT";
export const signalExitCodes: Record<UpdateSignal, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 };

/** Keep interruption state through the backup, children, probes and final report. */
export class UpdateSignals {
  interrupted: UpdateSignal | null = null;
  private readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  private readonly handlers = new Map<UpdateSignal, () => void>();

  constructor() {
    for (const signal of Object.keys(signalExitCodes) as UpdateSignal[]) {
      const handler = () => this.receive(signal);
      this.handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  private receive(signal: UpdateSignal) {
    if (this.interrupted !== null) return;
    this.interrupted = signal;
    this.controller.abort();
  }

  dispose() {
    for (const [signal, handler] of this.handlers) process.off(signal, handler);
  }
}
