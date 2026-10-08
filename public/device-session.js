import { isLoginSession } from './login-flow.js';

/** @typedef {import('./login-flow.js').LoginSession & {key: string | null, configId: string}} DeviceSession */
export const DEVICE_SESSION_KEY = 'private-notes.session.v2';

/** @param {Storage | undefined} [storage] */
export function createDeviceSessionStore(storage) {
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { /* Private browsing can deny storage. */ }
  }
  return {
    /** @returns {DeviceSession | null} */
    load() {
      if (!storage) return null;
      const text = storage.getItem(DEVICE_SESSION_KEY);
      if (!text) return null;
      let value;
      try { value = JSON.parse(text); } catch { storage.removeItem(DEVICE_SESSION_KEY); return null; }
      const record = /** @type {DeviceSession} */ (value);
      if (!isLoginSession(value) || typeof record.configId !== 'string' ||
        (record.key !== null && (typeof record.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(record.key)))) {
        storage.removeItem(DEVICE_SESSION_KEY);
        return null;
      }
      return record;
    },
    /** @param {DeviceSession} value */
    save(value) {
      if (!storage) throw new Error('此浏览器不允许记住登录');
      // Only these fields are saved. Never store a password or note plaintext.
      storage.setItem(DEVICE_SESSION_KEY, JSON.stringify({token: value.token, vaultId: value.vaultId,
        expiresAt: value.expiresAt, key: value.key, configId: value.configId}));
    },
    clear() { storage?.removeItem(DEVICE_SESSION_KEY); }
  };
}

// Retire the old store without opening it or blocking login. Old records must
// not silently restore a session after the user has logged out of this version.
export function clearLegacyDeviceStore() {
  try { globalThis.indexedDB?.deleteDatabase('private-notes-device'); } catch { /* Best effort cleanup only. */ }
}
