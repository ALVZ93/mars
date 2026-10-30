import { getUser } from "./store.js";

/** Header shown on a profile page: "Name (role)". */
export function profileTitle(id) {
  const user = getUser(id);
  if (!user) return "Unknown user";
  return `${user.name} (${user.role})`;
}
