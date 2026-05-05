import { eq } from "drizzle-orm";
import type {
  AgentKind,
  ProviderRateLimit,
  ProviderRateLimitWindow,
} from "@agentd/contracts";
import type { Db } from "./db.ts";
import { providerRateLimits } from "./db.ts";

function parseWindows(
  raw: string | null | undefined,
): Record<string, ProviderRateLimitWindow> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, ProviderRateLimitWindow>;
    }
  } catch {
    // corrupt row — treat as empty so the next event repopulates it
  }
  return {};
}

function rowToSnapshot(row: {
  provider: string;
  windowsJson: string;
  updatedAt: number;
}): ProviderRateLimit {
  return {
    provider: row.provider as AgentKind,
    windows: parseWindows(row.windowsJson),
    updatedAt: row.updatedAt,
  };
}

export function getProviderRateLimit(
  db: Db,
  provider: AgentKind,
): ProviderRateLimit | null {
  const row = db
    .select()
    .from(providerRateLimits)
    .where(eq(providerRateLimits.provider, provider))
    .get();
  return row ? rowToSnapshot(row) : null;
}

export function listProviderRateLimits(db: Db): ProviderRateLimit[] {
  return db.select().from(providerRateLimits).all().map(rowToSnapshot);
}

/**
 * Replace the named window on the provider's snapshot, leaving the
 * other windows untouched. Upserts the row when the provider has
 * never been seen before. Returns the post-write snapshot so callers
 * can broadcast it without a follow-up read.
 */
export function setProviderRateLimitWindow(
  db: Db,
  provider: AgentKind,
  rateLimitType: string,
  window: ProviderRateLimitWindow,
): ProviderRateLimit {
  const now = Date.now();
  const existing = getProviderRateLimit(db, provider);
  const windows = { ...(existing?.windows ?? {}), [rateLimitType]: window };
  const windowsJson = JSON.stringify(windows);
  if (existing) {
    db.update(providerRateLimits)
      .set({ windowsJson, updatedAt: now })
      .where(eq(providerRateLimits.provider, provider))
      .run();
  } else {
    db.insert(providerRateLimits)
      .values({ provider, windowsJson, updatedAt: now })
      .run();
  }
  return { provider, windows, updatedAt: now };
}
