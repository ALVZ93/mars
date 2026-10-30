/**
 * Money helpers. Amounts are numbers in euros; results are integer cents.
 * Rounding to the cent is "half away from zero", applied to the decimal amount as written:
 * 1.005 → 101, -1.005 → -101, 2.675 → 268. Rounding never produces -0.
 */
export function toCents(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) throw new TypeError("amount must be a finite number");
  // Round the shortest decimal form, not the binary product: 1.005 * 100 is 100.49999…
  const text = Math.abs(amount).toPrecision(15);
  let cents;
  if (text.includes("e")) cents = Math.round(Math.abs(amount) * 100);
  else {
    const [whole, fraction = ""] = text.split(".");
    const digits = fraction.padEnd(3, "0");
    cents = Number(whole) * 100 + Number(digits.slice(0, 2)) + (Number(digits[2]) >= 5 ? 1 : 0);
  }
  return amount < 0 && cents !== 0 ? -cents : cents;
}

export function formatEuros(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")} €`;
}

export const formatPrice = amount => formatEuros(toCents(amount));
