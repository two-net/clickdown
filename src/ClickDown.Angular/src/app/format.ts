// How the views write dates, durations, counts and ClickUp's colors. Pure functions.
const EN = 'en-US';
const DAY = 86_400_000;
const weekday = new Intl.DateTimeFormat(EN, { weekday: 'short' });
const monthDay = new Intl.DateTimeFormat(EN, { month: 'short', day: 'numeric' });
const date = new Intl.DateTimeFormat(EN, { month: 'short', day: 'numeric', year: 'numeric' });
const dateTime = new Intl.DateTimeFormat(EN, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const relative = new Intl.RelativeTimeFormat(EN, { numeric: 'auto' });
const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

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

/** "just now", "3 hours ago", "yesterday", or the date once it's over 45 days away. */
export function ago(ms: number | null, now = Date.now()): string | null {
  if (!ms) return null;
  const s = (ms - now) / 1000;
  const abs = Math.abs(s);
  if (abs < 60) return 'just now';
  if (abs < 3600) return relative.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(s / 3600), 'hour');
  if (abs < 45 * 86_400) return relative.format(Math.round(s / 86_400), 'day');
  return date.format(ms);
}

export const day = (ms: number | null) => (ms ? date.format(ms) : null);
export const fullDate = (ms: number | null) => (ms ? dateTime.format(ms) : null);

export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const cap = (s: string | null | undefined) => (s ? s[0].toUpperCase() + s.slice(1) : '');

/** A ClickUp color only if it's plain #hex: it ends up in CSS, which must never load anything. */
export const color = (value: string | null | undefined, fallback = '#56666F') =>
  value && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : fallback;
