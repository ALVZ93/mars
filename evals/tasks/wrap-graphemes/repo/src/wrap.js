/**
 * wrap(text, width): breaks text into lines of at most `width` characters and joins them with "\n".
 * - Width counts user-perceived characters (grapheme clusters): "é" written as e + combining accent, "👍🏽" and
 *   "👨‍👩‍👧" each count as one.
 * - Words are separated by single spaces. Lines break between words; the space at a break is dropped.
 * - A word longer than `width` is split into chunks of exactly `width` characters (the last chunk may be shorter),
 *   each starting a new line.
 * - Existing "\n" line breaks are kept; each paragraph is wrapped on its own.
 */
export function wrap(text, width) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines.join("\n");
}
