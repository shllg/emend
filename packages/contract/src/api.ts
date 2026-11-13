import { z } from "zod";
import { LIMITS } from "./limits.ts";
import { FilePath } from "./review.ts";

export const API_PREFIX = "/api/v1";
export function reviewDownloadPath(reviewId: string, seq: number): string {
  return `${API_PREFIX}/reviews/${encodeURIComponent(reviewId)}/revisions/${seq}/download`;
}

export const MIN_CLIENT_VERSION = "0.1.0";

export const SERVER_CHALLENGE_HEADER = "X-Emend-Challenge";
export const SERVER_PROOF_HEADER = "X-Emend-Proof";
// Exactly 32 bytes, including the canonical zero padding bits in the final character.
export const ServerChallenge = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const ServerProof = ServerChallenge;
export type ServerChallenge = z.infer<typeof ServerChallenge>;
export type ServerProof = z.infer<typeof ServerProof>;

export const Capabilities = z.object({
  api: z.literal(1),
  version: z.string().min(1).max(LIMITS.versionChars),
  features: z.array(z.string().max(LIMITS.featureChars)).max(LIMITS.featuresCount),
});
export type Capabilities = z.infer<typeof Capabilities>;

export const ViewedRequest = z.object({
  revision: z.int().positive(),
  paths: z.array(FilePath).min(1).max(LIMITS.filesPerRevision),
  viewed: z.boolean(),
});
export type ViewedRequest = z.infer<typeof ViewedRequest>;

export const ServerStopRequest = z.strictObject({});
export const ServerStopping = z.object({ stopping: z.literal(true) });
export type ServerStopping = z.infer<typeof ServerStopping>;

export const PairingPurpose = z.enum(["device", "machine"]);
export type PairingPurpose = z.infer<typeof PairingPurpose>;
export const PairingRequest = z.object({ purpose: PairingPurpose.default("device") });
export type PairingRequest = z.infer<typeof PairingRequest>;

const PairingSecret = z
  .string()
  .length(47)
  .regex(/^emp_[A-Za-z0-9_-]{43}$/);
const PairingCode = z
  .string()
  .min(8)
  .max(9)
  .regex(/^[0-9A-HJKMNP-TV-ZILO]{4}-?[0-9A-HJKMNP-TV-ZILO]{4}$/i)
  .transform((value) => value.toUpperCase().replaceAll("-", "").replaceAll(/[IL]/g, "1").replaceAll("O", "0"));

export const SessionRequest = z.union([
  z.object({ secret: PairingSecret, code: z.never().optional() }),
  z.object({ code: PairingCode, secret: z.never().optional() }),
]);
export type SessionRequest = z.infer<typeof SessionRequest>;

export const PairingCreated = z.object({
  url: z
    .url({ protocol: /^https?$/ })
    .max(LIMITS.pathChars)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.pathname === "/pair" &&
        value.endsWith(`/pair${url.hash}`) &&
        !url.search &&
        !url.username &&
        !url.password &&
        PairingSecret.safeParse(url.hash.slice(1)).success
      );
    }),
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
  expiresAt: z.iso.datetime(),
});
export type PairingCreated = z.infer<typeof PairingCreated>;

export const MachineRegistration = z.union(
  SessionRequest.options.map((option) =>
    option.extend({
      instance: z.object({
        id: z.uuid(),
        name: z
          .string()
          .regex(/^[a-zA-Z0-9 ._()/;-]*$/)
          .trim()
          .min(1)
          .max(200),
      }),
    }),
  ),
);
export type MachineRegistration = z.infer<typeof MachineRegistration>;
export const MachineRegistered = z.object({
  token: z.string().regex(/^em_[A-Za-z0-9_-]{43}$/),
  hub: z.object({ id: z.uuid(), name: z.string(), url: z.url({ protocol: /^https?$/ }) }),
});
export type MachineRegistered = z.infer<typeof MachineRegistered>;
