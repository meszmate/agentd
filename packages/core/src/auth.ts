import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import { pairingTokens, sessions } from "./db.ts";

const PAIRING_TOKEN_BYTES = 24;
const SESSION_TOKEN_BYTES = 32;
const PAIRING_TTL_MS = 10 * 60 * 1000;

export function newId(prefix = ""): string {
  const id = randomBytes(8).toString("hex");
  return prefix ? `${prefix}_${id}` : id;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface IssuedPairing {
  token: string;
  expiresAt: number;
}

export function issuePairingToken(db: Db): IssuedPairing {
  const token = randomBytes(PAIRING_TOKEN_BYTES).toString("base64url");
  const now = Date.now();
  const expiresAt = now + PAIRING_TTL_MS;
  db.insert(pairingTokens)
    .values({
      id: newId("pair"),
      tokenHash: sha256(token),
      createdAt: now,
      expiresAt,
      consumedAt: null,
    })
    .run();
  return { token, expiresAt };
}

export interface ExchangeResult {
  sessionToken: string;
  sessionId: string;
  expiresAt: number;
}

export function exchangePairingToken(
  db: Db,
  pairingToken: string,
  deviceLabel: string,
): ExchangeResult {
  const hash = sha256(pairingToken);
  const row = db
    .select()
    .from(pairingTokens)
    .where(eq(pairingTokens.tokenHash, hash))
    .get();
  if (!row) throw new Error("invalid pairing token");
  if (row.consumedAt) throw new Error("pairing token already used");
  if (row.expiresAt < Date.now()) throw new Error("pairing token expired");

  const now = Date.now();
  db.update(pairingTokens)
    .set({ consumedAt: now })
    .where(eq(pairingTokens.id, row.id))
    .run();

  const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const sessionId = newId("sess");
  db.insert(sessions)
    .values({
      id: sessionId,
      tokenHash: sha256(sessionToken),
      deviceLabel,
      createdAt: now,
      expiresAt: null,
      lastSeenAt: now,
    })
    .run();
  return { sessionToken, sessionId, expiresAt: 0 };
}

export interface ResolvedSession {
  sessionId: string;
  deviceLabel: string;
}

export function resolveSession(db: Db, token: string): ResolvedSession | null {
  if (!token) return null;
  const hash = sha256(token);
  const row = db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, hash))
    .get();
  if (!row) return null;
  if (row.expiresAt && row.expiresAt < Date.now()) return null;
  db.update(sessions)
    .set({ lastSeenAt: Date.now() })
    .where(eq(sessions.id, row.id))
    .run();
  return { sessionId: row.id, deviceLabel: row.deviceLabel };
}

export function revokeSession(db: Db, sessionId: string): void {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

export function listSessions(db: Db) {
  return db.select().from(sessions).all();
}

/**
 * Mint a long-lived session without going through the pairing flow.
 * Used for trusted internal subprocesses (e.g. plugin bots spawned by the
 * daemon itself). Caller is responsible for keeping the returned token secret.
 */
export function createSystemSession(
  db: Db,
  deviceLabel: string,
): { sessionToken: string; sessionId: string } {
  const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const sessionId = newId("sess");
  const now = Date.now();
  db.insert(sessions)
    .values({
      id: sessionId,
      tokenHash: sha256(sessionToken),
      deviceLabel,
      createdAt: now,
      expiresAt: null,
      lastSeenAt: now,
    })
    .run();
  return { sessionToken, sessionId };
}

export function sessionExists(db: Db, token: string): boolean {
  const row = db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, sha256(token)))
    .get();
  return !!row;
}
