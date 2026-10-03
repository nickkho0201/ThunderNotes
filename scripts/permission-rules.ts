/** Explicitly approved permission surface; used by the artifact verifier. */
export function permissionFailures(manifest: Record<string, unknown>): string[] {
  const failures: string[] = [];
  const permissions = manifest.permissions;
  if (!Array.isArray(permissions) || permissions.length !== 3 || !permissions.includes("alarms") || !permissions.includes("downloads") || !permissions.includes("messagesRead")) {
    failures.push('permissions must be exactly ["alarms", "downloads", "messagesRead"]');
  }
  const optional = manifest.optional_permissions;
  if (!Array.isArray(optional) || optional.length !== 1 || optional[0] !== "notifications") {
    failures.push('optional_permissions must be exactly ["notifications"]');
  }
  for (const key of ["host_permissions", "optional_host_permissions"]) {
    const value = manifest[key];
    if (value !== undefined && (!Array.isArray(value) || value.length !== 0)) failures.push(`${key} must be empty or absent`);
  }
  if (manifest.experiment_apis !== undefined) failures.push("experiment_apis is not approved");
  return failures;
}
