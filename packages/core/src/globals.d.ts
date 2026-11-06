export {};

// Standard globals shared by Node and browsers, limited to core's actual use.
declare global {
  var crypto: {
    readonly subtle: {
      digest(algorithm: "SHA-256", data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
    };
  };

  class TextEncoder {
    encode(input: string): Uint8Array<ArrayBuffer>;
  }

  class TextDecoder {
    constructor(label?: "utf-8", options?: { fatal?: boolean; ignoreBOM?: boolean });
    decode(input: Uint8Array): string;
  }

  class URLSearchParams {
    constructor(init: Record<string, string>);
    toString(): string;
  }

  class URL {
    constructor(input: string);
    readonly protocol: string;
  }
}
