export const LOGOUT_EVENT_KEY = 'private-notes.logout.v1';

/** @param {Storage | undefined} [storage] */
export function createLogoutSignal(storage) {
  if (storage === undefined) {
    try { storage = typeof localStorage === 'undefined' ? undefined : localStorage; } catch { /* Private browsing can deny storage. */ }
  }
  return {
    notifyLogout() {
      if (!storage) throw new Error('无法通知其他标签页，请一并关闭它们');
      // This independent signal reaches memory-only sessions and contains no credential.
      storage.setItem(LOGOUT_EVENT_KEY, String(Date.now()) + ':' + Math.random().toString(36).slice(2));
      storage.removeItem(LOGOUT_EVENT_KEY);
    }
  };
}

// Retire the old token-bearing IndexedDB store without opening it or blocking login.
/** @param {{ storage?: Storage, indexedDB?: IDBFactory }} [dependencies] */
export function clearLegacyDeviceStore(dependencies = {}) {
  let storage = dependencies.storage;
  let databaseApi = dependencies.indexedDB;
  try {
    if (storage === undefined) storage = typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch { /* Best effort cleanup only. */ }
  try { storage?.removeItem('private-notes.session.v3'); } catch { /* Best effort cleanup only. */ }
  try { storage?.removeItem('private-notes.session.v2'); } catch { /* Best effort cleanup only. */ }
  try {
    if (databaseApi === undefined) databaseApi = typeof indexedDB !== 'undefined' ? indexedDB : undefined;
  } catch { /* Best effort cleanup only. */ }
  try { databaseApi?.deleteDatabase('private-notes-device'); } catch { /* Best effort cleanup only. */ }
}
