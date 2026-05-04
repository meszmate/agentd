import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";

const GROUPS: { heading: string; items: { keys: string[]; label: string }[] }[] = [
  {
    heading: "Global",
    items: [
      { keys: ["⌘", "K"], label: "Open command palette" },
      { keys: ["⌘", "N"], label: "New task" },
      { keys: ["?"], label: "Show this help" },
      { keys: ["/"], label: "Focus chat input" },
    ],
  },
  {
    heading: "Navigate",
    items: [
      { keys: ["g", "h"], label: "Home" },
      { keys: ["g", "t"], label: "Tasks" },
      { keys: ["g", "e"], label: "Templates" },
      { keys: ["g", "s"], label: "Schedules" },
      { keys: ["g", "k"], label: "Skills" },
      { keys: ["g", "r"], label: "Terminal" },
      { keys: ["g", "a"], label: "Activity" },
      { keys: ["g", "p"], label: "Plugins" },
      { keys: ["g", "d"], label: "Devices" },
      { keys: ["g", ","], label: "Settings" },
    ],
  },
  {
    heading: "Vim list movements",
    items: [
      { keys: ["j"], label: "Next row in current list" },
      { keys: ["k"], label: "Previous row" },
      { keys: ["g", "g"], label: "First row" },
      { keys: ["G"], label: "Last row" },
      { keys: ["↵"], label: "Activate focused row" },
    ],
  },
  {
    heading: "Chat",
    items: [
      { keys: ["⌘", "↵"], label: "Send message" },
      { keys: ["esc"], label: "Blur input" },
    ],
  },
];

export function HelpOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Vim-style sequences and chords.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.heading}>
              <div className="label-section mb-2">{g.heading}</div>
              <ul className="space-y-1.5">
                {g.items.map((it) => (
                  <li
                    key={it.label}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="text-ink-700 dark:text-ink-200">
                      {it.label}
                    </span>
                    <span className="flex items-center gap-1">
                      {it.keys.map((k, i) => (
                        <Kbd key={`${k}-${i}`}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
