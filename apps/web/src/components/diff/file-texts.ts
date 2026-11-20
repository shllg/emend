import { createContext, use } from "react";
import { getText } from "../../api/client.ts";

export type FileTexts = (id: string, side: "old" | "new", signal?: AbortSignal) => Promise<string>;
export const FileTextsContext = createContext<FileTexts>((id, side, signal) =>
  getText(`/api/v1/files/${encodeURIComponent(id)}/${side}`, signal),
);
export const useFileTexts = () => use(FileTextsContext);
