// In-memory user store with a read cache. getUser returns the current data for an id, or undefined.
const users = new Map();
const cache = new Map();

export function saveUser(user) {
  users.set(user.id, { ...user });
  cache.delete(user.id);
}

export function getUser(id) {
  // Misses are not cached: a user saved later must be visible.
  if (!cache.has(id) && users.has(id)) cache.set(id, users.get(id));
  return cache.get(id);
}

export function renameUser(id, name) {
  const user = users.get(id);
  if (!user) throw new Error(`Unknown user ${id}`);
  users.set(id, { ...user, name });
  cache.delete(id);
}

export function resetStore() {
  users.clear();
  cache.clear();
}
