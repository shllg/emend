import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useFileTexts } from "../components/diff/file-texts.ts";
import type { DiffCounts } from "../components/diff/presentation.ts";

const emptyCounts = new Map<string, DiffCounts>();
/** File ids identify immutable contents within a source; keep their small counts for this session. */
export function useDiffCounts() {
  const client = useQueryClient();
  const { scope } = useFileTexts();
  const { data: counts } = useQuery({
    queryKey: ["diff-counts", scope],
    queryFn: skipToken,
    initialData: () => new Map<string, DiffCounts>(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const onParsed = useCallback(
    (id: string, count: DiffCounts) => {
      client.setQueryData<Map<string, DiffCounts>>(["diff-counts", scope], (previous = new Map()) => {
        const old = previous.get(id);
        return old?.additions === count.additions && old.deletions === count.deletions
          ? previous
          : new Map(previous).set(id, count);
      });
    },
    [client, scope],
  );
  return { counts: counts ?? emptyCounts, onParsed };
}
