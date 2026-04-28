import { useEffect, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { useApp } from "@/AppContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function deriveHostInitials(server: string): string {
  try {
    const u = new URL(server);
    const h = u.hostname || "agentd";
    if (h === "localhost" || h === "127.0.0.1") return "LO";
    const parts = h.split(".").filter(Boolean);
    if (parts.length === 0) return h.slice(0, 2).toUpperCase();
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  } catch {
    return "AG";
  }
}

function shortHost(server: string): string {
  try {
    const u = new URL(server);
    const port = u.port ? `:${u.port}` : "";
    return `${u.hostname}${port}`;
  } catch {
    return server;
  }
}

export function ServerCard() {
  const { client, server, logout } = useApp();
  const [healthy, setHealthy] = useState<"ok" | "fail" | "checking">(
    "checking",
  );
  const [latency, setLatency] = useState<number | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const ping = async () => {
      const t0 = performance.now();
      try {
        const h = await client.health();
        if (cancelled) return;
        setHealthy("ok");
        setVersion(h.version);
        setLatency(Math.round(performance.now() - t0));
      } catch {
        if (cancelled) return;
        setHealthy("fail");
        setLatency(null);
      }
      if (!cancelled) timer = setTimeout(ping, 8000);
    };
    void ping();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client]);

  const initials = deriveHostInitials(server);
  const host = shortHost(server);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="mx-2 flex w-[calc(100%-1rem)] items-center gap-2.5 rounded-lg border border-ink-900/10 bg-cream-50 px-2 py-1.5 text-left transition-colors hover:bg-ink-900/[0.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-vermilion-500/30 dark:border-ink-50/10 dark:bg-ink-800 dark:hover:bg-ink-50/[0.03]"
          aria-label="Server menu"
        >
          <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-vermilion-500 font-mono text-2xs font-bold text-cream-50">
            {initials}
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-cream-50 dark:ring-ink-800",
                healthy === "ok" && "bg-emerald-500",
                healthy === "fail" && "bg-red-500",
                healthy === "checking" && "bg-ink-300",
              )}
              aria-hidden
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-ink-900 dark:text-ink-50">
              {host}
            </span>
            <span className="block truncate font-mono text-2xs text-ink-500 dark:text-ink-400">
              {healthy === "ok"
                ? `${latency ?? "—"}ms${version ? ` · v${version}` : ""}`
                : healthy === "fail"
                ? "offline"
                : "checking…"}
            </span>
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-ink-400 dark:text-ink-500" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[14rem]">
        <DropdownMenuLabel>Server</DropdownMenuLabel>
        <div className="px-2 py-1 font-mono text-2xs text-ink-500 break-all dark:text-ink-400">
          {server}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={logout}
          className="text-red-700 focus:text-red-700 dark:text-red-300 dark:focus:text-red-300"
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
