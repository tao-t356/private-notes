import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loginWithToken, isLoginSession } from '../public/login-flow.js';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const session = () => ({vaultId:'default'});

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
  for(const value of [null,{ok:true},{...session(),vaultId:''}]) {
    await assert.rejects(loginWithToken('password',async()=>value),/更新服务端/);
  }
  assert.equal(isLoginSession({...session(),vaultId:''}),false);
});

test('index startup leaves the static login form visible until the bundle runs',async()=>{
  const html=await read('public/index.html');
  assert.match(html,/id="loginView"[^>]*class="login-wrap"(?! hidden)/);
  assert.match(html,/id="loginForm"[^>]*action="\/api\/login"/);
});

test('one login form supports autofill and stays disabled if the script never loads',async()=>{
  const html=await read('public/index.html');
  const app=await read('public/app.js');
  assert.match(html,/id="loginView"[^>]*class="login-wrap"(?! hidden)/);
  assert.match(html,/id="loadPanel"[^>]*role="status"/);
  assert.match(html,/id="retryLoadBtn"/);
  assert.ok(app.includes('function showRestoring('));
  assert.ok(app.includes('checkSession().catch('));
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
  assert.ok(build.includes("'share.bundle': 'public/share.js'"));
  assert.match(await read('public/share.html'), /<script defer src="\/share.bundle.js\?/);
  assert.ok(build.includes("target: ['safari12']"));
  assert.ok(build.includes("format: 'iife'"));
  assert.ok(bundle.length>1000);
  assert.doesNotMatch(bundle,/\bimport\s*\(/);
  assert.match(headers,/\/app.bundle.js\s+! Cache-Control\s+Cache-Control: no-store/);
});

test('remembered data contains no password, bearer token, or raw key',async()=>{
  const app=await read('public/app.js');
  assert.doesNotMatch(app, /localStorage.*token|password.*localStorage/);
  assert.ok(app.includes('vaultKeyStore.save'));
  assert.ok(app.includes('configId'));
  const logout=app.slice(app.indexOf('async function logout()'),app.indexOf('function resetLocalSession()'));
  assert.ok(logout.indexOf('vaultKeyStore.clear()')<logout.indexOf('await request;'));
});
