import assert from 'node:assert/strict';
import test from 'node:test';
import { DEVICE_SESSION_KEY } from '../public/device-session.js';
import { createVaultFixture, deferred, jsonResponse, loadApp, note, readyApp, storageHub } from './app-test-harness.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function loginWasShown(app) {
  return app.history.some(change => change.id === 'loginView' && change.name === 'hidden' && !change.present);
}

function restoreHandler(fixture, notes = []) {
  return (url) => {
    if (url === '/api/session') return jsonResponse({ ...fixture.session, authenticated: true });
    if (url === '/api/crypto-config') return jsonResponse(fixture.config);
    if (url.startsWith('/api/notes?')) return jsonResponse({ ok: true, notes, nextCursor: null });
    if (url === '/api/logout') return jsonResponse({ ok: true });
    throw new Error('Unexpected request: ' + url);
  };
}

function savedResponse(url, options, revision = 5000) {
  const body = JSON.parse(options.body);
  const id = body.id || decodeURIComponent(url.split('/').pop());
  return jsonResponse({ ok: true, note: { id, title: body.title, content: body.content,
    created_at: 1000, updated_at: revision, revision } }, options.method === 'POST' ? 201 : 200);
}

test('remembered refresh restores the server session and asks for the vault password', async () => {
  const fixture = await createVaultFixture();
  const session = deferred();
  const raw = { ...note(A), title: await fixture.encrypt('私人标题'), content: await fixture.encrypt('私人正文') };
  const handle = restoreHandler(fixture, [raw]);
  const app = await loadApp({ record: fixture.record, fetch: url => url === '/api/session' ? session.promise : handle(url) });
  assert.equal(app.run('state.authView'), 'restoring');
  assert.equal(loginWasShown(app), false);
  assert.equal(app.elements.get('loginView').classList.contains('hidden'), true);
  session.resolve(handle('/api/session'));
  await app.boot;
  assert.equal(app.run('state.authView'), 'login');
  assert.equal(app.run('state.sessionAuthenticated'), true);
  assert.equal(app.run('state.authMode'), 'recover');
  assert.equal(app.run('state.vaultUnlocked'), false);
  assert.equal(app.elements.get('loginView').classList.contains('hidden'), false);
  assert.equal(app.calls.some(call => call.url.startsWith('/api/notes')), false);
  assert.equal(app.run('state.allNotes.length'), 0);
  assert.ok(![...app.hub.data.values()].join('').includes('私人正文'));
});

test('missing and expired records show login without a session request', async () => {
  const empty = await loadApp();
  await empty.boot;
  assert.equal(empty.run('state.authView'), 'login');
  assert.equal(empty.calls.length, 0);
  const fixture = await createVaultFixture();
  const expired = await loadApp({ record: { ...fixture.record, expiresAt: Date.now() - 1 } });
  await expired.boot;
  assert.equal(expired.run('state.authView'), 'login');
  assert.equal(expired.hub.data.has(DEVICE_SESSION_KEY), false);
  assert.equal(expired.calls.length, 0);
});

test('session restoration transient errors keep the record and retry without flashing login', async () => {
  const fixture = await createVaultFixture();
  const handle = restoreHandler(fixture);
  let offline = true;
  const app = await loadApp({ record: fixture.record, fetch: url => {
    if (offline) throw new Error('offline');
    return handle(url);
  } });
  await app.boot;
  assert.equal(app.run('state.authView'), 'restoring');
  assert.equal(loginWasShown(app), false);
  assert.equal(app.hub.data.has(DEVICE_SESSION_KEY), true);
  assert.equal(app.elements.get('retryLoadBtn').classList.contains('hidden'), false);
  assert.equal(app.elements.get('retryLoadBtn').disabled, false);
  offline = false;
  await app.run('checkSession()');
  assert.equal(app.run('state.authView'), 'login');
  assert.equal(app.run('state.authMode'), 'recover');
  assert.equal(loginWasShown(app), true);
});

test('a server-revoked remembered session is cleared and returns to login', async () => {
  const fixture = await createVaultFixture();
  const app = await loadApp({ record: fixture.record, fetch: () => jsonResponse({ ok: true, authenticated: false }) });
  await app.boot;
  assert.equal(app.run('state.authView'), 'login');
  assert.equal(app.run('activeSession'), null);
  assert.equal(app.hub.data.has(DEVICE_SESSION_KEY), false);
});

test('a remembered session is authenticated before the vault password is requested', async () => {
  const fixture = await createVaultFixture();
  const handle = restoreHandler(fixture);
  const app = await loadApp({ record: fixture.record, fetch: handle });
  await app.boot;
  assert.equal(app.run('state.sessionAuthenticated'), true);
  assert.equal(app.run('state.authMode'), 'recover');
  assert.equal(app.run('state.authView'), 'login');
  assert.equal(app.run('state.vaultUnlocked'), false);
  assert.equal(app.calls.some(call => call.url.startsWith('/api/notes')), false);
});

test('list loading errors remain inside the notes view and retry only the list', async () => {
  const fixture = await createVaultFixture();
  const handle = restoreHandler(fixture);
  let unavailable = true;
  const app = await loadApp({ record: fixture.record, fetch: url => {
    if (unavailable && url.startsWith('/api/notes?')) return jsonResponse({ error: 'list unavailable' }, 500);
    return handle(url);
  } });
  await app.boot;
  app.run(`
    activeSession = { token: 'test.signed.session', vaultId: 'default', expiresAt: Date.now() + 600000 };
    state.sessionAuthenticated = true;
    state.vaultUnlocked = true;
    state.vaultKey = null;
    state.cryptoConfig = { vaultSalt: btoa('s'.repeat(16)), cipher: 'aes-gcm-256', kdf: 'pbkdf2-sha256', iterations: 250000, version: 1, keyCheck: 'existing' };
    state.authView = 'app';
    state.listReady = false;
    showApp();
  `);
  await app.run('loadNotesAfterLogin()');
  assert.equal(app.run('state.authView'), 'app');
  assert.equal(app.run('state.vaultUnlocked'), true);
  assert.equal(app.run('state.listReady'), false);
  assert.equal(app.elements.get('retryLoadBtn').classList.contains('hidden'), false);
  unavailable = false;
  await app.run('loadNotesAfterLogin()');
  assert.equal(app.run('state.listReady'), true);
  assert.equal(app.calls.filter(call => call.url === '/api/session').length, 1);
});

test('logout invalidates a late restoration response', async () => {
  const fixture = await createVaultFixture();
  const pendingSession = deferred();
  const app = await loadApp({ record: fixture.record, fetch: url => {
    if (url === '/api/session') return pendingSession.promise;
    if (url === '/api/logout') return jsonResponse({ ok: true });
    throw new Error('Restoration should have stopped');
  } });
  await app.run('logout()');
  pendingSession.resolve(jsonResponse({ ...fixture.session, authenticated: true }));
  await app.boot;
  assert.equal(app.run('state.authView'), 'login');
  assert.equal(app.run('activeSession'), null);
  assert.equal(app.hub.data.size, 0);
  assert.equal(app.calls.find(call => call.url === '/api/logout').options.signal.aborted, false);
});

test('saving locks the editor and keeps the original note and revision across awaits', async () => {
  const app = await readyApp({ notes: [note(A, 'A', 'body A'), note(B, 'B', 'body B', 2000)], fetch: savedResponse });
  const gate = deferred();
  app.context.encryptionGate = gate.promise;
  app.run(`
    const originalEncrypt = encryptValue;
    encryptValue = async function (value, key, config) {
      await encryptionGate;
      return originalEncrypt(value, key, config);
    };
    openComposer(state.allNotes[0]);
    els.editorTitle.value = 'edited A';
    els.editorContent.value = 'edited body A';
  `);
  const saving = app.run('saveComposer()');
  assert.equal(app.elements.get('saveBtn').disabled, true);
  app.elements.get('cancelBtn').click();
  app.run('closeComposer(); openComposer(state.allNotes[1]);');
  assert.equal(app.run('state.editingId'), A);
  app.run('state.allNotes[0].revision = 9999');
  gate.resolve();
  await saving;
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].url, '/api/notes/' + A);
  assert.equal(JSON.parse(app.calls[0].options.body).revision, 1000);
  assert.equal(app.run(`state.allNotes.find(note => note.id === '${B}').content`), 'body B');
  assert.equal(app.elements.get('editorModal').classList.contains('hidden'), true);
});

test('rapid repeated saves create only one note and never reload the list', async () => {
  const app = await readyApp({ fetch: savedResponse });
  app.run("openComposer(null); els.editorTitle.value = 'one note'; els.editorContent.value = 'one body';");
  await Promise.all([app.run('saveComposer()'), app.run('saveComposer()')]);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].options.method, 'POST');
  assert.match(JSON.parse(app.calls[0].options.body).id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(app.run('state.allNotes.length'), 1);
  assert.equal(app.run('state.noteCountMeta'), 1);
});

test('a retry reuses the same ID and encrypted payload after an uncertain creation result', async () => {
  const records = new Map();
  let loseResponse = true;
  const app = await readyApp({ fetch: (url, options) => {
    const body = JSON.parse(options.body);
    const existing = records.get(body.id);
    if (existing) {
      assert.deepEqual(body, existing);
      return savedResponse(url, options);
    }
    records.set(body.id, body);
    if (loseResponse) { loseResponse = false; throw new Error('response lost after commit'); }
    return savedResponse(url, options);
  } });
  app.run("openComposer(null); els.editorTitle.value = 'retry'; els.editorContent.value = 'keep this draft';");
  await assert.rejects(app.run('saveComposer()'), /连接中断/);
  assert.equal(app.elements.get('editorContent').value, 'keep this draft');
  assert.equal(app.run('state.editorSaving'), false);
  await app.run('saveComposer()');
  assert.equal(records.size, 1);
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[0].options.body, app.calls[1].options.body);
  assert.equal(app.run('state.allNotes.length'), 1);
});

test('revision conflicts preserve the draft and unlock the save controls', async () => {
  const app = await readyApp({ notes: [note(A)], fetch: () => jsonResponse({ error: 'revision_conflict' }, 409) });
  app.run("openComposer(state.allNotes[0]); els.editorContent.value = 'my unsaved change';");
  await assert.rejects(app.run('saveComposer()'), /当前输入已保留/);
  assert.equal(app.elements.get('editorModal').classList.contains('hidden'), false);
  assert.equal(app.elements.get('editorContent').value, 'my unsaved change');
  assert.equal(app.elements.get('saveBtn').disabled, false);
  assert.match(app.elements.get('editorStatus').textContent, /当前输入已保留/);
});

test('saving preserves body whitespace and rejects an entirely blank draft', async () => {
  const app = await readyApp({ fetch: savedResponse });
  app.run("openComposer(null); els.editorTitle.value = 'code'; els.editorContent.value = '    return value\\n';");
  await app.run('saveComposer()');
  app.context.savedCiphertext = JSON.parse(app.calls[0].options.body).content;
  assert.equal(await app.run('decryptValue(savedCiphertext)'), '    return value\n');
  assert.equal(app.run('state.allNotes[0].content'), '    return value\n');
  app.run("openComposer(null); els.editorTitle.value = '   '; els.editorContent.value = '\\n  '; ");
  await app.run('saveComposer()');
  assert.equal(app.calls.length, 1);
  assert.match(app.elements.get('editorStatus').textContent, /至少写一个/);
});

test('unremembered tabs receive logout and remove all displayed and indexed plaintext', async () => {
  const hub = storageHub();
  const first = await readyApp({ hub, notes: [note(A, 'secret title', 'secret body')] });
  const second = await readyApp({ hub, notes: [note(A, 'secret title', 'secret body')] });
  first.run('els.rememberDevice.checked = false');
  second.run("els.rememberDevice.checked = false; openComposer(state.allNotes[0]); els.searchInput.value = 'secret';");
  assert.equal(hub.data.size, 0);
  await first.run('logout()');
  assert.equal(second.run('state.authView'), 'login');
  assert.equal(second.run('state.vaultKey'), null);
  assert.equal(second.run('state.searchIndex.size'), 0);
  assert.equal(second.run('state.allNotes.length'), 0);
  assert.equal(second.elements.get('editorTitle').value, '');
  assert.equal(second.elements.get('editorContent').value, '');
  assert.equal(second.elements.get('searchInput').value, '');
  assert.equal(hub.data.size, 0);
});

test('logout during encryption prevents the old draft from being sent', async () => {
  const app = await readyApp({ fetch: savedResponse });
  const gate = deferred();
  app.context.encryptionGate = gate.promise;
  app.run(`
    const originalEncrypt = encryptValue;
    encryptValue = async function(value, key, config) { await encryptionGate; return originalEncrypt(value, key, config); };
    openComposer(null);
    els.editorContent.value = 'discard on logout';
  `);
  const saving = app.run('saveComposer()');
  app.run('resetLocalSession()');
  gate.resolve();
  await saving;
  assert.equal(app.calls.length, 0);
  assert.equal(app.run('state.editorAttempt'), null);
  assert.equal(app.elements.get('editorContent').value, '');
  assert.equal(app.run('state.authView'), 'login');
});

test('a late save response cannot reopen the editor or repopulate a locked page', async () => {
  const requested = deferred();
  const response = deferred();
  const app = await readyApp({ fetch: (url, options) => { requested.resolve({ url, options }); return response.promise; } });
  app.run("openComposer(null); els.editorContent.value = 'old session body';");
  const saving = app.run('saveComposer()');
  const request = await requested.promise;
  app.run('resetLocalSession()');
  response.resolve(savedResponse(request.url, request.options));
  await saving;
  assert.equal(app.run('state.allNotes.length'), 0);
  assert.equal(app.run('state.authView'), 'login');
  assert.equal(app.elements.get('editorContent').value, '');
});

test('rendering is batched but local search still finds notes outside the visible batch', async () => {
  const notes = Array.from({ length: 65 }, (_, index) => note(String(index), 'title ' + index, index === 64 ? 'hidden needle' : 'body'));
  const app = await readyApp({ notes });
  assert.equal(app.elements.get('noteList').querySelectorAll('article').length, 50);
  assert.equal(app.elements.get('loadMoreBtn').classList.contains('hidden'), false);
  app.elements.get('loadMoreBtn').click();
  assert.equal(app.elements.get('noteList').querySelectorAll('article').length, 65);
  assert.equal(app.elements.get('loadMoreBtn').classList.contains('hidden'), true);
  app.run("els.searchInput.value = 'hidden needle'; applySearch();");
  assert.equal(app.run('state.notes.length'), 1);
  assert.equal(app.run('state.notes[0].id'), '64');
  assert.equal(app.calls.length, 0);
});

test('expanding a note updates its card without replacing the list', async () => {
  const app = await readyApp({ notes: [note(A, 'long', Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n'))] });
  const card = app.elements.get('noteList').querySelectorAll('article')[0];
  const toggle = card.querySelectorAll('button').find(button => button.textContent === '展开全文');
  assert.ok(toggle);
  toggle.click();
  assert.equal(app.elements.get('noteList').querySelectorAll('article')[0], card);
  assert.equal(toggle.textContent, '收起');
  assert.equal(app.calls.length, 0);
});

test('search debounces typing, waits for IME completion, and clears immediately', async () => {
  const app = await readyApp({ notes: [note(A, '中文', 'abcdef')] });
  app.run('const originalSearch = applySearch; let searchRuns = 0; applySearch = function () { searchRuns += 1; originalSearch(); };');
  const input = app.elements.get('searchInput');
  input.value = 'abc';
  await input.dispatch('input');
  app.timers.advance(149);
  assert.equal(app.run('searchRuns'), 0);
  app.timers.advance(1);
  assert.equal(app.run('searchRuns'), 1);
  await input.dispatch('compositionstart');
  input.value = '中文';
  await input.dispatch('input');
  app.timers.advance(200);
  assert.equal(app.run('searchRuns'), 1);
  await input.dispatch('compositionend');
  app.timers.advance(150);
  assert.equal(app.run('searchRuns'), 2);
  input.value = 'pending';
  await input.dispatch('input');
  app.elements.get('clearSearchBtn').click();
  assert.equal(app.run('searchRuns'), 3);
  assert.equal(app.run('state.searchQuery'), '');
  app.timers.advance(150);
  assert.equal(app.run('searchRuns'), 3);
  assert.equal(app.calls.length, 0);
});

test('a stale full refresh cannot replace a newer local mutation', async () => {
  const page = deferred();
  const app = await readyApp({ notes: [note(A, 'old', 'old')], fetch: () => page.promise });
  const refresh = app.run('refreshNotes()');
  app.context.updated = note(A, 'new', 'new', 5000);
  app.run('upsertLocalNote(updated)');
  page.resolve(jsonResponse({ notes: [note(A, 'stale', 'stale')], nextCursor: null }));
  await refresh;
  assert.equal(app.run('state.allNotes[0].content'), 'new');
  assert.equal(app.run('state.notesLoading'), false);
  assert.equal(app.elements.get('newBtn').disabled, false);
});

test('delete updates local counts and indexes without requesting any note pages', async () => {
  const app = await readyApp({ notes: [note(A), note(B)], fetch: () => jsonResponse({ ok: true }) });
  app.run(`state.expandedIds.add('${A}')`);
  await Promise.all([app.run(`deleteNote('${A}')`), app.run(`deleteNote('${A}')`)]);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].options.method, 'DELETE');
  assert.equal(app.run('state.noteCountMeta'), 1);
  assert.equal(app.run(`state.searchIndex.has('${A}')`), false);
  assert.equal(app.run(`state.expandedIds.has('${A}')`), false);
});

test('logout prevents a pending key-check initializer from writing through another session', async () => {
  const app = await readyApp();
  const gate = deferred();
  app.context.markerGate = gate.promise;
  app.run(`
    const originalEncrypt = encryptValue;
    encryptValue = async function(value, key, config) { await markerGate; return originalEncrypt(value, key, config); };
  `);
  const initializing = app.run('initializeKeyCheck(state.cryptoConfig)');
  const rejected = assert.rejects(initializing, /登录状态已改变/);
  app.run('resetLocalSession()');
  gate.resolve();
  await rejected;
  assert.equal(app.calls.length, 0);
});

test('logout cancels share creation before an encrypted draft can use another session', async () => {
  const app = await readyApp({ notes: [note(A)] });
  const gate = deferred();
  app.context.shareGate = gate.promise;
  const expiry = app.elements.get('shareExpiry');
  expiry.options = [{ dataset: { shareMode: 'reusable' } }];
  expiry.selectedIndex = 0;
  app.run(`
    openShareDialog(state.allNotes[0]);
    encryptShare = async function () { await shareGate; return {ciphertext:'test', proof:'test', keyFragment:'test'}; };
  `);
  const sharing = app.run('createShareLink()');
  app.run('resetLocalSession()');
  gate.resolve();
  await sharing;
  assert.equal(app.calls.length, 0);
  assert.equal(app.elements.get('shareModal').classList.contains('hidden'), true);
});

test('a late clipboard completion cannot display a secret title after logout', async () => {
  const app = await readyApp({ notes: [note(A, 'secret title', 'body')] });
  const clipboard = deferred();
  app.context.navigator.clipboard.writeText = () => clipboard.promise;
  const button = app.elements.get('noteList').querySelectorAll('button').find(element => element.textContent === '复制全文');
  const copying = button.click();
  app.run('resetLocalSession()');
  clipboard.resolve();
  await copying;
  assert.equal(app.elements.get('statusLine').textContent, '');
});

test('the API deadline covers a stalled response body, not only response headers', async () => {
  const body = deferred();
  const startedBody = deferred();
  const app = await readyApp({ fetch: () => ({ ok: true, status: 200,
    json() { startedBody.resolve(); return body.promise; } }) });
  const request = app.run("api('/api/health')");
  await startedBody.promise;
  const rejected = assert.rejects(request, /连接中断或超时/);
  app.timers.advance(15000);
  await rejected;
  assert.equal(app.calls[0].options.signal.aborted, true);
});
