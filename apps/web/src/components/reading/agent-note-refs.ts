import type { FileView } from "@recense/contract";
import { type RefObject, useLayoutEffect } from "react";
import type { ReaderGroup } from "./BlockReader.tsx";

export function useAgentNoteRefs(
  root: RefObject<HTMLElement | null>,
  groups: ReaderGroup[],
  files: FileView[],
  onNote?: (id: string) => void,
) {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !onNote) return;
    const upgraded = new Map<HTMLElement, string>();
    const byTopic = new Map<string, Map<string, { id: string; path: string }>>();
    for (const file of files) {
      if (file.role !== "diff" || !file.topic) continue;
      const refs = byTopic.get(file.topic) ?? new Map();
      for (const note of file.notes ?? []) if (note.ref) refs.set(note.ref, { id: note.id, path: file.path });
      byTopic.set(file.topic, refs);
    }
    for (const group of groups) {
      const refs = group.topic && byTopic.get(group.topic.slug);
      if (!refs || group.path) continue;
      for (const block of [...group.blocks, ...(group.subsections?.flatMap((section) => section.blocks) ?? [])]) {
        const rendered = document.getElementById(`block-${block.id}`);
        if (!rendered || !element.contains(rendered)) continue;
        for (const span of rendered.querySelectorAll<HTMLElement>("span.user-content-ref")) {
          const text = span.textContent ?? "";
          const ref = text.length === 5 ? /^ref ([A-Z])$/.exec(text)?.[1] : undefined;
          const note = ref && refs.get(ref);
          if (!note) continue;
          span.setAttribute("role", "button");
          span.setAttribute("tabindex", "0");
          span.setAttribute("aria-label", `Go to agent note ${ref} in ${note.path}`);
          span.setAttribute("data-agent-note-ref", note.id);
          upgraded.set(span, note.id);
        }
      }
    }
    // Dispatch from a map built from React state. Never trust author-provided attributes.
    const activate = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
      let node = event.target instanceof HTMLElement ? event.target : null;
      while (node && node !== element) {
        const id = upgraded.get(node);
        if (id) {
          event.preventDefault();
          onNote(id);
          return;
        }
        node = node.parentElement;
      }
    };
    element.addEventListener("click", activate);
    element.addEventListener("keydown", activate);
    return () => {
      element.removeEventListener("click", activate);
      element.removeEventListener("keydown", activate);
      for (const span of upgraded.keys())
        for (const attr of ["role", "tabindex", "aria-label", "data-agent-note-ref"]) span.removeAttribute(attr);
    };
  }, [root, groups, files, onNote]);
}
