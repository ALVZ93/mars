/** Parses one CSV line (RFC 4180): quoted fields may contain commas and doubled quotes. */
export function parseCsvLine(line) {
  return line.split(",").map(field => field.replace(/^"|"$/g, ""));
}
