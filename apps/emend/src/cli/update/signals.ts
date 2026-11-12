/** Keep interruption state through the backup, children, probes and final report. */
export class UpdateSignals {
  interrupted: "SIGINT" | "SIGTERM" | null = null;
  private readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  private readonly onInterrupt = () => this.receive("SIGINT");
  private readonly onTerminate = () => this.receive("SIGTERM");

  constructor() {
    process.on("SIGINT", this.onInterrupt);
    process.on("SIGTERM", this.onTerminate);
  }

  private receive(signal: "SIGINT" | "SIGTERM") {
    if (this.interrupted !== null) return;
    this.interrupted = signal;
    this.controller.abort();
  }

  dispose() {
    process.off("SIGINT", this.onInterrupt);
    process.off("SIGTERM", this.onTerminate);
  }
}
