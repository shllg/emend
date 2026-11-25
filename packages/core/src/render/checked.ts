import type { RenderedBlock, RenderedWriteup } from "@recense/contract";

/** A missing reference can be skipped. If metadata leaves any visible block out, show the plain section. */
export function checkedProofs(metadata: RenderedWriteup["checked"], blocks: RenderedBlock[] | undefined) {
  if (!metadata || !blocks) return undefined;
  const unclaimed = new Map(blocks.map((block) => [block.id, block]));
  const proofs = metadata.map(({ kind, blockIds }) => ({
    kind,
    blocks: blockIds.flatMap((id) => {
      const block = unclaimed.get(id);
      if (!block) return [];
      unclaimed.delete(id);
      return [block];
    }),
  }));
  return unclaimed.size ? undefined : proofs;
}
