import { type InboxGroup, LIMITS } from "@recense/contract";
import { Ellipsis } from "lucide-react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { mutationMessage, useDeleteGroup, useRenameGroup } from "../../api/mutations.ts";
import { useLayout } from "../../lib/layout.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu } from "../ui/Menu.tsx";
import { TextField } from "../ui/TextField.tsx";
import { useToast } from "../ui/Toast.tsx";

export function GroupActions({
  group,
  compact,
  afterDeleteFocus,
}: {
  group: InboxGroup;
  compact: boolean;
  afterDeleteFocus: RefObject<HTMLInputElement | null>;
}) {
  const phone = useLayout() === "phone";
  const [panel, setPanel] = useState<"rename" | "delete" | null>(null);
  const [name, setName] = useState(group.name);
  const rename = useRenameGroup();
  const remove = useDeleteGroup();
  const pending = rename.isPending || remove.isPending;
  const trigger = useRef<HTMLButtonElement>(null);
  const deleteReturnFocus = useRef<HTMLElement | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const toast = useToast();
  const formId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const close = () => {
    if (!busy.current) setPanel(null);
  };
  const run = async () => {
    if (busy.current || !panel || (panel === "rename" && !name.trim())) return;
    busy.current = true;
    try {
      if (panel === "rename") await rename.mutateAsync({ id: group.id, name });
      else {
        // The inbox refresh may unmount this dialog before mutateAsync returns.
        deleteReturnFocus.current = afterDeleteFocus.current;
        await remove.mutateAsync(group.id);
      }
      if (mounted.current) setPanel(null);
    } catch (error) {
      deleteReturnFocus.current = trigger.current;
      toast.show({ tone: "danger", title: mutationMessage(error as Error) });
    } finally {
      busy.current = false;
    }
  };
  const label = `Actions for group “${group.name}”`;
  return (
    <>
      <Menu
        label={label}
        size={phone ? "lg" : "md"}
        triggerRef={trigger}
        trigger={
          <IconButton
            label={label}
            icon={Ellipsis}
            size={phone ? "lg" : compact ? "sm" : "md"}
            tooltip={false}
            disabled={pending}
          />
        }
        items={[
          {
            label: "Rename group…",
            opensDialog: true,
            onSelect: () => {
              setName(group.name);
              setPanel("rename");
            },
          },
          {
            label: "Delete group…",
            danger: true,
            opensDialog: true,
            onSelect: () => {
              deleteReturnFocus.current = trigger.current;
              setPanel("delete");
            },
          },
        ]}
      />
      <Dialog
        open={panel === "rename"}
        onOpenChange={(next) => !next && close()}
        returnFocus={trigger}
        title="Rename group"
        titleClassName="[overflow-wrap:anywhere]"
        description="Give this group a name."
        actions={
          <>
            <Button disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form={formId} variant="primary" loading={pending} disabled={!name.trim()}>
              Save
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <TextField
            label="Group name"
            dir="auto"
            data-autofocus
            value={name}
            maxLength={LIMITS.groupNameChars}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </form>
      </Dialog>
      <Dialog
        open={panel === "delete"}
        onOpenChange={(next) => !next && close()}
        returnFocus={deleteReturnFocus}
        preferReturnFocus
        title={`Delete group “${group.name}”?`}
        titleClassName="[overflow-wrap:anywhere]"
        description="Its items go back to Active, Snoozed or Done. Nothing else changes."
        actions={
          <>
            <Button data-autofocus disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" loading={pending} onClick={() => void run()}>
              Delete group
            </Button>
          </>
        }
      />
    </>
  );
}
