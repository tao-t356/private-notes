import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createDeviceSessionStore } from '../public/device-session.js';

async function record() {
  return { token: 'signed.session', vaultId: 'default', expiresAt: Date.now() + 60000,
    key: await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']), configId: 'vault-config' };
}

test('non-extractable keys survive closing and reopening storage and still decrypt', async () => {
  const factory = new IDBFactory();
  const original = await record();
  await createDeviceSessionStore(factory).save(original);
  const restored = await createDeviceSessionStore(factory).load();
  assert.equal(restored.token, original.token);
  assert.equal(restored.key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', restored.key));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, original.key, new TextEncoder().encode('笔记'));
  const decrypted = await crypto.subtle.decrypt({name: 'AES-GCM', iv}, restored.key, encrypted);
  assert.equal(new TextDecoder().decode(decrypted), '笔记');
  assert.deepEqual(Object.keys(restored).sort(), ['configId', 'expiresAt', 'key', 'token', 'vaultId']);
});

test('logout waits for pending writes, clears the record and is idempotent', async () => {
  const store = createDeviceSessionStore(new IDBFactory());
  const pending = store.save(await record());
  const clearing = store.clear();
  await Promise.all([pending, clearing]);
  assert.equal(await store.load(), null);
  await store.clear();
  assert.equal(await store.load(), null);
});

test('expired, extractable and corrupt device records are discarded', async () => {
  const store = createDeviceSessionStore(new IDBFactory());
  const original = await record();
  for (const bad of [
    {...original, expiresAt: 1}, {...original, key: {}}, {...original, configId: null},
    {...original, key: await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt'])}
  ]) {
    await store.save(bad);
    assert.equal(await store.load(), null);
    assert.equal(await store.load(), null);
  }
});

test('an authenticated but locked vault can remember just its session', async () => {
  const store = createDeviceSessionStore(new IDBFactory());
  const saved = {...await record(), key: null, configId: ''};
  await store.save(saved);
  assert.deepEqual(await store.load(), saved);
});

test('blocked storage reports failure rather than breaking subsequent memory-only login', async () => {
  const store = createDeviceSessionStore({open() { throw new Error('SecurityError'); }});
  await assert.rejects(store.load(), /SecurityError/);
  await assert.rejects(store.save(await record()), /SecurityError/);
});
