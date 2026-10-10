/**
 * Date helpers. Pure functions with no RemNote dependency so they can be tested in isolation.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad2 = (n: number) => String(n).padStart(2, '0');

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * Parse a "day starts at" time like "04:30", "4:30" or "4" (24-hour clock) into minutes after
 * midnight. Returns undefined if it isn't a valid time.
 */
export function parseDayStart(value: unknown): number | undefined {
  const m = /^\s*(\d{1,2})(?:\s*[:.h]\s*(\d{1,2}))?\s*$/i.exec(String(value ?? ''));
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

export function formatDayStart(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

const clampMinutes = (m: number) => (Number.isFinite(m) ? Math.min(1439, Math.max(0, Math.floor(m))) : 0);

/**
 * The calendar date that counts as "today". With the day starting at 04:30, 1:30am on the 10th
 * still counts as the 9th, so a late study session keeps yesterday's note locked.
 */
export function effectiveDate(now: Date, dayStartMinutes: number): Date {
  const d = new Date(now.getTime());
  d.setMinutes(d.getMinutes() - clampMinutes(dayStartMinutes));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0); // noon avoids DST edges
}

/** Stable local-date key, e.g. "2026-10-09". */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function addDays(d: Date, days: number): Date {
  const r = new Date(d.getTime());
  r.setDate(r.getDate() + days);
  return r;
}

/** Milliseconds until the next day boundary (plus a small safety margin). */
export function msUntilNextBoundary(now: Date, dayStartMinutes: number): number {
  const total = clampMinutes(dayStartMinutes);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
    Math.floor(total / 60), total % 60, 5, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export type DateFormatter = (d: Date) => string;

/**
 * Title formats RemNote can use for daily documents. We never assume one: we pick whichever
 * reproduces today's actual daily-document title exactly, then use it to name past days.
 */
export const DAILY_TITLE_FORMATS: Record<string, DateFormatter> = {
  'MMMM do, yyyy': (d) => `${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`,
  'MMMM d, yyyy': (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`,
  'MMM do, yyyy': (d) => `${MONTHS[d.getMonth()].slice(0, 3)} ${ordinal(d.getDate())}, ${d.getFullYear()}`,
  'MMM d, yyyy': (d) => `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}`,
  'do MMMM yyyy': (d) => `${ordinal(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  'd MMMM yyyy': (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  'EEEE, MMMM do, yyyy': (d) =>
    `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`,
  'MM/dd/yyyy': (d) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`,
  'dd/MM/yyyy': (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`,
  'dd.MM.yyyy': (d) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`,
  'yyyy-MM-dd': (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
  'yyyy/MM/dd': (d) => `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`,
};

/** Returns the format name that turns `date` into `title`, or undefined if none match. */
export function detectTitleFormat(date: Date, title: string): string | undefined {
  const t = title.trim();
  // Ambiguous numeric formats (MM/dd vs dd/MM) can both match on e.g. the 5th of May; the first
  // match wins, and past titles are still verified against real daily documents before use.
  return Object.keys(DAILY_TITLE_FORMATS).find((k) => DAILY_TITLE_FORMATS[k](date) === t);
}

/** Titles for the `days` calendar days before `today`, in the detected format. */
export function pastTitles(today: Date, formatName: string, days: number): string[] {
  const f = DAILY_TITLE_FORMATS[formatName];
  if (!f) return [];
  const out: string[] = [];
  for (let i = 1; i <= days; i++) out.push(f(addDays(today, -i)));
  return out;
}
