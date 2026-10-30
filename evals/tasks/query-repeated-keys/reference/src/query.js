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
const decode = text => {
  const spaced = text.replace(/\+/g, " ");
  try { return decodeURIComponent(spaced); } catch { return spaced; }
};

export function parseQuery(input) {
  const result = Object.create(null);
  let text = input.startsWith("?") ? input.slice(1) : input;
  const hash = text.indexOf("#");
  if (hash !== -1) text = text.slice(0, hash);
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = decode(eq === -1 ? pair : pair.slice(0, eq));
    if (!key) continue;
    const value = eq === -1 ? "" : decode(pair.slice(eq + 1));
    if (key in result) result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
    else result[key] = value;
  }
  return result;
}
