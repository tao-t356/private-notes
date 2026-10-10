import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceSessionStore, DEVICE_SESSION_KEY, LEGACY_DEVICE_SESSION_KEY, LOGOUT_EVENT_KEY } from '../public/device-session.js';

function memoryStorage() {
  const data = new Map();
  return {getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k)};
}
const record = () => ({token: 'signed.session', vaultId: 'default', expiresAt: Date.now() + 60000});

test('a simple JSON record restores only the server session, never a vault key', () => {
  const storage = memoryStorage();
  const original = record();
  createDeviceSessionStore(storage).save({...original, password: 'never-save-this', key: 'never-save-this-key'});
  const restored = createDeviceSessionStore(storage).load();
  assert.deepEqual(restored, original);
  assert.ok(!storage.getItem(DEVICE_SESSION_KEY).includes('never-save-this'));
  assert.doesNotMatch(storage.getItem(DEVICE_SESSION_KEY), /"key"|"configId"/);
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
  for (const bad of [{...record(),expiresAt:1},{...record(),key:{}},{...record(),key:'bad'}, {...record(),configId:null}, {...record(), extra:'unexpected'}, null]) {
    storage.setItem(DEVICE_SESSION_KEY, JSON.stringify(bad));
    assert.equal(store.load(),null);
    assert.equal(storage.getItem(DEVICE_SESSION_KEY), null);
  }
  storage.setItem(DEVICE_SESSION_KEY,'broken JSON');
  assert.equal(store.load(),null);
});

test('legacy key-bearing records are never loaded and can be retired', () => {
  const storage = memoryStorage();
  const store = createDeviceSessionStore(storage);
  storage.setItem(LEGACY_DEVICE_SESSION_KEY, JSON.stringify({token:'old', key:'secret'}));
  assert.equal(store.load(), null);
  store.forgetLegacy();
  assert.equal(storage.getItem(LEGACY_DEVICE_SESSION_KEY), null);
});
test('logout notifies memory-only tabs without leaving a storage record', () => {
  const events = [];
  const data = new Map();
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem(key, value) { data.set(key, value); events.push({key, newValue: value}); },
    removeItem(key) { if (data.delete(key)) events.push({key, newValue: null}); }
  };
  const store = createDeviceSessionStore(storage);
  store.clear();
  assert.equal(events.length, 0);
  store.notifyLogout();
  assert.equal(events[0].key, LOGOUT_EVENT_KEY);
  assert.equal(typeof events[0].newValue, 'string');
  assert.equal(data.size, 0, 'logout signals do not leave another persisted record');
});

test('storage denial is reported to the caller without an asynchronous lock or timeout', () => {
  const store = createDeviceSessionStore({getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}});
  assert.throws(()=>store.load(),/denied/);
  assert.throws(()=>store.save(record()),/denied/);
});
