import type { RenderedBlock } from "@recense/contract";
import type { Block } from "./blocks.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Adding a kind on only one side fails pnpm typecheck.
export const blockKindsMatch: Equal<Block["kind"], RenderedBlock["kind"]> = true;
// @ts-expect-error A kind the contract does not list is not a block kind.
export const unlistedKind: Block["kind"] = "script";
