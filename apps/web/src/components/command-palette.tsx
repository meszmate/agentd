import { useNavigate } from "react-router-dom";
import {
  Activity,
  CalendarClock,
  FileTerminal,
  HelpCircle,
  Home,
  Inbox,
  LogOut,
  Plug,
  Plus,
  Settings as SettingsIcon,
  Smartphone,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { StatusDot } from "@/components/ui/status-dot";
import { useApp } from "@/AppContext";
import { useTasks, useTemplates, useSchedules } from "@/queries";
import { shortId } from "@/lib/utils";

export function CommandPalette({
  open,
  onClose,
  onSpawn,
  onHelp,
}: {
  open: boolean;
  onClose: () => void;
  onSpawn: () => void;
  onHelp: () => void;
}) {
  const navigate = useNavigate();
  const { logout } = useApp();
  const tasksQ = useTasks();
  const templatesQ = useTemplates();
  const schedulesQ = useSchedules();

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  return (
    <CommandDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <CommandInput placeholder="Type a command or search…" autoFocus />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() => {
              onClose();
              onSpawn();
            }}
          >
            <Plus />
            <span>New task</span>
            <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              onClose();
              onHelp();
            }}
          >
            <HelpCircle />
            <span>Show keyboard help</span>
            <CommandShortcut>?</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              onClose();
              logout();
            }}
          >
            <LogOut />
            <span>Sign out</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Navigate">
          <CommandItem onSelect={() => go("/home")}>
            <Home />
            <span>Home</span>
            <CommandShortcut>g h</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/tasks")}>
            <Inbox />
            <span>Tasks</span>
            <CommandShortcut>g t</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/templates")}>
            <FileTerminal />
            <span>Templates</span>
            <CommandShortcut>g e</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/schedules")}>
            <CalendarClock />
            <span>Schedules</span>
            <CommandShortcut>g s</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/activity")}>
            <Activity />
            <span>Activity</span>
            <CommandShortcut>g a</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/plugins")}>
            <Plug />
            <span>Plugins</span>
            <CommandShortcut>g p</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/devices")}>
            <Smartphone />
            <span>Devices</span>
            <CommandShortcut>g d</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/settings")}>
            <SettingsIcon />
            <span>Settings</span>
            <CommandShortcut>g ,</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        {!!tasksQ.data?.tasks.length && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Tasks">
              {tasksQ.data.tasks.slice(0, 8).map((t) => (
                <CommandItem
                  key={t.id}
                  value={`task ${t.title} ${t.id}`}
                  onSelect={() => go(`/tasks/${t.id}`)}
                >
                  <StatusDot status={t.status} size="sm" />
                  <span className="truncate">{t.title}</span>
                  <CommandShortcut>{shortId(t.id)}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {!!templatesQ.data?.templates.length && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Templates">
              {templatesQ.data.templates.slice(0, 8).map((tpl) => (
                <CommandItem
                  key={tpl.id}
                  value={`template ${tpl.name}`}
                  onSelect={() => go("/templates")}
                >
                  <FileTerminal />
                  <span>{tpl.name}</span>
                  <CommandShortcut>{tpl.agent}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {!!schedulesQ.data?.schedules.length && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Schedules">
              {schedulesQ.data.schedules.slice(0, 8).map((s) => (
                <CommandItem
                  key={s.id}
                  value={`schedule ${s.name} ${s.cron}`}
                  onSelect={() => go("/schedules")}
                >
                  <CalendarClock />
                  <span>{s.name}</span>
                  <CommandShortcut>{s.cron}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
