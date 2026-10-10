import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  VAULT_KEY_DB_NAME,
  VAULT_KEY_STORE_NAME,
  createMemoryVaultKeyBackend,
  createVaultKeyStore
} from '../public/vault-key-store.js';

async function key(extractable = false) {
  return webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt']
  );
}

const metadata = { vaultId: 'default', configId: 'config-1' };

test('the injectable memory backend persists only a non-extractable CryptoKey record', async () => {
  const backend = createMemoryVaultKeyBackend();
  const store = createVaultKeyStore({ backend });
  const cryptoKey = await key(false);

  await store.save({ ...metadata, key: cryptoKey });
  const restored = await store.load(metadata);

  assert.equal(restored, cryptoKey);
  assert.equal(restored.extractable, false);
  assert.deepEqual(Object.keys(backend.snapshot()), ['id', 'vaultId', 'configId', 'key']);
  assert.equal('password' in backend.snapshot(), false);
  assert.equal('rawKey' in backend.snapshot(), false);
});

test('records with another vault or crypto configuration never restore', async () => {
  const backend = createMemoryVaultKeyBackend();
  const store = createVaultKeyStore({ backend });
  await store.save({ ...metadata, key: await key(false) });

  assert.equal(await store.load({ vaultId: 'guest', configId: metadata.configId }), null);
  assert.equal(await store.load({ vaultId: metadata.vaultId, configId: 'config-2' }), null);
  assert.equal(backend.snapshot(), null, 'a mismatched record is retired instead of kept as stale state');
});

test('extractable keys are rejected so raw-exportable vault material is never stored', async () => {
  const store = createVaultKeyStore({ backend: createMemoryVaultKeyBackend() });
  await assert.rejects(
    store.save({ ...metadata, key: await key(true) }),
    /non-extractable/i
  );
});

test('clear is idempotent and removes the persisted key record', async () => {
  const backend = createMemoryVaultKeyBackend();
  const store = createVaultKeyStore({ backend });
  await store.save({ ...metadata, key: await key(false) });
  await store.clear();
  await store.clear();
  assert.equal(await store.load(metadata), null);
});

test('the persistent implementation uses a new dedicated IndexedDB database and object store', () => {
  assert.match(VAULT_KEY_DB_NAME, /^private-notes-vault-key-v1$/);
  assert.notEqual(VAULT_KEY_DB_NAME, 'private-notes-device');
  assert.match(VAULT_KEY_STORE_NAME, /^keys$/);
});

test('save and clear are serialized so logout cannot be overtaken by a late save', async () => {
  let releaseSave;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  let record = null;
  const events = [];
  const backend = {
    async get() { return record; },
    async put(value) {
      events.push('save:start');
      await saveGate;
      record = value;
      events.push('save:end');
    },
    async delete() {
      events.push('clear');
      record = null;
    }
  };
  const store = createVaultKeyStore({ backend });
  const saving = store.save({ ...metadata, key: await key(false) });
  await Promise.resolve();
  const clearing = store.clear();
  await Promise.resolve();
  assert.deepEqual(events, ['save:start']);
  releaseSave();
  await Promise.all([saving, clearing]);
  assert.deepEqual(events, ['save:start', 'save:end', 'clear']);
  assert.equal(record, null);
});

test('a hung key backend times out so callers can fall back to password unlock', async () => {
  const backend = {
    get() { return new Promise(() => {}); },
    async put() {},
    async delete() {}
  };
  const store = createVaultKeyStore({ backend, timeoutMs: 10 });
  const outcome = await Promise.race([
    store.load(metadata).then(() => ({ type: 'resolved' }), error => ({ type: 'error', error })),
    new Promise(resolve => setTimeout(() => resolve({ type: 'hung' }), 100))
  ]);
  assert.notEqual(outcome.type, 'hung', 'key storage must not hold startup indefinitely');
  assert.equal(outcome.type, 'error');
  assert.match(outcome.error.message, /timed out/i);
});
