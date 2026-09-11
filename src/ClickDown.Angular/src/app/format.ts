// How the views write dates, durations, counts and ClickUp's colors, and match searches. Pure functions.
const EN = 'en-US';
const DAY = 86_400_000;
const weekday = new Intl.DateTimeFormat(EN, { weekday: 'short' });
const monthDay = new Intl.DateTimeFormat(EN, { month: 'short', day: 'numeric' });
const date = new Intl.DateTimeFormat(EN, { month: 'short', day: 'numeric', year: 'numeric' });
const dateTime = new Intl.DateTimeFormat(EN, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const month = new Intl.DateTimeFormat(EN, { month: 'short' });
const relative = new Intl.RelativeTimeFormat(EN, { numeric: 'auto' });
const span = new Intl.RelativeTimeFormat(EN, { numeric: 'always' });
const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
const two = (n: number) => String(n).padStart(2, '0');

export interface Due { text: string; overdue: boolean; title: string }

/** A due date as a row shows it: Today, Tomorrow, Yesterday, a weekday within the week, or the date. */
export function dueInfo(ms: number | null, closed: boolean, now = Date.now()): Due | null {
  if (!ms) return null;
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  const text = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday'
    : days > 1 && days < 7 ? weekday.format(ms) : (sameYear ? monthDay : date).format(ms);
  const overdue = days < 0 && !closed;
  return { text, overdue, title: `${overdue ? 'Overdue. ' : ''}Due ${dateTime.format(ms)}` };
}

/** "just now", "3 hours ago", "yesterday", "1 month ago", "2 years ago": always relative, so a column of them lines up. */
export function age(ms: number | null, now = Date.now()): string | null {
  if (!ms) return null;
  const s = (ms - now) / 1000;
  if (Math.abs(s) < 60) return 'just now';
  // Rounded before the unit is picked: "1 hour ago", never "60 minutes ago".
  const minutes = Math.round(s / 60);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(s / 3600);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  const days = Math.round(s / 86_400);
  if (Math.abs(days) < 45) return relative.format(days, 'day');
  // Months and years are spans, so "1 month ago" rather than the calendar's "last month".
  const months = Math.round(s / (30.44 * 86_400));
  return Math.abs(months) < 12 ? span.format(months, 'month') : span.format(Math.round(s / (365.25 * 86_400)), 'year');
}

/** Like age(), but the date once it's over 45 days away. */
export const ago = (ms: number | null, now = Date.now()) => (ms && Math.abs(ms - now) >= 45 * DAY ? date.format(ms) : age(ms, now));

export const day = (ms: number | null) => (ms ? date.format(ms) : null);
export const fullDate = (ms: number | null) => (ms ? dateTime.format(ms) : null);

/** dd MMM yyyy HH:mm in local time, like "05 Sep 2019 16:34". */
export function stamp(ms: number | null): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  return `${two(d.getDate())} ${month.format(d)} ${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const cap = (s: string | null | undefined) => (s ? s[0].toUpperCase() + s.slice(1) : '');

/** Lowercase and without Latin accents, so "cafe" finds "Café" and "zoe" finds "Zoë". Other scripts' marks carry meaning, so they stay. */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Whether every word of a search appears somewhere in the texts, whatever the case and accents. A blank search matches. */
export function matches(query: string, texts: (string | null)[]): boolean {
  const text = fold(texts.join('\n')); // words hold no whitespace, so none spans two texts
  return fold(query).split(/\s+/).every((word) => text.includes(word));
}

/** A ClickUp color only if it's plain #hex: it ends up in CSS, which must never load anything. */
export const color = (value: string | null | undefined, fallback = '#56666F') =>
  value && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : fallback;
