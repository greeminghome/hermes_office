const CURRENT_PREFIX = "hermes-office-";
const LEGACY_MARKER = "-hermes-";

function storageKeys(storage) {
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key) keys.push(key);
  }
  return keys;
}

export function migrateNamespacedStorage(storage = globalThis.localStorage) {
  if (!storage) return [];
  const migrated = [];

  for (const key of storageKeys(storage)) {
    if (key.startsWith(CURRENT_PREFIX)) continue;
    const markerIndex = key.indexOf(LEGACY_MARKER);
    if (markerIndex <= 0) continue;

    const suffix = key.slice(markerIndex + LEGACY_MARKER.length);
    if (!suffix || suffix.length > 240) continue;
    const nextKey = `${CURRENT_PREFIX}${suffix}`;
    if (storage.getItem(nextKey) !== null) continue;

    const value = storage.getItem(key);
    if (value === null) continue;
    storage.setItem(nextKey, value);
    migrated.push({ from: key, to: nextKey });
  }

  return migrated;
}
