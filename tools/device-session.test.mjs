import assert from 'node:assert/strict';
import test from 'node:test';
import { clearLegacyDeviceStore, createLogoutSignal, LOGOUT_EVENT_KEY } from '../public/device-session.js';

function memoryStorage() {
  const data = new Map();
  return {getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k)};
}
test('logout notifies memory-only tabs without leaving a storage record', () => {
  const events = [];
  const data = new Map();
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem(key, value) { data.set(key, value); events.push({key, newValue: value}); },
    removeItem(key) { if (data.delete(key)) events.push({key, newValue: null}); }
  };
  const store = createLogoutSignal(storage);
  assert.equal(events.length, 0);
  store.notifyLogout();
  assert.equal(events[0].key, LOGOUT_EVENT_KEY);
  assert.equal(typeof events[0].newValue, 'string');
  assert.equal(data.size, 0, 'logout signals do not leave another persisted record');
});

test('storage denial is reported to the caller without an asynchronous lock or timeout', () => {
  const store = createLogoutSignal({getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}});
  assert.throws(()=>store.notifyLogout(),/denied/);
});

test('legacy localStorage and IndexedDB cleanup do not suppress each other', () => {
  const removed = [];
  const storage = {
    removeItem(key) {
      removed.push(key);
      if (key.endsWith('.v3')) throw new Error('storage denied');
    }
  };
  const deleted = [];
  clearLegacyDeviceStore({ storage, indexedDB: { deleteDatabase(name) { deleted.push(name); } } });
  assert.deepEqual(removed, ['private-notes.session.v3', 'private-notes.session.v2']);
  assert.deepEqual(deleted, ['private-notes-device']);
});
