export class CliError extends Error {
  readonly sandboxStateDir?: string;
  constructor(message: string, sandboxStateDir?: string) {
    super(message);
    this.sandboxStateDir = sandboxStateDir;
  }
}
