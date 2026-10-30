/**
 * Glob matching for paths with "/" separators. The whole path must match.
 *   *      any run of characters except "/"
 *   ?      exactly one character except "/"
 *   **     as a whole path segment: any number of segments, including none ("a/**​/b" matches "a/b" and "a/x/y/b");
 *          elsewhere it behaves like "*"
 *   [abc] [a-z]   one character from the set; [!abc] one character not in the set. Never matches "/".
 *   \x     the character x literally
 * Every other character matches itself.
 */
const escape = ch => (/[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch);

export function matchGlob(pattern, path) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) { source += escape(pattern[++i]); continue; }
    if (ch === "*" && pattern[i + 1] === "*" && (i === 0 || pattern[i - 1] === "/")) {
      if (i + 2 === pattern.length) { source += ".*"; i += 1; continue; }
      if (pattern[i + 2] === "/") { source += "(?:[^/]*/)*"; i += 2; continue; }
    }
    if (ch === "*") { source += "[^/]*"; continue; }
    if (ch === "?") { source += "[^/]"; continue; }
    if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close > i + 1) {
        let body = pattern.slice(i + 1, close);
        const negate = body.startsWith("!");
        if (negate) body = body.slice(1);
        body = body.replace(/[\\\]^]/g, "\\$&");
        source += negate ? `[^/${body}]` : `(?!/)[${body}]`;
        i = close;
        continue;
      }
    }
    source += escape(ch);
  }
  return new RegExp(`^${source}$`).test(path);
}
