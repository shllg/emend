import { LIMITS } from "@recense/contract";

/** Cut a definition to the contract's length; a cut ends in an ellipsis and never splits a surrogate pair. */
export function limitDefinition(text: string): string {
  if (text.length <= LIMITS.glossaryDefinitionChars) return text;
  let cut = LIMITS.glossaryDefinitionChars - 1;
  if ((text.codePointAt(cut - 1) ?? 0) > 0xffff) cut--;
  return `${text.slice(0, cut)}…`;
}
