/** Spanish general VAT rate, in force since 2012. */
export const VAT_RATE = 0.21;

/** Adds VAT to a net amount in cents, rounding half up to the cent. */
export function withVat(netCents) {
  return Math.round(netCents * (1 + VAT_RATE));
}
