/** Deep-merges plain objects from `sources` into a new object. Arrays and primitives replace. */
export function deepMerge(...sources) {
  const result = {};
  for (const source of sources) mergeInto(result, source);
  return result;
}

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

function mergeInto(target, source) {
  for (const key of Object.keys(source)) {
    if (UNSAFE.has(key)) continue;
    const value = source[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!Object.hasOwn(target, key) || !target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) target[key] = {};
      mergeInto(target[key], value);
    } else {
      target[key] = value;
    }
  }
}
