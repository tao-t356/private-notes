import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const root = new URL('../', import.meta.url);

async function readProjectFile(path) {
	return readFile(new URL(path, root), 'utf8');
}

async function loadLoginWithSessionProbe() {
	const source = await readProjectFile('public/login-flow.js');
	const context = { result: null };
	runInNewContext(source.replace(/export\s+/g, '') + '\nresult = loginWithSessionProbe;', context);
	return context.result;
}

test('Safari falls back to the native form only after an unauthenticated session probe', async () => {
	const loginWithSessionProbe = await loadLoginWithSessionProbe();
	const calls = [];
	const events = [];
	let nativeFallbacks = 0;
	const request = async (url, options) => {
		events.push(`request:${url}`);
		calls.push({ url, options });
		if (url === '/api/login') return { ok: true };
		if (url === '/api/session') return { ok: true, authenticated: false };
		if (url === '/api/login/form-token') return { ok: true, token: 't'.repeat(43) };
		throw new Error(`unexpected URL: ${url}`);
	};

	assert.equal(
		await loginWithSessionProbe('correct-password', request, () => {
			events.push('native-form');
			nativeFallbacks += 1;
		}),
		'native-form'
	);
	assert.equal(nativeFallbacks, 1);
	assert.deepEqual(events, [
		'request:/api/login',
		'request:/api/session',
		'request:/api/login/form-token',
		'native-form',
	]);
	assert.deepEqual(calls.map(({ url }) => url), ['/api/login', '/api/session', '/api/login/form-token']);
	assert.ok(calls.every(({ url }) => !url.includes('correct-password')),
		'passwords must stay in request bodies, never URLs');
	assert.ok(calls.every(({ url }) => !/[?&](?:password|token)=/i.test(url)),
		'passwords and session tokens must not be placed in URL query parameters');
	assert.equal(JSON.parse(calls[0].options.body).password, 'correct-password');
});

test('Safari obtains a one-time native form token before submitting without Origin', async () => {
	const loginWithSessionProbe = await loadLoginWithSessionProbe();
	const events = [];
	const request = async (url) => {
		events.push(`request:${url}`);
		if (url === '/api/login') return { ok: true };
		if (url === '/api/session') return { ok: true, authenticated: false };
		if (url === '/api/login/form-token') return { ok: true, token: 't'.repeat(43) };
		throw new Error(`unexpected URL: ${url}`);
	};

	let submittedToken = '';
	assert.equal(
		await loginWithSessionProbe('correct-password', request, (token) => {
			submittedToken = token;
		}),
		'native-form'
	);
	assert.deepEqual(events, [
		'request:/api/login',
		'request:/api/session',
		'request:/api/login/form-token',
	]);
	assert.equal(submittedToken, 't'.repeat(43));
});

test('Safari keeps the JSON flow when the session probe authenticates', async () => {
	const loginWithSessionProbe = await loadLoginWithSessionProbe();
	let nativeFallbacks = 0;
	const result = await loginWithSessionProbe('correct-password', async (url) => {
		if (url === '/api/login') return { ok: true };
		return { ok: true, authenticated: true };
	}, () => { nativeFallbacks += 1; });

	assert.equal(result, 'session');
	assert.equal(nativeFallbacks, 0);
});

test('Safari does not invoke the native fallback when JSON login rejects', async () => {
	const loginWithSessionProbe = await loadLoginWithSessionProbe();
	const calls = [];
	let nativeFallbacks = 0;

	await assert.rejects(
		() => loginWithSessionProbe('wrong-password', async (url, options) => {
			calls.push({ url, options });
			throw new Error('unauthorized');
		}, () => { nativeFallbacks += 1; }),
		/unauthorized/
	);
	assert.equal(nativeFallbacks, 0);
	assert.deepEqual(calls.map(({ url }) => url), ['/api/login']);
	assert.ok(calls.every(({ url }) => !url.includes('wrong-password')),
		'wrong passwords must not appear in URLs either');
	assert.ok(calls.every(({ url }) => !/[?&](?:password|token)=/i.test(url)),
		'passwords and session tokens must not be placed in URL query parameters');
});

test('mobile login uses a native password form with a handled submit event', async () => {
	const [html, app] = await Promise.all([
		readProjectFile('public/index.html'),
		readProjectFile('public/app.js'),
	]);
	const form = html.match(/<form\b[^>]*\bid=["']loginForm["'][^>]*>[\s\S]*?<\/form>/i);

	assert.ok(form, 'the login controls must be inside a native form so iOS Safari can submit from the keyboard');
	assert.match(form[0], /\baction=["']\/api\/login["']/i);
	assert.match(form[0], /\bmethod=["']post["']/i);
	assert.match(form[0], /<input\b[^>]*\bid=["']loginCsrfToken["'][^>]*\btype=["']hidden["'][^>]*\bname=["']login_csrf_token["']/i);
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
	assert.match(app, /loginCsrfToken\.value = token/);
	assert.match(app, /HTMLFormElement\.prototype\.submit\.call\(els\.loginForm\)/);
	assert.match(app, /loginSubmitting/);
	assert.match(app, /if \([^\n]*state\.loginSubmitting\) return/);
	assert.match(app, /import \{ loginWithSessionProbe \} from ['"]\.\/login-flow\.js['"]/);
	const loginRequest = app.indexOf('loginWithSessionProbe(');
	assert.ok(loginRequest >= 0);
	const localUnlock = app.indexOf('await unlockVault(password, performedLogin)', loginRequest);
	assert.ok(localUnlock > loginRequest,
		'the browser must verify its cookie-backed session before deriving the local vault key');
	assert.match(app, /await unlockVault\(els\.unlockPasswordInput\.value, true\)/,
		'the authenticated native-form fallback must initialize a missing key check after verifying existing notes');
	assert.match(app, /站点访问会话仍然有效[\s\S]*不会再次登录/);
	assert.match(`${html}\n${app}`, /(?:密码和密钥都不会持久化|只在当前页面内用于派生本地解密密钥)/);
	assert.doesNotMatch(app, /els\.passwordInput\.addEventListener\(["']keydown["']/,
		'the submit event must be the single Enter-key path, avoiding duplicate login attempts');
});
