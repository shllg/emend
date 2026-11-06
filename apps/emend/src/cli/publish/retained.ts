import { createHash } from "node:crypto";
import { LIMITS } from "@emend/contract";
import { CliError } from "../http.ts";

/** Share checked bytes across source docs and assets without retaining duplicate content. */
export class RetainedSources {
  private sources = new Map<string, Buffer>();
  private blobs = new Map<string, Buffer>();
  private size = 0;

  get(source: string) {
    return this.sources.get(source);
  }

  keep(source: string, bytes: Buffer): Buffer {
    const hash = createHash("sha256").update(bytes).digest("hex");
    let retained = this.blobs.get(hash);
    if (!retained) {
      if (this.size + bytes.length > LIMITS.revisionBytes) throw new CliError("the docs pass the revision size limit");
      this.size += bytes.length;
      retained = bytes;
      this.blobs.set(hash, retained);
    }
    this.sources.set(source, retained);
    return retained;
  }
}
