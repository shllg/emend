import { Link, useRouter } from "@tanstack/react-router";
import {
  ChevronLeft,
  Download,
  Ellipsis,
  FileDown,
  Inbox,
  Link as LinkIcon,
  MessageSquarePlus,
  QrCode,
  RefreshCw,
  RotateCw,
  Settings,
  Smartphone,
} from "lucide-react";
import { type ComponentProps, type CSSProperties, type ReactNode, useRef } from "react";
import { useAppUpdate } from "../../lib/app-update.ts";
import { useLayout } from "../../lib/layout.ts";
import { layoutStore, useLayoutPreferences } from "../../lib/layout-store.ts";
import { requestPairingFromLink } from "../../lib/pairing-intent.ts";
import { useRefresh } from "../../lib/refresh.ts";
import { ShortcutProvider } from "../../lib/use-shortcut.tsx";
import { textSizeItems } from "../review/LayoutControls.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, type MenuItem } from "../ui/Menu.tsx";
import { useToast } from "../ui/Toast.tsx";
import { cn } from "../ui/utils.ts";
import { UpdateGateContext, useUpdateGate } from "./UpdateGate.tsx";

export function AppFrame(props: ComponentProps<typeof AppFrameContent>) {
  return (
    <ShortcutProvider>
      <AppFrameContent {...props} />
    </ShortcutProvider>
  );
}

function AppFrameContent({
  isReview = false,
  children,
  onCommentReview,
  downloadHref,
}: {
  isReview?: boolean;
  children: ReactNode;
  onCommentReview?: () => void;
  downloadHref?: string;
}) {
  const layout = useLayout();
  const preferences = useLayoutPreferences();
  const router = useRouter();
  const toast = useToast();
  const { refresh, busy } = useRefresh();
  const update = useAppUpdate();
  // The phone menu's trigger: the update dialog it can open returns focus there.
  const moreRef = useRef<HTMLButtonElement>(null);
  const gate = useUpdateGate(moreRef);
  const updateItems: MenuItem[] =
    update.state === "available"
      ? [{ label: "Update available", icon: Download, opensDialog: true, onSelect: () => gate.request("update") }]
      : update.state === "reload-needed"
        ? [
            {
              label: "Reload to finish the update",
              icon: RotateCw,
              opensDialog: true,
              onSelect: () => gate.request("reload"),
            },
          ]
        : [];
  const refreshItem: MenuItem = { label: "Refresh", icon: RefreshCw, disabled: busy, onSelect: () => void refresh() };
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.origin + location.pathname + location.search);
      toast.show({ title: "Link copied" });
    } catch {
      toast.show({ title: "Could not copy the link. Copy it from the address bar.", tone: "danger" });
    }
  }
  const devices: MenuItem = {
    label: "Devices",
    icon: Smartphone,
    asChild: true,
    children: <Link to="/devices">Devices</Link>,
  };
  const settings: MenuItem = {
    label: "Settings",
    icon: Settings,
    asChild: true,
    children: <Link to="/settings">Settings</Link>,
  };
  const menuItems: MenuItem[] = isReview
    ? [
        ...updateItems,
        refreshItem,
        { label: "Copy link", icon: LinkIcon, onSelect: () => void copyLink() },
        ...(onCommentReview
          ? [{ label: "Comment on review", icon: MessageSquarePlus, onSelect: onCommentReview }]
          : []),
        ...(downloadHref
          ? [
              {
                label: "Download",
                icon: FileDown,
                asChild: true,
                children: (
                  <a href={downloadHref} download>
                    Download
                  </a>
                ),
              },
            ]
          : []),
        { separator: true },
        ...textSizeItems(preferences),
        { heading: "Long lines" },
        {
          radioGroup: {
            label: "Long lines",
            segmented: true,
            value: preferences.wrap ? "wrap" : "scroll",
            onValueChange: (value) => {
              if (value === "scroll" || value === "wrap") layoutStore.update({ wrap: value === "wrap" });
            },
            items: [
              { value: "scroll", label: "Scroll" },
              { value: "wrap", label: "Wrap" },
            ],
          },
        },
        { separator: true },
        { label: "Inbox", icon: Inbox, asChild: true, children: <Link to="/">Inbox</Link> },
        devices,
        settings,
      ]
    : [
        ...updateItems,
        refreshItem,
        devices,
        settings,
        {
          label: "Pair a device",
          icon: QrCode,
          asChild: true,
          children: (
            <Link to="/devices/pair" onClick={(event) => requestPairingFromLink(event, router.history.location)}>
              Pair a device
            </Link>
          ),
        },
      ];
  return (
    <div
      className="em-app flex h-dvh min-h-0 flex-col bg-app"
      style={
        {
          "--reader-prose-size": `${preferences.proseSize}px`,
          "--reader-code-size": `${preferences.codeSize}px`,
        } as CSSProperties
      }
    >
      <header
        className={cn(
          "flex shrink-0 items-center justify-between border-b border-line-1 bg-app pr-2 pl-4",
          layout === "phone"
            ? "h-[calc(var(--topbar-h)+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]"
            : "h-(--topbar-h)",
        )}
      >
        {layout === "phone" && isReview ? (
          <Link
            to="/"
            className="inline-flex min-h-11 items-center gap-1 text-13 font-medium text-fg-2 no-underline hover:text-fg-1"
          >
            <Icon icon={ChevronLeft} size={20} />
            Inbox
          </Link>
        ) : (
          <Link
            to="/"
            className="font-mono text-14 font-medium leading-none font-stretch-mono text-fg-3 no-underline hover:text-fg-1"
          >
            emend
          </Link>
        )}
        {layout === "phone" ? (
          <Menu
            label="More"
            size="lg"
            triggerRef={moreRef}
            trigger={<IconButton label="More" icon={Ellipsis} size="lg" tooltip={false} />}
            items={menuItems}
          />
        ) : (
          <div className="flex items-center">
            <IconButton
              label="Refresh"
              icon={RefreshCw}
              aria-busy={busy}
              className={busy ? "[&>svg]:animate-spin" : undefined}
              onClick={() => void refresh()}
            />
            <IconButton label="Devices" icon={Smartphone} asChild>
              <Link to="/devices" />
            </IconButton>
            <IconButton label="Settings" icon={Settings} asChild>
              <Link to="/settings" />
            </IconButton>
          </div>
        )}
      </header>
      <div role="status">
        {update.state === "reload-needed" && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line-1 bg-sunken py-1.5 pr-2 pl-4 text-13 text-fg-2">
            <p>emend was updated in another window. Reload to keep working.</p>
            <Button size="sm" icon={RotateCw} onClick={() => gate.request("reload")}>
              Reload
            </Button>
          </div>
        )}
      </div>
      <UpdateGateContext.Provider value={gate.request}>{children}</UpdateGateContext.Provider>
      {gate.dialog}
    </div>
  );
}
