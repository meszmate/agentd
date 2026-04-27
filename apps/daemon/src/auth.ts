import type { Context, Next } from "hono";
import { resolveSession, type Db } from "@agentd/core";

export const SESSION_HEADER = "x-agentd-session";

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

export function requireSession(db: Db) {
  return async (c: Context, next: Next) => {
    const token = bearerOrHeader(c);
    if (!token) return c.json({ error: "missing session token" }, 401);
    const session = resolveSession(db, token);
    if (!session) return c.json({ error: "invalid session" }, 401);
    c.set("session", session);
    await next();
  };
}
