import type { Context, Next } from "hono";
import { resolveSession, type Db } from "@agentd/core";

export const SESSION_HEADER = "x-agentd-session";

type RequestIpServer = {
  requestIP?: (req: Request) => { address?: string | null } | null;
};

export interface AuthOptions {
  noAuth?: boolean;
  trustTailnetAuth?: boolean;
}

export function bearerOrHeader(c: Context): string | null {
  const header = c.req.header(SESSION_HEADER);
  if (header) return header;
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const url = new URL(c.req.url);
  const q = url.searchParams.get("session");
  if (q) return q;
  return null;
}

function requestAddress(
  req: Request,
  server: RequestIpServer | null | undefined,
): string | null {
  try {
    return server?.requestIP?.(req)?.address ?? null;
  } catch {
    return null;
  }
}

export function isTailnetAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    const c = Number(ipv4[3]);
    const d = Number(ipv4[4]);
    if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return false;
    }
    // Tailscale IPv4 addresses live in 100.64.0.0/10.
    return a === 100 && b >= 64 && b <= 127;
  }
  // Tailscale IPv6 ULA prefix.
  return normalized.startsWith("fd7a:115c:a1e0:");
}

export function isTrustedTailnetRequest(
  req: Request,
  server: RequestIpServer | null | undefined,
): boolean {
  return isTailnetAddress(requestAddress(req, server));
}

export function requireSession(db: Db, opts: AuthOptions = {}) {
  return async (c: Context, next: Next) => {
    if (opts.noAuth) {
      c.set("session", {
        sessionId: "no-auth",
        deviceLabel: "No Auth",
      });
      await next();
      return;
    }
    const token = bearerOrHeader(c);
    const env = c.env as { server?: RequestIpServer };
    const trustedTailnet =
      opts.trustTailnetAuth && isTrustedTailnetRequest(c.req.raw, env.server);
    if (token) {
      const session = resolveSession(db, token);
      if (session) {
        c.set("session", session);
        await next();
        return;
      }
      if (!trustedTailnet) {
        return c.json({ error: "invalid session" }, 401);
      }
    }
    if (trustedTailnet) {
      c.set("session", {
        sessionId: "trusted-tailnet",
        deviceLabel: "Trusted Tailnet",
      });
      await next();
      return;
    }
    return c.json({ error: "missing session token" }, 401);
  };
}
