import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loginWithToken, isLoginSession } from '../public/login-flow.js';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const session = () => ({ token: 'signed.session', vaultId: 'default', expiresAt: Date.now() + 60000 });

test('Safari login needs one JSON request, without cookies, probes or native navigation', async () => {
  const calls = [];
  const expected = session();
  const result = await loginWithToken('correct-password', async (url, options) => {
    calls.push({url, options});
    return expected;
  });
  assert.deepEqual(result, expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/login');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {password: 'correct-password'});
});

test('wrong passwords and incomplete/expired sessions never initiate a native fallback', async () => {
  await assert.rejects(loginWithToken('wrong', async () => { throw new Error('unauthorized'); }), /unauthorized/);
  for (const response of [{ok: true}, null, {...session(), expiresAt: 1}]) {
    await assert.rejects(loginWithToken('secret', async () => response), /更新服务端/);
  }
  assert.equal(isLoginSession({...session(), token: 'x'.repeat(4097)}), false);
});

test('login keeps Safari password autofill and a single keyboard submit path', async () => {
  const html = await read('public/index.html');
  const app = await read('public/app.js');
  assert.match(html, /<form[^>]*id="loginForm"[^>]*method="post"[^>]*autocomplete="on"/);
  assert.match(html, /id="passwordInput"[^>]*autocomplete="current-password"[^>]*name="password"/);
  assert.match(html, /id="loginBtn"[^>]*type="submit"/);
  assert.match(html, /id="rememberDevice"[^>]*type="checkbox" checked/);
  assert.ok(app.includes("els.loginForm.addEventListener('submit'"));
  assert.ok(app.includes('event.preventDefault()'));
  assert.ok(app.includes("if (state.authMode === 'checking' || state.loginSubmitting) return"));
  assert.doesNotMatch(app, /HTMLFormElement\.prototype\.submit|loginCsrfToken|loginWithSessionProbe/);
  assert.ok(!app.includes("els.passwordInput.addEventListener('keydown'"));
  assert.ok(app.includes('await unlockVault(els.unlockPasswordInput.value, true)'));
});

test('API transport uses same-origin Authorization, no token URLs or password persistence', async () => {
  const app = await read('public/app.js');
  assert.ok(app.includes("headers.set('authorization', 'Bearer ' + activeSession.token)"));
  assert.ok(app.includes("mode: 'same-origin', cache: 'no-store'"));
  assert.doesNotMatch(app, /localStorage\.setItem|sessionStorage\.setItem/);
  const persisted = app.slice(app.indexOf('await deviceStore.save('), app.indexOf('async function checkSession'));
  assert.doesNotMatch(persisted, /password:|passphrase:/);
  assert.ok(persisted.includes('key: state.vaultUnlocked ? state.vaultKey : null'));
  const logout = app.slice(app.indexOf('async function logout()'), app.indexOf('function resetLocalSession()'));
  assert.ok(logout.includes('resetLocalSession()'));
  assert.ok(logout.includes('await deviceStore.clear()'));
  assert.ok(logout.indexOf('await deviceStore.clear()') < logout.indexOf('await request;'));
});
