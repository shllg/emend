import { type KeyBinding, type SettingsView, SHORTCUT_DEFAULTS, type ShortcutCommand } from "@emend/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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

type Handler = () => boolean;
type Registration = { command: ShortcutCommand; priority: number; handle: Handler; when: () => boolean };

function createRegistry() {
  const entries = new Set<Registration>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => {
    version++;
    for (const listener of listeners) listener();
  };
  return {
    entries,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => version,
    register: (entry: Registration) => {
      entries.add(entry);
      notify();
      return () => {
        entries.delete(entry);
        notify();
      };
    },
  };
}

const emptyRegistry = createRegistry();
const Shortcuts = createContext<ReturnType<typeof createRegistry> | null>(null);

function orderedHandlers(registry: Set<Registration>) {
  return [...registry].reverse().sort((a, b) => b.priority - a.priority);
}

export function useShortcutRunner() {
  const registry = useContext(Shortcuts) ?? emptyRegistry;
  useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  return {
    available: () => new Set([...registry.entries].filter((entry) => entry.when()).map((entry) => entry.command)),
    run: (command: ShortcutCommand) =>
      orderedHandlers(registry.entries).some((entry) => entry.command === command && entry.when() && entry.handle()),
  };
}

export function useShortcutKeys(): Record<ShortcutCommand, KeyBinding> {
  const settings = useQuery(settingsQuery());
  return Object.fromEntries(
    shortcutCommands.map((command) => [
      command,
      settings.data ? settings.data.keys.commands[command].value : SHORTCUT_DEFAULTS[command],
    ]),
  ) as Record<ShortcutCommand, KeyBinding>;
}

export function useShortcut(
  command: ShortcutCommand,
  handler: Handler,
  { enabled = true, priority = 0, when }: { enabled?: boolean; priority?: number; when?: () => boolean } = {},
) {
  const registry = useContext(Shortcuts);
  const latest = useRef({ handler, when });
  useLayoutEffect(() => {
    latest.current = { handler, when };
  });
  useEffect(() => {
    if (!registry || !enabled) return;
    return registry.register({
      command,
      priority,
      handle: () => latest.current.handler(),
      when: () => latest.current.when?.() ?? true,
    });
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
  const [registry] = useState(createRegistry);
  const client = useQueryClient();
  const layout = useLayout();
  const keys = useShortcutKeys();
  const current = useRef(layout);
  useLayoutEffect(() => {
    current.current = layout;
  });
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (current.current === "phone" || ignoreShortcut(event)) return;
      // Cache writes take effect even before React Query's batched render notification.
      const settings = client.getQueryData<SettingsView>(["settings"]);
      const handlers = orderedHandlers(registry.entries);
      for (const entry of handlers) {
        const key = settings ? settings.keys.commands[entry.command].value : SHORTCUT_DEFAULTS[entry.command];
        if (matchesShortcut(event, key) && entry.when() && entry.handle()) {
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
