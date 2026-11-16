import { History } from "lucide-react";
import { Icon } from "../ui/Icon.tsx";

export function ChangedMarker({ revision }: { revision: number }) {
  return (
    <span className="inline-flex h-5 items-center gap-[5px] whitespace-nowrap rounded-sm bg-changed-bg pr-[7px] pl-1.5 font-mono text-[11.5px] font-medium leading-none text-changed-fg">
      <Icon icon={History} size={11} />
      <span aria-hidden="true">Changed in rev {revision}</span>
      <span className="sr-only">Changed in revision {revision}</span>
    </span>
  );
}
