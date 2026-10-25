/** Least-recently-used cache. Reading or writing a key makes it the most recent; the oldest key is evicted. */
export class LruCache {
  #map = new Map();
  #size = 0;
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be >= 1");
    this.capacity = capacity;
  }
  get size() { return this.#size; }
  get(key) {
    return this.#map.get(key);
  }
  set(key, value) {
    this.#map.set(key, value);
    this.#size++;
    while (this.#size > this.capacity) {
      const oldest = this.#map.keys().next().value;
      this.#map.delete(oldest);
      this.#size--;
    }
    return this;
  }
  has(key) { return this.#map.has(key); }
}
