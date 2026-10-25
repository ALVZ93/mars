const DAY = 24 * 60 * 60 * 1000;

/** ISO week start: the Monday (00:00 UTC) of the week containing `date`. Weeks run Monday to Sunday. */
export function startOfWeek(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return new Date(day.getTime() - (day.getUTCDay() - 1) * DAY);
}
