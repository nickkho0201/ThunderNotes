import { getBrowser } from "../api/browser";

export async function hasNotificationPermission(): Promise<boolean> {
  const permissions = getBrowser()?.permissions;
  if (!permissions) return false;
  return permissions.contains({ permissions: ["notifications"] });
}

/**
 * Must be called directly from a user-gesture handler. Do not add an await,
 * runtime message, or permission preflight before `request()`.
 */
export function requestNotificationPermission(): Promise<boolean> {
  const permissions = getBrowser()?.permissions;
  if (!permissions) return Promise.resolve(false);
  return permissions.request({ permissions: ["notifications"] });
}

export async function reconcileReminders(): Promise<void> {
  await getBrowser()?.runtime.sendMessage({ type: "thundernotes:reminders-reconcile" });
}
