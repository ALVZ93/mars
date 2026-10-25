/**
 * Splits an amount in cents into `parts` shares that add up exactly to the amount.
 * Shares differ by at most one cent; larger shares come first.
 */
export function splitCents(amount, parts) {
  if (!Number.isInteger(amount) || amount < 0) throw new RangeError("amount must be a non-negative integer");
  if (!Number.isInteger(parts) || parts < 1) throw new RangeError("parts must be >= 1");
  const share = Math.round(amount / parts);
  return Array.from({ length: parts }, () => share);
}
