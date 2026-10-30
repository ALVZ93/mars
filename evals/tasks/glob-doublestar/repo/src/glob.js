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
export function matchGlob(pattern, path) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") { source += ".*"; i++; }
      else source += "[^/]*";
    } else if (ch === "?") source += ".";
    else source += ch;
  }
  return new RegExp(`^${source}$`).test(path);
}
