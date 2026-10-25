/**
 * Returns one page of items. Pages are 1-based: page 1 is the first page.
 * Throws RangeError for page < 1 or size < 1.
 */
export function paginate(items, page, size) {
  if (!Number.isInteger(page) || page < 1) throw new RangeError("page must be >= 1");
  if (!Number.isInteger(size) || size < 1) throw new RangeError("size must be >= 1");
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}

export function pageCount(total, size) {
  return Math.ceil(total / size);
}
