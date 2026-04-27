import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { loadStoredServer, loadStoredToken } from "../api";

interface Props {
  taskId: string;
  onError: (m: string) => void;
}

/**
 * Embedded terminal view backed by the daemon's WS /pty/:taskId. Uses a
 * dumb shell (TERM=dumb) so it's safe to render full-color ANSI without a
 * real PTY underneath — line-oriented commands work great, full-screen
 * TUIs don't (yet). xterm.js is overkill for that today, but it sets us
 * up to swap to node-pty later without touching the UI.
 */
export function Terminal({ taskId, onError }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12,
      theme: {
        background: "#000000",
        foreground: "#e7e9ee",
        cursor: "#33d27a",
      },
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

    ws.onopen = () => term.write("\r\n[connecting]\r\n");
    ws.onerror = () => onError("pty: connection error");
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as
          | { type: "ready"; cwd: string }
          | { type: "output"; data: string }
          | { type: "exit"; code: number | null };
        if (msg.type === "ready") {
          term.write(`\r\n[connected — ${msg.cwd}]\r\n`);
        } else if (msg.type === "output") {
          term.write(msg.data);
        } else if (msg.type === "exit") {
          term.write(`\r\n[shell exited code=${msg.code ?? "?"}]\r\n`);
        }
      } catch {
        // ignore unparseable
      }
    };
    ws.onclose = () => term.write("\r\n[disconnected]\r\n");

    const dataDisp = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      dataDisp.dispose();
      try {
        ws.close();
      } catch {
        // already closed
      }
      term.dispose();
    };
  }, [taskId, onError]);

  return <div className="term-pane" ref={containerRef} />;
}
