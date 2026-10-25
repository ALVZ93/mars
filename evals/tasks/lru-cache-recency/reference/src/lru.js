/** Least-recently-used cache. Reading or writing a key makes it the most recent; the oldest key is evicted. */
export class LruCache {
  #map = new Map();
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be >= 1");
    this.capacity = capacity;
  }
  get size() { return this.#map.size; }
  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }
  set(key, value) {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.capacity) this.#map.delete(this.#map.keys().next().value);
    return this;
  }
  has(key) { return this.#map.has(key); }
}
