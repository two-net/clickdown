import { age, ago, bytes, color, dueInfo, duration, matches, plural, stamp } from './format';

describe('format', () => {
  const now = new Date(2026, 8, 11, 12).getTime(); // a Friday, local time
  const at = (month: number, day: number, year = 2026) => new Date(year, month, day, 17).getTime();

  it('writes due dates relative to today', () => {
    expect(dueInfo(at(8, 11), false, now)).toMatchObject({ text: 'Today', overdue: false });
    expect(dueInfo(at(8, 12), false, now)?.text).toBe('Tomorrow');
    expect(dueInfo(at(8, 10), false, now)).toMatchObject({ text: 'Yesterday', overdue: true });
    expect(dueInfo(at(8, 10), true, now)?.overdue).toBe(false); // closed tasks are never overdue
    expect(dueInfo(at(8, 14), false, now)?.text).toBe('Mon');
    expect(dueInfo(at(9, 1), false, now)?.text).toBe('Oct 1');
    expect(dueInfo(at(0, 5, 2027), false, now)?.text).toBe('Jan 5, 2027');
    expect(dueInfo(null, false, now)).toBeNull();
  });

  it('writes how long ago something happened', () => {
    expect(ago(now - 30_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(ago(now - 86_400_000, now)).toBe('yesterday');
    expect(ago(now - 45 * 86_400_000, now)).toBe('Jul 28, 2026');
    expect(ago(new Date(2026, 5, 13, 12).getTime(), now)).toBe('Jun 13, 2026');
    expect(ago(null, now)).toBeNull();
  });

  it('keeps ages relative however old, with the exact time to hover', () => {
    expect(age(now - 59.7 * 60_000, now)).toBe('1 hour ago'); // not "60 minutes ago"
    expect(age(now - 86_400_000, now)).toBe('yesterday');
    expect(age(now - 44.7 * 86_400_000, now)).toBe('1 month ago'); // not "45 days ago"
    expect(age(new Date(2026, 5, 13, 12).getTime(), now)).toBe('3 months ago');
    expect(age(new Date(2025, 9, 1, 12).getTime(), now)).toBe('11 months ago');
    expect(age(new Date(2025, 8, 1, 12).getTime(), now)).toBe('1 year ago'); // a span, not the calendar's "last year"
    expect(age(new Date(2019, 8, 5, 7, 4).getTime(), now)).toBe('7 years ago');
    expect(age(null, now)).toBeNull();
    expect(stamp(new Date(2019, 8, 5, 7, 4).getTime())).toBe('05 Sep 2019 07:04');
    expect(stamp(new Date(2026, 11, 31, 23, 59).getTime())).toBe('31 Dec 2026 23:59');
    expect(stamp(null)).toBeNull();
  });

  it('writes durations, counts and file sizes, and passes on only plain colors', () => {
    expect(duration(5_400_000)).toBe('1 h 30 min');
    expect(duration(7_200_000)).toBe('2 h');
    expect(duration(900_000)).toBe('15 min');
    expect(plural(1, 'task')).toBe('1 task');
    expect(plural(2, 'status', 'statuses')).toBe('2 statuses');
    expect(bytes(1)).toBe('1 byte');
    expect(bytes(999)).toBe('999 bytes');
    expect(bytes(140_970)).toBe('141 KB');
    expect(bytes(999_960)).toBe('1 MB'); // never "1,000 KB"
    expect(bytes(1_928_395)).toBe('1.9 MB');
    expect(bytes(4_300_000_000_000)).toBe('4,300 GB');
    expect(color('#abc')).toBe('#abc');
    expect(color('url(https://x.test/a.png)')).toBe('#56666F'); // CSS must never load anything
    expect(color('#12345')).toBe('#56666F'); // not a color at all
    expect(color(null, '#000')).toBe('#000');
  });

  it('matches every word of a search, whatever the case or accents', () => {
    expect(matches('cafe', ['Café crash'])).toBe(true);
    expect(matches('CRASH caf', ['Café crash'])).toBe(true); // any order, parts of words
    expect(matches('zoe bug-12', ['Task c', 'BUG-12', 'Zoë'])).toBe(true); // words from different fields
    expect(matches('istanbul', ['İstanbul'])).toBe(true);
    expect(matches('कुत', ['किताब'])).toBe(false); // a Hindi vowel sign isn't an accent
    expect(matches('crash ui', ['Café crash', null])).toBe(false); // every word must appear
    expect(matches('  ', [])).toBe(true); // nothing typed: everything
  });
});
