import { type KeyBinding, type SettingsView, SHORTCUT_DEFAULTS, type ShortcutCommand } from "@emend/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { settingsQuery } from "../api/queries.ts";
import { Button } from "../components/ui/Button.tsx";
import { Dialog } from "../components/ui/Dialog.tsx";
import { Kbd } from "../components/ui/Kbd.tsx";
import { useLayout } from "./layout.ts";
import {
  ignoreShortcut,
  keyLabel,
  matchesShortcut,
  shortcutCommands,
  shortcutGroups,
  shortcutLabels,
} from "./shortcuts.ts";

type Handler = (event: KeyboardEvent) => boolean;
type Registration = { command: ShortcutCommand; priority: number; handle: Handler };
const Shortcuts = createContext<Set<Registration> | null>(null);

export function useShortcut(command: ShortcutCommand, handler: Handler, { enabled = true, priority = 0 } = {}) {
  const registry = useContext(Shortcuts);
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!registry || !enabled) return;
    const entry = { command, priority, handle: (event: KeyboardEvent) => latest.current(event) };
    registry.add(entry);
    return () => {
      registry.delete(entry);
    };
  }, [registry, command, enabled, priority]);
}

function GlobalShortcuts({ keys }: { keys: Record<ShortcutCommand, KeyBinding> }) {
  const router = useRouter();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const [open, setOpen] = useState(false);
  useShortcut(
    "inbox.back",
    () => {
      void router.navigate({ to: "/" });
      return true;
    },
    { enabled: path !== "/" },
  );
  useShortcut("shortcuts.show", () => {
    setOpen(true);
    return true;
  });
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Keyboard shortcuts"
      description={
        <Link to="/settings" onClick={() => setOpen(false)}>
          Change keys in Settings
        </Link>
      }
      actions={
        <Button data-autofocus onClick={() => setOpen(false)}>
          Close
        </Button>
      }
    >
      {shortcutGroups.map((group) => (
        <section key={group.label} className="mt-4">
          <h3 className="text-14 font-semibold">{group.label}</h3>
          <dl className="mt-2 space-y-2 text-14">
            {group.commands.map((command) => (
              <div key={command} className="flex items-center justify-between gap-3">
                <dt>{shortcutLabels[command]}</dt>
                <dd>{keys[command] === null ? "Off" : <Kbd>{keyLabel(keys[command])}</Kbd>}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <p className="mt-4 text-14">⌘↵ / Ctrl ↵: save a comment, or send from the instructions field</p>
      <p className="mt-2 text-14">Esc: close a composer, a dialog or a menu</p>
    </Dialog>
  );
}

/** The app's only global shortcut listener. Components only register local actions. */
export function ShortcutProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new Set<Registration>());
  const client = useQueryClient();
  const layout = useLayout();
  const settings = useQuery(settingsQuery());
  const keys = Object.fromEntries(
    shortcutCommands.map((command) => [
      command,
      settings.data ? settings.data.keys.commands[command].value : SHORTCUT_DEFAULTS[command],
    ]),
  ) as Record<ShortcutCommand, KeyBinding>;
  const current = useRef(layout);
  useLayoutEffect(() => {
    current.current = layout;
  });
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (current.current === "phone" || ignoreShortcut(event)) return;
      // Cache writes take effect even before React Query's batched render notification.
      const settings = client.getQueryData<SettingsView>(["settings"]);
      const handlers = [...registry].reverse().sort((a, b) => b.priority - a.priority);
      for (const entry of handlers) {
        const key = settings ? settings.keys.commands[entry.command].value : SHORTCUT_DEFAULTS[entry.command];
        if (matchesShortcut(event, key) && entry.handle(event)) {
          event.preventDefault();
          break;
        }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [registry, client]);
  return (
    <Shortcuts value={registry}>
      {children}
      <GlobalShortcuts keys={keys} />
    </Shortcuts>
  );
}
