/**
 * Money helpers. Amounts are numbers in euros; results are integer cents.
 * Rounding to the cent is "half away from zero", applied to the decimal amount as written:
 * 1.005 → 101, -1.005 → -101, 2.675 → 268. Rounding never produces -0.
 */
export function toCents(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) throw new TypeError("amount must be a finite number");
  return Math.round(amount * 100);
}

export function formatEuros(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")} €`;
}

export const formatPrice = amount => formatEuros(toCents(amount));
