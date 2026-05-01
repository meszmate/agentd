import { useShortcuts } from "@/useKeyboard";

export function KeyboardShortcuts({
  onPalette,
  onHelp,
  onSpawn,
  onNavigate,
}: {
  onPalette: () => void;
  onHelp: () => void;
  onSpawn: () => void;
  onNavigate: (path: string) => void;
}) {
  useShortcuts(
    [
      { key: "ctrl+k", handler: onPalette, allowInEditable: true, describe: "Open command palette" },
      { key: "cmd+k", handler: onPalette, allowInEditable: true },
      { key: "ctrl+n", handler: onSpawn, allowInEditable: true, describe: "New task" },
      { key: "cmd+n", handler: onSpawn, allowInEditable: true },
      { key: "?", handler: onHelp, describe: "Help" },
      {
        key: "/",
        handler: () => {
          const el = document.querySelector<HTMLInputElement>(
            "[data-shortcut-target=\"chat-input\"]",
          );
          if (el) {
            el.focus();
          } else {
            onPalette();
          }
        },
        describe: "Focus input or open palette",
      },
    ],
    {
      gh: () => onNavigate("/home"),
      gt: () => onNavigate("/tasks"),
      ge: () => onNavigate("/templates"),
      gs: () => onNavigate("/schedules"),
      gk: () => onNavigate("/skills"),
      gw: () => onNavigate("/tools"),
      gr: () => onNavigate("/terminal"),
      ga: () => onNavigate("/activity"),
      gp: () => onNavigate("/plugins"),
      gd: () => onNavigate("/devices"),
      "g,": () => onNavigate("/settings"),
      "g?": () => onHelp(),
    },
  );

  return null;
}
