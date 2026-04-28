import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { loadStoredServer, loadStoredToken } from "@/api";
import { useTheme } from "@/components/theme-provider";

interface Props {
  taskId: string;
  onError: (m: string) => void;
}

const DARK_THEME = {
  background: "#0a0a0a",
  foreground: "#fafaf9",
  cursor: "#ff5c28",
  selectionBackground: "#ff5c2840",
};
const LIGHT_THEME = {
  background: "#fbf8f1",
  foreground: "#0a0a0a",
  cursor: "#e84416",
  selectionBackground: "#ff5c2840",
};

export function Terminal({ taskId, onError }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { resolved } = useTheme();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize: 12,
      theme: resolved === "dark" ? DARK_THEME : LIGHT_THEME,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    const url = new URL(loadStoredServer());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/pty/${taskId}`;
    const tok = loadStoredToken();
    if (tok) url.searchParams.set("session", tok);
    const ws = new WebSocket(url.toString());

    ws.onopen = () => term.write("\r\n\x1b[2m[connecting]\x1b[0m\r\n");
    ws.onerror = () => onError("pty: connection error");
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as
          | { type: "ready"; cwd: string }
          | { type: "output"; data: string }
          | { type: "exit"; code: number | null };
        if (msg.type === "ready") {
          term.write(
            `\r\n\x1b[33m[connected — ${msg.cwd}]\x1b[0m\r\n`,
          );
        } else if (msg.type === "output") {
          term.write(msg.data);
        } else if (msg.type === "exit") {
          term.write(
            `\r\n\x1b[2m[shell exited code=${msg.code ?? "?"}]\x1b[0m\r\n`,
          );
        }
      } catch {
        // ignore unparseable
      }
    };
    ws.onclose = () => term.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n");

    const dataDisp = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      dataDisp.dispose();
      try {
        ws.close();
      } catch {
        // already closed
      }
      term.dispose();
    };
  }, [taskId, onError, resolved]);

  return (
    <div className="h-full w-full bg-cream-50 dark:bg-ink-900 p-2">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
