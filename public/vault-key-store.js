/**
 * A small persistence boundary for the vault's non-extractable CryptoKey.
 * Passwords and exported key bytes are deliberately not accepted by this API.
 */
export const VAULT_KEY_DB_NAME = 'private-notes-vault-key-v1';
export const VAULT_KEY_STORE_NAME = 'keys';
export const VAULT_KEY_OPERATION_TIMEOUT_MS = 5000;
const VAULT_KEY_RECORD_ID = 'current';

/**
 * @typedef {{ id: string, vaultId: string, configId: string, key: CryptoKey }} VaultKeyRecord
 * @typedef {{ get: (signal?: AbortSignal) => Promise<unknown>, put: (value: VaultKeyRecord, signal?: AbortSignal) => Promise<void>, delete: (signal?: AbortSignal) => Promise<void> }} VaultKeyBackend
 */

/** @param {unknown} identity */
function validateIdentity(identity) {
  if (!identity || typeof identity !== 'object') throw new TypeError('vault key identity is required');
  const value = /** @type {{ vaultId?: unknown, configId?: unknown }} */ (identity);
  if (typeof value.vaultId !== 'string' || !value.vaultId || typeof value.configId !== 'string' || !value.configId) {
    throw new TypeError('vault key identity is invalid');
  }
  return { vaultId: value.vaultId, configId: value.configId };
}

/** @param {CryptoKey} key */
function validateKey(key) {
  if (!key || typeof key !== 'object' || key.extractable !== false) {
    throw new TypeError('only a non-extractable key can be persisted');
  }
  const algorithm = /** @type {AesKeyAlgorithm} */ (key.algorithm);
  if (algorithm.name !== 'AES-GCM' || algorithm.length !== 256) {
    throw new TypeError('only a 256-bit AES-GCM key can be persisted');
  }
  if (!key.usages?.includes('encrypt') || !key.usages?.includes('decrypt')) {
    throw new TypeError('vault key must support encryption and decryption');
  }
}

/** @param {unknown} key */
function isVaultKey(key) {
  if (!key || typeof key !== 'object') return false;
  const cryptoKey = /** @type {CryptoKey} */ (key);
  const algorithm = /** @type {AesKeyAlgorithm} */ (cryptoKey.algorithm);
  return cryptoKey.extractable === false
    && algorithm.name === 'AES-GCM'
    && algorithm.length === 256
    && cryptoKey.usages.includes('encrypt')
    && cryptoKey.usages.includes('decrypt');
}

/** @param {unknown} value */
function isRecord(value) {
  if (!value || typeof value !== 'object') return false;
  const record = /** @type {Partial<VaultKeyRecord>} */ (value);
  const key = record.key;
  return record.id === VAULT_KEY_RECORD_ID
    && typeof record.vaultId === 'string'
    && typeof record.configId === 'string'
    && Boolean(key)
    && isVaultKey(key);
}

/**
 * Dependency-free backend used by tests and embedders that provide their own
 * persistence. It intentionally keeps the CryptoKey object, never raw bytes.
 */
export function createMemoryVaultKeyBackend() {
  /** @type {VaultKeyRecord | null} */
  let record = null;
  return {
    async get() { return record; },
    /** @param {VaultKeyRecord} value */
    async put(value) { record = value; },
    async delete() { record = null; },
    /** @returns {VaultKeyRecord | null} */
    snapshot() { return record; }
  };
}

/** @param {IDBRequest} request @param {AbortSignal} [signal] */
function requestResult(request, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      try { request.transaction?.abort(); } catch { /* The request may already be complete. */ }
      reject(new Error('IndexedDB operation aborted'));
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

/** @param {AbortSignal} [signal] */
function openDatabase(signal) {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is unavailable'));
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    /** @param {() => void} callback */
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => reject(new Error('IndexedDB open aborted')));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      request = indexedDB.open(VAULT_KEY_DB_NAME, 1);
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(VAULT_KEY_STORE_NAME)) {
        request.result.createObjectStore(VAULT_KEY_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => finish(() => {
      if (signal?.aborted) {
        request.result.close();
        reject(new Error('IndexedDB open aborted'));
      } else {
        resolve(request.result);
      }
    });
    request.onerror = () => finish(() => reject(request.error || new Error('IndexedDB open failed')));
    request.onblocked = () => finish(() => reject(new Error('IndexedDB is blocked')));
  });
}

/** @param {IDBTransactionMode} mode @param {(store: IDBObjectStore, signal?: AbortSignal) => Promise<unknown>} operation @param {AbortSignal} [signal] */
async function withStore(mode, operation, signal) {
  const database = await openDatabase(signal);
  try {
    const transaction = database.transaction(VAULT_KEY_STORE_NAME, mode);
    const abortTransaction = () => {
      try { transaction.abort(); } catch { /* The transaction may already be complete. */ }
    };
    if (signal?.aborted) abortTransaction();
    signal?.addEventListener('abort', abortTransaction, { once: true });
    const store = transaction.objectStore(VAULT_KEY_STORE_NAME);
    const completion = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
    const result = await operation(store, signal);
    await completion;
    return result;
  } finally {
    database.close();
  }
}

function createIndexedDbBackend() {
  return {
    /** @param {AbortSignal} [signal] */
    async get(signal) {
      return withStore('readonly', (store, operationSignal) => requestResult(store.get(VAULT_KEY_RECORD_ID), operationSignal), signal);
    },
    /** @param {VaultKeyRecord} value @param {AbortSignal} [signal] */
    async put(value, signal) {
      await withStore('readwrite', (store, operationSignal) => requestResult(store.put(value), operationSignal), signal);
    },
    /** @param {AbortSignal} [signal] */
    async delete(signal) {
      await withStore('readwrite', (store, operationSignal) => requestResult(store.delete(VAULT_KEY_RECORD_ID), operationSignal), signal);
    }
  };
}

/**
 * @param {{ backend?: VaultKeyBackend, timeoutMs?: number }} [options]
 */
export function createVaultKeyStore(options = {}) {
  const backend = options.backend || createIndexedDbBackend();
  const configuredTimeout = options.timeoutMs;
  const timeoutMs = typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : VAULT_KEY_OPERATION_TIMEOUT_MS;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /**
   * Every operation shares one queue. A timed out backend operation is
   * released from the queue so the caller can use the password path instead
   * of leaving startup in a restoring state forever.
   * @param {string} name
   * @param {(signal?: AbortSignal) => Promise<unknown>} operation
   */
  function enqueue(name, operation) {
    const task = queue.then(async () => {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const work = Promise.resolve().then(() => operation(controller?.signal));
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller?.abort();
          reject(new Error(`IndexedDB ${name} timed out`));
        }, timeoutMs);
      });
      try {
        return await Promise.race([work, deadline]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
    queue = task.then(() => undefined, () => undefined);
    return task;
  }

  return {
    /** @param {{ vaultId: string, configId: string }} identity */
    async load(identity) {
      const expected = validateIdentity(identity);
      const value = /** @type {VaultKeyRecord | null} */ (await enqueue('load', signal => backend.get(signal)));
      if (!value) return null;
      if (!isRecord(value) || value.vaultId !== expected.vaultId || value.configId !== expected.configId) {
        await enqueue('delete', signal => backend.delete(signal));
        return null;
      }
      return value.key;
    },
    /** @param {{ vaultId: string, configId: string, key: CryptoKey }} value */
    async save(value) {
      const identity = validateIdentity(value);
      validateKey(value.key);
      await enqueue('save', signal => backend.put({ id: VAULT_KEY_RECORD_ID, vaultId: identity.vaultId, configId: identity.configId, key: value.key }, signal));
    },
    async clear() {
      await enqueue('delete', signal => backend.delete(signal));
    }
  };
}
