import { ago, color, dueInfo, duration, plural } from './format';

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
    expect(ago(new Date(2026, 5, 13, 12).getTime(), now)).toBe('Jun 13, 2026');
    expect(ago(null, now)).toBeNull();
  });

  it('writes durations and counts, and passes on only plain colors', () => {
    expect(duration(5_400_000)).toBe('1 h 30 min');
    expect(duration(7_200_000)).toBe('2 h');
    expect(duration(900_000)).toBe('15 min');
    expect(plural(1, 'task')).toBe('1 task');
    expect(plural(2, 'status', 'statuses')).toBe('2 statuses');
    expect(color('#abc')).toBe('#abc');
    expect(color('url(https://x.test/a.png)')).toBe('#56666F'); // CSS must never load anything
    expect(color('#12345')).toBe('#56666F'); // not a color at all
    expect(color(null, '#000')).toBe('#000');
  });
});
