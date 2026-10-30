/**
 * wrap(text, width): breaks text into lines of at most `width` characters and joins them with "\n".
 * - Width counts user-perceived characters (grapheme clusters): "é" written as e + combining accent, "👍🏽" and
 *   "👨‍👩‍👧" each count as one.
 * - Words are separated by single spaces. Lines break between words; the space at a break is dropped.
 * - A word longer than `width` is split into chunks of exactly `width` characters (the last chunk may be shorter),
 *   each starting a new line.
 * - Existing "\n" line breaks are kept; each paragraph is wrapped on its own.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = text => Array.from(segmenter.segment(text), part => part.segment);

export function wrap(text, width) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = [];
    let started = false;
    for (const word of paragraph.split(" ")) {
      let chars = graphemes(word);
      while (chars.length > width) {
        if (started) lines.push(line.join(""));
        lines.push(chars.slice(0, width).join(""));
        chars = chars.slice(width);
        line = [];
        started = false;
      }
      if (!started) { line = chars; started = true; }
      else if (line.length + 1 + chars.length <= width) line = [...line, " ", ...chars];
      else { lines.push(line.join("")); line = chars; }
    }
    lines.push(line.join(""));
  }
  return lines.join("\n");
}
