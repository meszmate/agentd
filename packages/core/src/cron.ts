/**
 * Tiny 5-field cron parser/evaluator. Supports:
 *   - `*`             any value
 *   - `*\/N`           every N from the field's lowest value
 *   - `A,B,C`         explicit list
 *   - `A-B`           inclusive range
 *   - `A-B/N`         range with step
 *   - plain integer
 *
 * Fields (in order): minute (0-59), hour (0-23), day-of-month (1-31),
 * month (1-12), day-of-week (0-6, Sunday=0).
 *
 * Not supported: named months/days (JAN, MON), `?`, `L`, `#`, `W`, seconds.
 * If you need those, swap to a full library — but this is enough for
 * "every 30 minutes", "0 9 * * 1-5" (weekdays at 9am), etc.
 */

export interface CronExpr {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function parseField(raw: string, [min, max]: [number, number]): number[] {
  const out = new Set<number>();
  for (const piece of raw.split(",")) {
    const part = piece.trim();
    if (part === "") throw new Error(`empty cron field segment`);
    let stepMatch = part.match(/^(.+)\/(\d+)$/);
    let body = part;
    let step = 1;
    if (stepMatch) {
      body = stepMatch[1]!;
      step = Number(stepMatch[2]);
      if (!Number.isFinite(step) || step < 1) throw new Error(`bad step in ${part}`);
    }
    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      lo = Number(a);
      hi = Number(b);
      if (!Number.isFinite(lo) || !Number.isFinite(hi))
        throw new Error(`bad range ${body}`);
    } else {
      lo = Number(body);
      hi = lo;
      if (!Number.isFinite(lo)) throw new Error(`bad value ${body}`);
    }
    if (lo < min || hi > max || lo > hi)
      throw new Error(`field out of range: ${part} (allowed ${min}-${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return Array.from(out).sort((a, b) => a - b);
}

export function parseCron(expr: string): CronExpr {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron must have 5 fields, got ${fields.length}: "${expr}"`);
  }
  const [min, hour, dom, mon, dow] = fields.map((f, i) =>
    parseField(f, FIELD_RANGES[i]!),
  );
  return {
    minute: min!,
    hour: hour!,
    dayOfMonth: dom!,
    month: mon!,
    dayOfWeek: dow!,
  };
}

function matches(expr: CronExpr, d: Date): boolean {
  return (
    expr.minute.includes(d.getMinutes()) &&
    expr.hour.includes(d.getHours()) &&
    expr.dayOfMonth.includes(d.getDate()) &&
    expr.month.includes(d.getMonth() + 1) &&
    expr.dayOfWeek.includes(d.getDay())
  );
}

/**
 * Find the next minute (>= `from`, exclusive of the same minute) that
 * matches the expression. Caps the search at one year out so a malformed
 * expression like `* * 31 2 *` doesn't loop forever.
 */
export function nextRun(expr: CronExpr, from: Date = new Date()): Date | null {
  const start = new Date(from);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = new Date(start);
  limit.setFullYear(limit.getFullYear() + 1);
  for (let d = new Date(start); d < limit; d.setMinutes(d.getMinutes() + 1)) {
    if (matches(expr, d)) return new Date(d);
  }
  return null;
}

/** Did the expression fire during the minute that `now` falls in? */
export function shouldFireAt(expr: CronExpr, now: Date = new Date()): boolean {
  const d = new Date(now);
  d.setSeconds(0, 0);
  return matches(expr, d);
}
