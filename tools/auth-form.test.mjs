import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loginWithToken, isLoginSession } from '../public/login-flow.js';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const session = () => ({token:'signed.session', vaultId:'default', expiresAt:Date.now()+60000});

test('one password uses exactly one JSON login, without native forms or session probes', async () => {
  const calls=[];
  const expected=session();
  assert.deepEqual(await loginWithToken('123456',async (url,options)=>{calls.push({url,options});return expected;}),expected);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'/api/login');
  assert.deepEqual(JSON.parse(calls[0].options.body),{password:'123456'});
  assert.equal(calls[0].options.headers['content-type'],'application/json');
});

test('wrong passwords and invalid sessions fail without switching login protocols',async()=>{
  await assert.rejects(loginWithToken('wrong',async()=>{throw new Error('unauthorized');}),/unauthorized/);
  for(const value of [null,{ok:true},{...session(),expiresAt:1}]) {
    await assert.rejects(loginWithToken('password',async()=>value),/更新服务端/);
  }
  assert.equal(isLoginSession({...session(),token:'x'.repeat(4097)}),false);
});

test('one login form supports autofill and stays disabled if the script never loads',async()=>{
  const html=await read('public/index.html');
  const app=await read('public/app.js');
  assert.equal((html.match(/<form\b/g)||[]).length,1);
  assert.match(html,/id="passwordInput"[^>]*autocomplete="current-password"[^>]*name="password"/);
  assert.match(html,/id="passwordInput"[^>]*autocapitalize="none"[^>]*autocorrect="off"/);
  assert.match(html,/id="loginBtn"[^>]*type="submit" disabled/);
  assert.match(html,/id="rememberDevice"[^>]*type="checkbox" checked/);
  assert.match(html,/<script defer src="\/app.bundle.js\?[^\"]+"><\/script>/);
  assert.doesNotMatch(html,/type="module"|id="unlockForm"|id="unlockPasswordInput"/);
  assert.ok(app.includes("els.loginForm.addEventListener('submit'"));
  assert.ok(app.includes('if (state.loginSubmitting) return'));
  assert.doesNotMatch(app,/HTMLFormElement\.prototype\.submit|loginWithSessionProbe|BroadcastChannel/);
  assert.ok(app.includes('generation !== authGeneration'));
  assert.ok(app.includes('await loadNotesAfterLogin()'));
});

test('single-file Safari build and HTML revalidation prevent mixed old login modules',async()=>{
  const build=await read('tools/build-client.mjs');
  const bundle=await read('public/app.bundle.js');
  const headers=await read('public/_headers');
  assert.ok(build.includes("target: ['safari12']"));
  assert.ok(build.includes("format: 'iife'"));
  assert.ok(bundle.length>1000);
  assert.doesNotMatch(bundle,/\bimport\s*\(/);
  assert.match(headers,/\/app.bundle.js\s+! Cache-Control\s+Cache-Control: no-store/);
});

test('remembered data contains no password, and logout clears it without waiting for the network',async()=>{
  const app=await read('public/app.js');
  const persisted=app.slice(app.indexOf('deviceStore.save('),app.indexOf('async function loadNotesAfterLogin'));
  assert.doesNotMatch(persisted,/password:|passphrase:/);
  assert.ok(persisted.includes('key: state.vaultUnlocked ? vaultKeyBytes : null'));
  assert.ok(app.includes("headers.set('authorization', 'Bearer ' + activeSession.token)"));
  const logout=app.slice(app.indexOf('async function logout()'),app.indexOf('function resetLocalSession()'));
  assert.ok(logout.indexOf('deviceStore.clear()')<logout.indexOf('await request;'));
});
