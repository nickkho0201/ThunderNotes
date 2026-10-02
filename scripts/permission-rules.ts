/** Explicitly approved permission surface; used by the artifact verifier. */
export function permissionFailures(manifest: Record<string, unknown>): string[] {
  const failures: string[] = [];
  const permissions = manifest.permissions;
  if (!Array.isArray(permissions) || permissions.length !== 2 || !permissions.includes("downloads") || !permissions.includes("messagesRead")) {
    failures.push('permissions must be exactly ["downloads", "messagesRead"]');
  }
  for (const key of ["optional_permissions", "host_permissions", "optional_host_permissions"]) {
    const value = manifest[key];
    if (value !== undefined && (!Array.isArray(value) || value.length !== 0)) failures.push(`${key} must be empty or absent`);
  }
  if (manifest.experiment_apis !== undefined) failures.push("experiment_apis is not approved");
  return failures;
}
