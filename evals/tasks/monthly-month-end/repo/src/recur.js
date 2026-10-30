/**
 * monthlyDates(start, count): the first `count` monthly occurrences from `start`, a "YYYY-MM-DD" date (UTC).
 * Every occurrence falls on the day of the month of `start`. In a month that is too short it falls on the month's
 * last day instead, and the following months go back to the original day:
 * 2026-01-31 → 2026-02-28 → 2026-03-31 → 2026-04-30.
 * Returns "YYYY-MM-DD" strings.
 */
export function monthlyDates(start, count) {
  const date = new Date(`${start}T00:00:00Z`);
  const result = [];
  for (let i = 0; i < count; i++) {
    result.push(date.toISOString().slice(0, 10));
    date.setUTCMonth(date.getUTCMonth() + 1);
  }
  return result;
}
