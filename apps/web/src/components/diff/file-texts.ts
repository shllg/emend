import { createContext, use } from "react";
import { getText } from "../../api/client.ts";

export type FileTexts = (id: string, side: "old" | "new", signal?: AbortSignal) => Promise<string>;
export type FileTextSource = { scope: string; read: FileTexts };
export const FileTextsContext = createContext<FileTextSource>({
  scope: "reviews",
  read: (id, side, signal) => getText(`/api/v1/files/${encodeURIComponent(id)}/${side}`, signal),
});
export const useFileTexts = () => use(FileTextsContext);

export function fileSideQuery(id: string, side: "old" | "new", source: FileTextSource) {
  return {
    queryKey: ["file", source.scope, id, side],
    queryFn: ({ signal }: { signal: AbortSignal }) => source.read(id, side, signal),
    staleTime: Infinity,
  };
}
