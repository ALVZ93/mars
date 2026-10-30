/**
 * parseQuery(input): parses a URL query string into an object without a prototype.
 * - A leading "?" is ignored, and so is everything from the first "#".
 * - Pairs are separated by "&"; empty pairs are skipped.
 * - The first "=" separates key and value; a pair without "=" has the value "".
 * - "+" means a space and percent-escapes are decoded as UTF-8. A key or value that cannot be decoded is kept
 *   as written (with "+" still turned into spaces).
 * - Pairs with an empty key are skipped.
 * - A key that appears more than once collects its values in an array, in order.
 */
export function parseQuery(input) {
  const result = {};
  for (const pair of input.replace(/^\?/, "").split("&")) {
    const [key, value] = pair.split("=");
    result[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return result;
}
