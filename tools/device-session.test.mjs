import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceSessionStore, DEVICE_SESSION_KEY } from '../public/device-session.js';

function memoryStorage() {
  const data = new Map();
  return {getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k)};
}
const record = () => ({token: 'signed.session', vaultId: 'default', expiresAt: Date.now() + 60000,
  key: btoa('k'.repeat(32)), configId: 'vault-config'});

test('a simple JSON record restores a session without IndexedDB or CryptoKey cloning', async () => {
  const storage = memoryStorage();
  const original = record();
  createDeviceSessionStore(storage).save({...original, password: 'never-save-this'});
  const restored = createDeviceSessionStore(storage).load();
  assert.deepEqual(restored, original);
  assert.ok(!storage.getItem(DEVICE_SESSION_KEY).includes('never-save-this'));
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(restored.key), c => c.charCodeAt(0)), 'AES-GCM', false, ['encrypt','decrypt']);
  assert.equal(key.extractable, false);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode('笔记'));
  assert.equal(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv},key,encrypted)),'笔记');
});

test('logout clears the only device record synchronously and is idempotent', () => {
  const storage = memoryStorage();
  const store = createDeviceSessionStore(storage);
  store.save(record());
  store.clear();
  assert.equal(store.load(), null);
  store.clear();
  assert.equal(storage.getItem(DEVICE_SESSION_KEY), null);
});

test('expired, malformed and corrupt records are discarded', () => {
  const storage = memoryStorage();
  const store = createDeviceSessionStore(storage);
  for (const bad of [{...record(),expiresAt:1},{...record(),key:{}},{...record(),key:'bad'}, {...record(),configId:null}, null]) {
    storage.setItem(DEVICE_SESSION_KEY, JSON.stringify(bad));
    assert.equal(store.load(),null);
    assert.equal(storage.getItem(DEVICE_SESSION_KEY), null);
  }
  storage.setItem(DEVICE_SESSION_KEY,'broken JSON');
  assert.equal(store.load(),null);
});

test('storage denial is reported to the caller without an asynchronous lock or timeout', () => {
  const store = createDeviceSessionStore({getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}});
  assert.throws(()=>store.load(),/denied/);
  assert.throws(()=>store.save(record()),/denied/);
});
