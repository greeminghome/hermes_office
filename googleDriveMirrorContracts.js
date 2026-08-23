export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export function isExactGoogleDriveReadonlyScope(scope) {
  const scopes = new Set(String(scope || "").split(/\s+/).filter(Boolean));
  return scopes.size === 1 && scopes.has(DRIVE_READONLY_SCOPE);
}
