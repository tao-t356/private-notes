import { isLoginSession } from './login-flow.js';

/** @typedef {import('./login-flow.js').LoginSession} DeviceSession */
export const DEVICE_SESSION_KEY = 'private-notes.session.v3';
export const LEGACY_DEVICE_SESSION_KEY = 'private-notes.session.v2';
export const LOGOUT_EVENT_KEY = 'private-notes.logout.v1';

const SESSION_FIELDS = new Set(['token', 'vaultId', 'expiresAt']);

/** @param {Storage | undefined} [storage] */
export function createDeviceSessionStore(storage) {
  if (storage === undefined) {
    try { storage = typeof localStorage === 'undefined' ? undefined : localStorage; } catch { /* Private browsing can deny storage. */ }
  }
  return {
    /** @returns {DeviceSession | null} */
    load() {
      if (!storage) return null;
      const text = storage.getItem(DEVICE_SESSION_KEY);
      if (!text) return null;
      let value;
      try { value = JSON.parse(text); } catch { storage.removeItem(DEVICE_SESSION_KEY); return null; }
      if (!isLoginSession(value) || Object.keys(value).some((key) => !SESSION_FIELDS.has(key))) {
        storage.removeItem(DEVICE_SESSION_KEY);
        return null;
      }
      const record = /** @type {DeviceSession} */ (value);
      return { token: record.token, vaultId: record.vaultId, expiresAt: record.expiresAt };
    },
    /** @param {DeviceSession} value */
    save(value) {
      if (!storage) throw new Error('此浏览器不允许记住登录');
      // Persist only the server session. The vault key stays in page memory;
      // returning users enter the vault password again to derive it locally.
      storage.setItem(DEVICE_SESSION_KEY, JSON.stringify({token: value.token, vaultId: value.vaultId,
        expiresAt: value.expiresAt}));
    },
    forgetLegacy() {
      storage?.removeItem(LEGACY_DEVICE_SESSION_KEY);
    },
    clear() { storage?.removeItem(DEVICE_SESSION_KEY); },
    notifyLogout() {
      if (!storage) throw new Error('无法通知其他标签页，请一并关闭它们');
      // Removing an absent credential does not emit a storage event. This
      // independent, non-secret signal also reaches memory-only sessions.
      storage.setItem(LOGOUT_EVENT_KEY, String(Date.now()) + ':' + Math.random().toString(36).slice(2));
      storage.removeItem(LOGOUT_EVENT_KEY);
    }
  };
}

// Retire the old store without opening it or blocking login. Old records must
// not silently restore a session after the user has logged out of this version.
export function clearLegacyDeviceStore() {
  try { if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase('private-notes-device'); } catch { /* Best effort cleanup only. */ }
}
