import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function readProjectFile(path) {
	return readFile(new URL(path, root), 'utf8');
}

test('mobile login uses a native password form with a handled submit event', async () => {
	const [html, app] = await Promise.all([
		readProjectFile('public/index.html'),
		readProjectFile('public/app.js'),
	]);
	const form = html.match(/<form\b[^>]*\bid=["']loginForm["'][^>]*>[\s\S]*?<\/form>/i);

	assert.ok(form, 'the login controls must be inside a native form so iOS Safari can submit from the keyboard');
	assert.match(form[0], /\baction=["']\/api\/login["']/i);
	assert.match(form[0], /\bmethod=["']post["']/i);
	assert.match(form[0], /\bautocomplete=["']on["']/i);
	assert.match(form[0], /<input\b[^>]*\bid=["']passwordInput["'][^>]*\bautocomplete=["']current-password["'][^>]*\bname=["']password["']/i);
	assert.match(form[0], /<input\b[^>]*\bid=["']passwordInput["'][^>]*\brequired(?:\s|>)/i);
	assert.doesNotMatch(form[0].match(/<input\b[^>]*\bid=["']passwordInput["'][^>]*>/i)?.[0] || '', /\sdisabled(?:\s|>)/i,
		'the password field must stay eligible for Safari/password-manager autofill while session status is checked');
	assert.match(form[0], /<button\b(?=[^>]*\bid=["']loginBtn["'])(?=[^>]*\btype=["']submit["'])[^>]*>/i);
	const unlockForm = html.match(/<form\b[^>]*\bid=["']unlockForm["'][^>]*>[\s\S]*?<\/form>/i);
	assert.ok(unlockForm, 'local unlock must use a separate form so password managers do not save it as a server login');
	assert.match(unlockForm[0], /\bautocomplete=["']off["']/i);
	const unlockInput = unlockForm[0].match(/<input\b[^>]*\bid=["']unlockPasswordInput["'][^>]*>/i)?.[0] || '';
	assert.match(unlockInput, /\btype=["']password["']/i);
	assert.match(unlockInput, /\bautocomplete=["']off["']/i);
	assert.doesNotMatch(unlockInput, /\bname=["']password["']/i);
	assert.doesNotMatch(unlockInput, /\bautocomplete=["']current-password["']/i);
	assert.match(app, /els\.loginForm\.addEventListener\(["']submit["']/);
	assert.match(app, /els\.unlockForm\.addEventListener\(["']submit["']/);
	assert.match(app, /event\.preventDefault\(\)/);
	assert.match(app, /fetch\(url, Object\.assign\(\{ credentials: ['"]same-origin['"] \}/);
	assert.match(app, /loginSubmitting/);
	assert.match(app, /if \([^\n]*state\.loginSubmitting\) return/);
	const loginRequest = app.indexOf("await api('/api/login'");
	assert.ok(loginRequest >= 0);
	const sessionProbe = app.indexOf("const session = await api('/api/session')", loginRequest);
	const localUnlock = app.indexOf('await unlockVault(password, performedLogin)', loginRequest);
	assert.ok(sessionProbe > loginRequest && localUnlock > sessionProbe,
		'the browser must verify its cookie-backed session before deriving the local vault key');
	assert.match(app, /站点访问会话仍然有效[\s\S]*不会再次登录/);
	assert.match(`${html}\n${app}`, /(?:密码和密钥都不会持久化|只在当前页面内用于派生本地解密密钥)/);
	assert.doesNotMatch(app, /els\.passwordInput\.addEventListener\(["']keydown["']/,
		'the submit event must be the single Enter-key path, avoiding duplicate login attempts');
});
