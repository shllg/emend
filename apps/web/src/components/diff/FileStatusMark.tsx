import type { FileView } from "@emend/contract";

const statuses = {
  added: { letter: "A", color: "text-success-fg" },
  modified: { letter: "M", color: "text-warning-fg" },
  deleted: { letter: "D", color: "text-danger-fg" },
  renamed: { letter: "R", color: "text-info-fg" },
  "mode-changed": { letter: "T", color: "text-fg-3" },
};

export function FileStatusMark({ status }: { status: FileView["status"] }) {
  const mark = status && statuses[status];
  const name = status?.replaceAll("-", " ");
  return mark ? (
    <span title={name} className={`shrink-0 font-mono text-12 font-semibold ${mark.color}`}>
      <span aria-hidden="true">{mark.letter}</span>
      <span className="sr-only">{name}</span>
    </span>
  ) : null;
}
