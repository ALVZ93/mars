/**
 * monthlyDates(start, count): the first `count` monthly occurrences from `start`, a "YYYY-MM-DD" date (UTC).
 * Every occurrence falls on the day of the month of `start`. In a month that is too short it falls on the month's
 * last day instead, and the following months go back to the original day:
 * 2026-01-31 → 2026-02-28 → 2026-03-31 → 2026-04-30.
 * Returns "YYYY-MM-DD" strings.
 */
export function monthlyDates(start, count) {
  const [year, month, day] = start.split("-").map(Number);
  const result = [];
  for (let i = 0; i < count; i++) {
    // Each occurrence is computed from the start, so a short month never shifts the later ones.
    const total = month - 1 + i;
    const y = year + Math.floor(total / 12);
    const m = total % 12;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    result.push(new Date(Date.UTC(y, m, Math.min(day, last))).toISOString().slice(0, 10));
  }
  return result;
}
