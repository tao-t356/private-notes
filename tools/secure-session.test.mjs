import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('server sessions use a seven-day hardened cookie and do not expose bearer tokens', async () => {
  const auth = await read('src/auth.ts');
  const index = await read('src/index.ts');
  assert.match(auth, /SESSION_MAX_AGE_SECONDS\s*=\s*60 \* 60 \* 24 \* 7/);
  assert.match(auth, /HttpOnly; Secure; SameSite=Strict; Path=\//);
  assert.match(index, /\.\.\.\(session\.token \? \{ token: session\.token/);
  assert.match(index, /x-session-token/);
});

test('the browser authenticates with the HttpOnly cookie and persists only a CryptoKey', async () => {
  const app = await read('public/app.js');
  const html = await read('public/index.html');
  assert.doesNotMatch(app, /localStorage.*token|password.*localStorage/);
  assert.match(app, /createVaultKeyStore/);
  assert.match(app, /await vaultKeyStore\.load/);
  assert.match(app, /await vaultKeyStore\.save/);
  assert.match(app, /x-session-token/);
  assert.match(app, /credentials:\s*'same-origin'/);
  assert.match(html, /只保存不可导出的解密密钥/);
});
