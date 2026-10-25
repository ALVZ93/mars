/** Minimal event emitter. Listeners registered with once() run a single time. */
export class Emitter {
  #listeners = new Map();
  on(event, listener) {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return () => this.off(event, listener);
  }
  once(event, listener) {
    const wrapper = (...args) => { this.off(event, wrapper); listener(...args); };
    return this.on(event, wrapper);
  }
  off(event, listener) {
    const list = this.#listeners.get(event);
    if (!list) return;
    const index = list.indexOf(listener);
    if (index !== -1) list.splice(index, 1);
  }
  emit(event, ...args) {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(...args);
  }
  count(event) { return (this.#listeners.get(event) ?? []).length; }
}
