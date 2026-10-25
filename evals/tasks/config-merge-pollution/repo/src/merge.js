/** Deep-merges plain objects from `sources` into a new object. Arrays and primitives replace. */
export function deepMerge(...sources) {
  const result = {};
  for (const source of sources) mergeInto(result, source);
  return result;
}

function mergeInto(target, source) {
  for (const key in source) {
    const value = source[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== "object") target[key] = {};
      mergeInto(target[key], value);
    } else {
      target[key] = value;
    }
  }
}
