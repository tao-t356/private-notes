import { isLoginSession } from './login-flow.js';

/** @typedef {import('./login-flow.js').LoginSession & {key: CryptoKey | null, configId: string}} DeviceSession */
const DATABASE = 'private-notes-device';
const STORE = 'session';

/**
 * IndexedDB structured-clones a non-extractable CryptoKey; no password or raw
 * AES key is serialized. Fail promptly if storage is blocked (e.g. private mode).
 * @param {IDBFactory | undefined} [factory]
 */
export function createDeviceSessionStore(factory) {
  if (factory === undefined) {
    try { factory = globalThis.indexedDB; } catch { /* Storage access may be forbidden. */ }
  }
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @param {'read' | 'write' | 'clear'} operation @param {DeviceSession} [value] */
  function run(operation, value) {
    const result = queue.catch(function () {}).then(function () {
      return new Promise(function (resolve, reject) {
        if (!factory) { reject(new Error('设备存储不可用')); return; }
        /** @type {IDBDatabase | undefined} */
        let db;
        /** @type {IDBTransaction | undefined} */
        let transaction;
        let settled = false;
        /** @param {unknown} [error] @param {unknown} [data] */
        function finish(error, data) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          db?.close();
          if (error) reject(error); else resolve(data);
        }
        const timer = setTimeout(function () {
          try { transaction?.abort(); } catch { /* Already inactive. */ }
          finish(new Error('设备存储响应超时'));
        }, 3000);
        /** @type {IDBOpenDBRequest} */
        let request;
        try { request = factory.open(DATABASE, 1); }
        catch (error) { finish(error); return; }
        request.onupgradeneeded = function () { request.result.createObjectStore(STORE); };
        request.onerror = function () { finish(request.error || new Error('无法打开设备存储')); };
        request.onblocked = function () { finish(new Error('设备存储被其他页面占用')); };
        request.onsuccess = function () {
          db = request.result;
          if (settled) { db.close(); return; }
          try {
            transaction = db.transaction(STORE, operation === 'read' ? 'readonly' : 'readwrite');
            const store = transaction.objectStore(STORE);
            const entry = operation === 'read' ? store.get('current')
              : operation === 'write' ? store.put(value, 'current') : store.delete('current');
            transaction.oncomplete = function () { finish(undefined, entry.result); };
            transaction.onabort = function () { finish(transaction?.error || new Error('设备存储操作失败')); };
            transaction.onerror = function () { finish(transaction?.error || new Error('设备存储操作失败')); };
          } catch (error) { finish(error); }
        };
      });
    });
    queue = result;
    return result;
  }
  return {
    /** @returns {Promise<DeviceSession | null>} */
    async load() {
      const value = await run('read');
      if (!value) return null;
      if (!isLoginSession(value)) { await run('clear'); return null; }
      const record = /** @type {DeviceSession} */ (value);
      if (record.key !== null && (!(record.key instanceof CryptoKey) || record.key.extractable
        || record.key.algorithm.name !== 'AES-GCM' || record.key.type !== 'secret')) {
        await run('clear'); return null;
      }
      if (typeof record.configId !== 'string') { await run('clear'); return null; }
      return record;
    },
    /** @param {DeviceSession} value */
    async save(value) { await run('write', value); },
    async clear() { await run('clear'); }
  };
}
