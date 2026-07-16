import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { decryptSharedPayload, encryptSharedPayload, parseShareKeyFragment } from '../public/share-crypto.js';
import worker from '../src';
import { resolveCookieSecret } from '../src/auth';

const ORIGIN = 'https://example.com';
const DEFAULT_PASSWORD = 'test-default-password-with-strong-entropy';
const GUEST_PASSWORD = 'test-guest-password-with-strong-entropy';

type JsonRecord = Record<string, unknown>;

function encryptedValue(label: string) {
	return `enc:v1:${btoa(JSON.stringify({ iv: btoa('123456789012'), data: btoa(`ciphertext:${label}`) }))}`;
}

function encryptedValueWithDataBytes(byteLength: number) {
	return `enc:v1:${btoa(
		JSON.stringify({ iv: btoa('123456789012'), data: btoa('x'.repeat(byteLength)) })
	)}`;
}

function cookieFrom(response: Response) {
	return (response.headers.get('set-cookie') || '').split(';', 1)[0];
}

async function api(path: string, init?: RequestInit) {
	return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

async function jsonBody(response: Response) {
	return (await response.json()) as JsonRecord;
}

function isolatedD1Binding() {
	return new Proxy(env.DB, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

async function login(password = DEFAULT_PASSWORD, ip = `203.0.113.${Math.floor(Math.random() * 180) + 20}`) {
	const response = await api('/api/login', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'cf-connecting-ip': ip,
		},
		body: JSON.stringify({ password }),
	});
	expect(response.status).toBe(200);
	return { response, cookie: cookieFrom(response) };
}

async function createNote(
	cookie: string,
	label: string,
	id = crypto.randomUUID(),
	content = encryptedValue(`${label}:content`)
) {
	const response = await api('/api/notes', {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify({
			id,
			title: encryptedValue(`${label}:title`),
			content,
		}),
	});
	expect(response.status).toBe(201);
	return (await jsonBody(response)).note as JsonRecord;
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM notes'),
		env.DB.prepare('DELETE FROM note_shares'),
		env.DB.prepare('DELETE FROM app_meta'),
		env.DB.prepare('DELETE FROM auth_rate_limits'),
	]);
});

describe('private-notes worker', () => {
	it('serves the application shell through the Static Assets binding', async () => {
		const response = await env.ASSETS.fetch(new Request(`${ORIGIN}/`));
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(await response.text()).toContain('Private Notes');

		const sharePage = await env.ASSETS.fetch(new Request(`${ORIGIN}/share`));
		expect(sharePage.status).toBe(200);
		expect(sharePage.headers.get('content-type')).toContain('text/html');
		expect(sharePage.headers.get('cache-control')).toBe('no-store');
		expect(sharePage.headers.get('content-security-policy')).toContain("default-src 'self'");
		expect(await sharePage.text()).toContain('查看并销毁');
	});

	it('applies public branding variables to app pages and the PWA manifest', async () => {
		const brandedEnv = {
			...env,
			APP_NAME: 'Tao Notes',
			APP_SHORT_NAME: '我的私人空间',
			APP_DESCRIPTION: '只属于我的加密备忘录。',
		} as Parameters<typeof worker.fetch>[1];

		const appResponse = await worker.fetch(new Request(`${ORIGIN}/`), brandedEnv);
		expect(appResponse.status).toBe(200);
		const appHtml = await appResponse.text();
		expect(appHtml).toContain('<title>Tao Notes</title>');
		expect(appHtml).toContain('data-app-short-name="我的私人空间"');
		expect(appHtml).toContain('>我的私人空间</h1>');
		expect(appHtml).toContain('content="只属于我的加密备忘录。"');
		expect(appResponse.headers.get('etag')).toBeNull();

		const shareResponse = await worker.fetch(new Request(`${ORIGIN}/share`), brandedEnv);
		expect(shareResponse.status).toBe(200);
		expect(await shareResponse.text()).toContain('<div class="login-mini">Tao Notes</div>');

		const manifestResponse = await worker.fetch(
			new Request(`${ORIGIN}/manifest.webmanifest`),
			brandedEnv
		);
		expect(manifestResponse.headers.get('content-type')).toContain('application/manifest+json');
		await expect(manifestResponse.json()).resolves.toMatchObject({
			name: 'Tao Notes',
			short_name: '我的私人空间',
			description: '只属于我的加密备忘录。',
		});
	});

	it('normalizes branding values and escapes them when rewriting HTML', async () => {
		const brandedEnv = {
			...env,
			APP_NAME: '  <script>alert(1)</script>  ',
			APP_SHORT_NAME: '  \n  ',
			APP_DESCRIPTION: 'first\nsecond',
		} as Parameters<typeof worker.fetch>[1];
		const response = await worker.fetch(new Request(`${ORIGIN}/`), brandedEnv);
		const html = await response.text();
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain('data-app-short-name="我的笔记"');
		expect(html).toContain('content="first second"');
	});

	it('round trips the real share crypto protocol and rejects tampering', async () => {
		const payload = {
			v: 1,
			title: 'crypto title',
			content: 'crypto content',
			createdAt: Date.now() - 1000,
			sharedAt: Date.now(),
		};
		const [first, second] = await Promise.all([
			encryptSharedPayload(payload),
			encryptSharedPayload(payload),
		]);
		expect(first.keyFragment).not.toBe(second.keyFragment);
		expect(first.ciphertext).not.toBe(second.ciphertext);
		expect(first.ciphertext).not.toContain(first.keyFragment.slice(3));
		expect(first.proof).not.toContain(first.keyFragment.slice(3));

		const keyBytes = parseShareKeyFragment(first.keyFragment);
		await expect(decryptSharedPayload(first.ciphertext, keyBytes)).resolves.toEqual(payload);
		await expect(
			decryptSharedPayload(first.ciphertext, crypto.getRandomValues(new Uint8Array(32)))
		).rejects.toThrow();

		const prefix = 'share:v1:';
		const envelope = JSON.parse(atob(first.ciphertext.slice(prefix.length))) as { data: string; iv: string };
		envelope.data = `${envelope.data.startsWith('A') ? 'B' : 'A'}${envelope.data.slice(1)}`;
		const tampered = `${prefix}${btoa(JSON.stringify(envelope))}`;
		await expect(decryptSharedPayload(tampered, keyBytes)).rejects.toThrow();
		keyBytes.fill(0);
	});

	it('fails closed when the required vault password is missing or unsafe', async () => {
		const missingSecrets = { DB: env.DB } as unknown as Parameters<typeof worker.fetch>[1];
		const response = await worker.fetch(new Request(`${ORIGIN}/api/session`), missingSecrets);
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			code: 'auth_not_configured',
		});

		const placeholderPasswordEnv = {
			...env,
			APP_PASSWORD: 'replace-with-a-long-unique-passphrase',
		} as Parameters<typeof worker.fetch>[1];
		const placeholderResponse = await worker.fetch(
			new Request(`${ORIGIN}/api/session`),
			placeholderPasswordEnv
		);
		expect(placeholderResponse.status).toBe(503);
		await expect(placeholderResponse.json()).resolves.toMatchObject({ code: 'auth_not_configured' });

		const oversizedPasswordEnv = {
			...env,
			APP_PASSWORD: 'x'.repeat(1025),
		} as Parameters<typeof worker.fetch>[1];
		const oversizedPasswordResponse = await worker.fetch(
			new Request(`${ORIGIN}/api/session`),
			oversizedPasswordEnv
		);
		expect(oversizedPasswordResponse.status).toBe(503);
	});

	it('atomically initializes one stable signing secret when COOKIE_SECRET is omitted', async () => {
		const autoSecretEnv = {
			...env,
			COOKIE_SECRET: undefined,
		} as Parameters<typeof worker.fetch>[1];
		const resolvedSecrets = await Promise.all(
			Array.from({ length: 20 }, () => resolveCookieSecret(autoSecretEnv))
		);
		expect(new Set(resolvedSecrets).size).toBe(1);
		const sessions = await Promise.all([
			worker.fetch(new Request(`${ORIGIN}/api/session`), autoSecretEnv),
			worker.fetch(new Request(`${ORIGIN}/api/session`), autoSecretEnv),
		]);
		expect(sessions.every((response) => response.status === 200)).toBe(true);

		const stored = await env.DB.prepare(
			"SELECT value FROM app_meta WHERE key = 'managed_signing_secret:v1' LIMIT 1"
		).first<{ value: string }>();
		expect(stored?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(stored?.value).toBe(resolvedSecrets[0]);
		expect(stored?.value).not.toBe('replace-with-at-least-32-random-characters');

		const placeholderEnv = {
			...env,
			COOKIE_SECRET: 'replace-with-at-least-32-random-characters',
		} as Parameters<typeof worker.fetch>[1];
		const loginResponse = await worker.fetch(
			new Request(`${ORIGIN}/api/login`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'cf-connecting-ip': '203.0.113.199',
				},
				body: JSON.stringify({ password: DEFAULT_PASSWORD }),
			}),
			placeholderEnv
		);
		expect(loginResponse.status).toBe(200);
		const cookie = cookieFrom(loginResponse);
		const authenticated = await worker.fetch(
			new Request(`${ORIGIN}/api/session`, { headers: { cookie } }),
			autoSecretEnv
		);
		await expect(authenticated.json()).resolves.toMatchObject({ authenticated: true, vaultId: 'default' });

		const persisted = await env.DB.prepare(
			"SELECT value FROM app_meta WHERE key = 'managed_signing_secret:v1' LIMIT 1"
		).first<{ value: string }>();
		expect(persisted?.value).toBe(stored?.value);

		const sharedPayload = {
			v: 1,
			title: 'managed secret share',
			content: 'managed secret content',
			createdAt: Date.now() - 1000,
			sharedAt: Date.now(),
		};
		const encrypted = await encryptSharedPayload(sharedPayload);
		const createdResponse = await worker.fetch(
			new Request(`${ORIGIN}/api/shares`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie },
				body: JSON.stringify({
					ciphertext: encrypted.ciphertext,
					proof: encrypted.proof,
					expiresInSeconds: 3600,
				}),
			}),
			placeholderEnv
		);
		expect(createdResponse.status).toBe(201);
		const created = await jsonBody(createdResponse);
		const changedPasswordEnv = {
			...autoSecretEnv,
			APP_PASSWORD: 'changed-access-password-with-strong-entropy',
		} as Parameters<typeof worker.fetch>[1];
		const consumedResponse = await worker.fetch(
			new Request(`${ORIGIN}/api/shares/${String(created.token)}/consume`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ proof: encrypted.proof }),
			}),
			changedPasswordEnv
		);
		expect(consumedResponse.status).toBe(200);
		const consumed = await jsonBody(consumedResponse);
		const keyBytes = parseShareKeyFragment(encrypted.keyFragment);
		await expect(decryptSharedPayload(String(consumed.ciphertext), keyBytes)).resolves.toEqual(sharedPayload);
		keyBytes.fill(0);
	});

	it('bootstraps only a completely empty D1 database for one-click deployment', async () => {
		await env.DB.batch([
			env.DB.prepare('DROP TABLE IF EXISTS note_shares'),
			env.DB.prepare('DROP TABLE IF EXISTS notes'),
			env.DB.prepare('DROP TABLE IF EXISTS app_meta'),
			env.DB.prepare('DROP TABLE IF EXISTS auth_rate_limits'),
			env.DB.prepare('DROP TABLE IF EXISTS d1_migrations'),
		]);
		const freshEnvs = Array.from({ length: 2 }, () => ({
			...env,
			DB: isolatedD1Binding(),
			COOKIE_SECRET: undefined,
		}) as Parameters<typeof worker.fetch>[1]);
		const responses = await Promise.all(
			freshEnvs.map((freshEnv) => worker.fetch(new Request(`${ORIGIN}/api/session`), freshEnv))
		);
		expect(responses.every((response) => response.status === 200)).toBe(true);

		const tables = await env.DB.prepare(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table'
			   AND name IN ('app_meta', 'auth_rate_limits', 'd1_migrations', 'note_shares', 'notes')`
		).all<{ name: string }>();
		expect(new Set((tables.results ?? []).map((row) => row.name))).toEqual(
			new Set(['app_meta', 'auth_rate_limits', 'd1_migrations', 'note_shares', 'notes'])
		);
		const journal = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
		expect((journal.results ?? []).map((row) => row.name)).toEqual([
			'0001_init.sql',
			'0002_notes_fts.sql',
			'0003_app_meta.sql',
			'0004_auth_rate_limits.sql',
			'0005_note_vaults.sql',
			'0006_hardening.sql',
			'0007_one_time_shares.sql',
		]);
		const noteColumns = await env.DB.prepare('PRAGMA table_info(notes)').all<{ name: string }>();
		expect((noteColumns.results ?? []).map((column) => column.name)).toEqual([
			'id',
			'title',
			'content',
			'created_at',
			'updated_at',
			'vault_id',
		]);
		const noteIndex = await env.DB.prepare('PRAGMA index_info(idx_notes_vault_updated_id)').all<{ name: string }>();
		expect((noteIndex.results ?? []).map((column) => column.name)).toEqual(['vault_id', 'updated_at', 'id']);
		const managedSecret = await env.DB.prepare(
			"SELECT value FROM app_meta WHERE key = 'managed_signing_secret:v1' LIMIT 1"
		).first<{ value: string }>();
		expect(managedSecret?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('never bootstraps an unrelated or partially initialized database', async () => {
		await env.DB.batch([
			env.DB.prepare('DROP TABLE IF EXISTS note_shares'),
			env.DB.prepare('DROP TABLE IF EXISTS notes'),
			env.DB.prepare('DROP TABLE IF EXISTS app_meta'),
			env.DB.prepare('DROP TABLE IF EXISTS auth_rate_limits'),
			env.DB.prepare('DROP TABLE IF EXISTS d1_migrations'),
		]);
		await env.DB.prepare('CREATE TABLE acf_data (id TEXT PRIMARY KEY)').run();
		const unrelatedEnv = {
			...env,
			DB: isolatedD1Binding(),
			COOKIE_SECRET: undefined,
		} as Parameters<typeof worker.fetch>[1];
		const unrelated = await worker.fetch(new Request(`${ORIGIN}/api/session`), unrelatedEnv);
		expect(unrelated.status).toBe(503);
		const unrelatedTables = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name"
		).all<{ name: string }>();
		expect((unrelatedTables.results ?? []).map((row) => row.name)).toEqual(['acf_data']);

		await env.DB.prepare('DROP TABLE acf_data').run();
		await env.DB.prepare('CREATE TABLE notes (id TEXT PRIMARY KEY)').run();
		const partialDb = isolatedD1Binding();
		const partialEnv = {
			...env,
			DB: partialDb,
			COOKIE_SECRET: undefined,
		} as Parameters<typeof worker.fetch>[1];
		const partial = await worker.fetch(new Request(`${ORIGIN}/api/session`), partialEnv);
		expect(partial.status).toBe(503);
		const partialTables = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name"
		).all<{ name: string }>();
		expect((partialTables.results ?? []).map((row) => row.name)).toEqual(['notes']);

		await env.DB.prepare('DROP TABLE notes').run();
		const restored = await worker.fetch(new Request(`${ORIGIN}/api/session`), partialEnv);
		expect(restored.status).toBe(200);
	});

	it('keeps an explicit COOKIE_SECRET as the preferred signing key', async () => {
		const response = await api('/api/session');
		expect(response.status).toBe(200);
		const stored = await env.DB.prepare(
			"SELECT value FROM app_meta WHERE key = 'managed_signing_secret:v1' LIMIT 1"
		).first<{ value: string }>();
		expect(stored).toBeNull();
	});

	it('fails closed for a short custom COOKIE_SECRET override', async () => {
		const shortSecretEnv = {
			...env,
			COOKIE_SECRET: 'custom-but-short',
		} as Parameters<typeof worker.fetch>[1];
		const response = await worker.fetch(new Request(`${ORIGIN}/api/session`), shortSecretEnv);
		expect(response.status).toBe(503);
		const stored = await env.DB.prepare(
			"SELECT value FROM app_meta WHERE key = 'managed_signing_secret:v1' LIMIT 1"
		).first<{ value: string }>();
		expect(stored).toBeNull();
	});

	it('fails closed without overwriting a damaged managed signing secret', async () => {
		const damagedSecret = 'x'.repeat(32);
		await env.DB.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)')
			.bind('managed_signing_secret:v1', damagedSecret)
			.run();
		const autoSecretEnv = {
			...env,
			COOKIE_SECRET: undefined,
		} as Parameters<typeof worker.fetch>[1];
		const response = await worker.fetch(new Request(`${ORIGIN}/api/session`), autoSecretEnv);
		expect(response.status).toBe(503);
		const stored = await env.DB.prepare(
			"SELECT value FROM app_meta WHERE key = 'managed_signing_secret:v1' LIMIT 1"
		).first<{ value: string }>();
		expect(stored?.value).toBe(damagedSecret);
	});

	it('starts unauthenticated and issues a hardened signed session cookie', async () => {
		const anonymous = await api('/api/session');
		await expect(anonymous.json()).resolves.toMatchObject({ ok: true, authenticated: false });

		const { response, cookie } = await login();
		const setCookie = response.headers.get('set-cookie') || '';
		expect(setCookie).toContain('__Host-session=');
		expect(setCookie).toContain('HttpOnly');
		expect(setCookie).toContain('Secure');
		expect(setCookie).toContain('SameSite=Strict');
		expect(setCookie).toContain('Path=/');

		const session = await api('/api/session', { headers: { cookie } });
		await expect(session.json()).resolves.toMatchObject({
			ok: true,
			authenticated: true,
			vaultId: 'default',
		});
		expect(session.headers.get('x-request-id')).toBeTruthy();
		expect(session.headers.get('x-frame-options')).toBe('DENY');
	});

	it('rejects malformed login requests and incorrect passwords', async () => {
		const unsupported = await api('/api/login', { method: 'POST', body: '{}' });
		expect(unsupported.status).toBe(415);

		const malformed = await api('/api/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{',
		});
		expect(malformed.status).toBe(400);

		const wrong = await api('/api/login', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'cf-connecting-ip': '203.0.113.8',
			},
			body: JSON.stringify({ password: 'wrong-password' }),
		});
		expect(wrong.status).toBe(401);
	});

	it('rate limits repeated failed logins by stable client IP', async () => {
		const ip = '203.0.113.10';
		let response: Response | undefined;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			response = await api('/api/login', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'cf-connecting-ip': ip,
					'user-agent': `rotating-user-agent-${attempt}`,
				},
				body: JSON.stringify({ password: 'wrong-password' }),
			});
		}

		expect(response?.status).toBe(429);
		expect(response?.headers.get('retry-after')).toBeTruthy();

		const locked = await api('/api/login', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'cf-connecting-ip': ip,
			},
			body: JSON.stringify({ password: DEFAULT_PASSWORD }),
		});
		expect(locked.status).toBe(429);
	});

	it('rejects tampered and password-revoked sessions', async () => {
		const { cookie } = await login();
		const tampered = `${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`;
		const tamperedSession = await api('/api/session', { headers: { cookie: tampered } });
		await expect(tamperedSession.json()).resolves.toMatchObject({ authenticated: false });

		const changedPasswordEnv = {
			...env,
			APP_PASSWORD: 'a-different-password-with-strong-entropy',
		} as Parameters<typeof worker.fetch>[1];
		const revoked = await worker.fetch(
			new Request(`${ORIGIN}/api/session`, { headers: { cookie } }),
			changedPasswordEnv
		);
		await expect(revoked.json()).resolves.toMatchObject({ authenticated: false });
	});

	it('initializes one stable vault salt and key check', async () => {
		const { cookie } = await login();
		const [first, second] = await Promise.all([
			api('/api/crypto-config', { headers: { cookie } }),
			api('/api/crypto-config', { headers: { cookie } }),
		]);
		const firstConfig = await jsonBody(first);
		const secondConfig = await jsonBody(second);
		expect(firstConfig.vaultSalt).toBe(secondConfig.vaultSalt);
		expect(firstConfig.keyCheck).toBeNull();
		expect(firstConfig.iterations).toBe(250000);

		const candidate = encryptedValue('key-check:first');
		const competing = encryptedValue('key-check:second');
		const initialized = await api('/api/crypto-config/key-check', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ keyCheck: candidate }),
		});
		await expect(initialized.json()).resolves.toMatchObject({ keyCheck: candidate });

		const repeated = await api('/api/crypto-config/key-check', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ keyCheck: competing }),
		});
		await expect(repeated.json()).resolves.toMatchObject({ keyCheck: candidate });
	});

	it('requires ciphertext and protects note updates with revisions', async () => {
		const { cookie } = await login();
		const plaintext = await api('/api/notes', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ title: 'plaintext', content: 'plaintext' }),
		});
		expect(plaintext.status).toBe(400);
		await expect(plaintext.json()).resolves.toMatchObject({ code: 'invalid_ciphertext' });

		const unsupportedVersion = await api('/api/notes', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({
				title: encryptedValue('version').replace('enc:v1:', 'enc:v2:'),
				content: encryptedValue('version'),
			}),
		});
		expect(unsupportedVersion.status).toBe(400);

		const created = await createNote(cookie, 'revision');
		const id = String(created.id);
		const originalRevision = Number(created.revision);
		expect(originalRevision).toBe(Number(created.updated_at));
		expect(originalRevision).toBeGreaterThan(0);

		const missingRevision = await api(`/api/notes/${id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ title: encryptedValue('new-title'), content: encryptedValue('new-content') }),
		});
		expect(missingRevision.status).toBe(428);

		const concurrentUpdates = await Promise.all(
			['first', 'second'].map((label) =>
				api(`/api/notes/${id}`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json', cookie },
					body: JSON.stringify({
						title: encryptedValue(`${label}-title`),
						content: encryptedValue(`${label}-content`),
						revision: originalRevision,
					}),
				})
			)
		);
		expect(concurrentUpdates.map((response) => response.status).sort()).toEqual([200, 409]);
		const updated = concurrentUpdates.find((response) => response.status === 200);
		const stale = concurrentUpdates.find((response) => response.status === 409);
		expect(updated).toBeDefined();
		expect(stale).toBeDefined();
		const updatedBody = await jsonBody(updated!);
		const updatedNote = updatedBody.note as JsonRecord;
		const updatedRevision = Number(updatedNote.revision);
		expect(updatedRevision).toBe(Number(updatedNote.updated_at));
		expect(updatedRevision).toBeGreaterThan(originalRevision);
		await expect(stale!.json()).resolves.toMatchObject({
			error: 'revision_conflict',
			currentRevision: updatedRevision,
		});

		const missingDeleteRevision = await api(`/api/notes/${id}`, {
			method: 'DELETE',
			headers: { cookie },
		});
		expect(missingDeleteRevision.status).toBe(428);

		const staleDelete = await api(`/api/notes/${id}`, {
			method: 'DELETE',
			headers: { cookie, 'if-match': String(originalRevision) },
		});
		expect(staleDelete.status).toBe(409);

		const deleted = await api(`/api/notes/${id}`, {
			method: 'DELETE',
			headers: { cookie, 'if-match': String(updatedRevision) },
		});
		expect(deleted.status).toBe(200);
	});

	it('enforces ciphertext field and request body size limits', async () => {
		const { cookie } = await login();
		const oversizedTitle = await api('/api/notes', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({
				title: encryptedValueWithDataBytes(18_500),
				content: encryptedValue('content'),
			}),
		});
		expect(oversizedTitle.status).toBe(400);
		await expect(oversizedTitle.json()).resolves.toMatchObject({ code: 'invalid_ciphertext' });

		const oversizedContent = await api('/api/notes', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({
				title: encryptedValue('title'),
				content: encryptedValueWithDataBytes(788_000),
			}),
		});
		expect(oversizedContent.status).toBe(400);
		await expect(oversizedContent.json()).resolves.toMatchObject({ code: 'invalid_ciphertext' });

		const oversizedBody = await api('/api/notes', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ title: encryptedValue('title'), content: 'x'.repeat(1_500_001) }),
		});
		expect(oversizedBody.status).toBe(413);
		await expect(oversizedBody.json()).resolves.toMatchObject({ code: 'payload_too_large' });
	});

	it('creates client-encrypted shares and atomically consumes them once', async () => {
		const sharedPayload = {
			v: 1,
			title: '一次性标题',
			content: '一次性正文',
			createdAt: Date.now() - 1000,
			sharedAt: Date.now(),
		};
		const encrypted = await encryptSharedPayload(sharedPayload);
		const proof = encrypted.proof;
		const ciphertext = encrypted.ciphertext;
		const createBody = JSON.stringify({ ciphertext, proof, expiresInSeconds: 86_400 });
		const anonymousCreate = await api('/api/shares', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: createBody,
		});
		expect(anonymousCreate.status).toBe(401);

		const { cookie } = await login();
		const invalidCiphertext = await api('/api/shares', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ ciphertext: encryptedValue('wrong-context'), proof, expiresInSeconds: 86_400 }),
		});
		expect(invalidCiphertext.status).toBe(400);

		const invalidExpiry = await api('/api/shares', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ ciphertext, proof, expiresInSeconds: 60 }),
		});
		expect(invalidExpiry.status).toBe(400);

		const createdResponse = await api('/api/shares', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: createBody,
		});
		expect(createdResponse.status).toBe(201);
		const created = await jsonBody(createdResponse);
		const token = String(created.token);
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
		expect(Number(created.expiresAt)).toBeGreaterThan(Date.now());

		const stored = await env.DB.prepare(
			'SELECT token_hash, proof_hash, ciphertext FROM note_shares LIMIT 1'
		).first<{ token_hash: string; proof_hash: string; ciphertext: string }>();
		expect(stored?.token_hash).not.toBe(token);
		expect(stored?.proof_hash).not.toBe(proof);
		expect(stored?.ciphertext).toBe(ciphertext);

		for (const method of ['GET', 'HEAD', 'OPTIONS']) {
			const scannerRequest = await api(`/api/shares/${token}/consume`, { method });
			expect(scannerRequest.status).toBe(401);
		}
		const unsupportedMedia = await api(`/api/shares/${token}/consume`, { method: 'POST', body: '{}' });
		expect(unsupportedMedia.status).toBe(415);

		const wrongProof = await api(`/api/shares/${token}/consume`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ proof: 'w'.repeat(43) }),
		});
		expect(wrongProof.status).toBe(410);
		for (let componentIndex = 0; componentIndex < 3; componentIndex += 1) {
			const components = token.split('.');
			const component = components[componentIndex];
			components[componentIndex] = `${component.slice(0, -1)}${component.endsWith('a') ? 'b' : 'a'}`;
			const tampered = await api(`/api/shares/${components.join('.')}/consume`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ proof }),
			});
			expect(tampered.status).toBe(410);
			expect(tampered.headers.get('cache-control')).toBe('no-store');
		}
		await expect(env.DB.prepare('SELECT COUNT(*) AS count FROM note_shares').first<{ count: number }>())
			.resolves.toMatchObject({ count: 1 });

		const consumeRequest = () =>
			api(`/api/shares/${token}/consume`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ proof }),
			});
		const consumed = await Promise.all([consumeRequest(), consumeRequest()]);
		expect(consumed.map((response) => response.status).sort()).toEqual([200, 410]);
		const winner = consumed.find((response) => response.status === 200);
		expect(winner).toBeDefined();
		expect(winner!.headers.get('cache-control')).toBe('no-store');
		const winnerBody = await jsonBody(winner!);
		expect(winnerBody).toMatchObject({ ok: true, ciphertext });
		const keyBytes = parseShareKeyFragment(encrypted.keyFragment);
		await expect(decryptSharedPayload(String(winnerBody.ciphertext), keyBytes)).resolves.toEqual(sharedPayload);
		keyBytes.fill(0);
		await expect(env.DB.prepare('SELECT COUNT(*) AS count FROM note_shares').first<{ count: number }>())
			.resolves.toMatchObject({ count: 0 });
	});

	it('deletes expired shares without returning their ciphertext', async () => {
		const { cookie } = await login();
		const encrypted = await encryptSharedPayload({
			v: 1,
			title: 'expired',
			content: 'expired',
			createdAt: Date.now(),
			sharedAt: Date.now(),
		});
		const proof = encrypted.proof;
		const created = await jsonBody(
			await api('/api/shares', {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie },
				body: JSON.stringify({
					ciphertext: encrypted.ciphertext,
					proof,
					expiresInSeconds: 3600,
				}),
			})
		);
		await env.DB.prepare('UPDATE note_shares SET expires_at = 0').run();

		const response = await api(`/api/shares/${String(created.token)}/consume`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ proof }),
		});
		expect(response.status).toBe(410);
		await expect(response.json()).resolves.toMatchObject({ code: 'share_unavailable' });
		await expect(env.DB.prepare('SELECT COUNT(*) AS count FROM note_shares').first<{ count: number }>())
			.resolves.toMatchObject({ count: 0 });
	});

	it('isolates encrypted notes between password vaults', async () => {
		const defaultLogin = await login(DEFAULT_PASSWORD, '203.0.113.21');
		const guestLogin = await login(GUEST_PASSWORD, '203.0.113.22');
		await createNote(defaultLogin.cookie, 'default-vault');
		await createNote(guestLogin.cookie, 'guest-vault');

		const defaultList = await jsonBody(await api('/api/notes', { headers: { cookie: defaultLogin.cookie } }));
		const guestList = await jsonBody(await api('/api/notes', { headers: { cookie: guestLogin.cookie } }));
		const defaultNotes = defaultList.notes as JsonRecord[];
		const guestNotes = guestList.notes as JsonRecord[];
		expect(defaultNotes).toHaveLength(1);
		expect(guestNotes).toHaveLength(1);
		expect(defaultNotes[0].id).not.toBe(guestNotes[0].id);
	});

	it('paginates notes with stable non-overlapping cursors', async () => {
		const { cookie } = await login();
		for (const label of ['one', 'two', 'three']) await createNote(cookie, label);

		const firstPage = await jsonBody(await api('/api/notes?limit=2', { headers: { cookie } }));
		const firstNotes = firstPage.notes as JsonRecord[];
		expect(firstNotes).toHaveLength(2);
		expect(typeof firstPage.nextCursor).toBe('string');

		const secondPage = await jsonBody(
			await api(`/api/notes?limit=2&cursor=${encodeURIComponent(String(firstPage.nextCursor))}`, {
				headers: { cookie },
			})
		);
		const secondNotes = secondPage.notes as JsonRecord[];
		expect(secondNotes).toHaveLength(1);
		expect(secondPage.nextCursor).toBeNull();
		expect(new Set([...firstNotes, ...secondNotes].map((note) => note.id)).size).toBe(3);
	});

	it(
		'caps pages at ten rows and paginates near-limit ciphertext safely',
		async () => {
			const { cookie } = await login();
			const invalidLimit = await api('/api/notes?limit=11', { headers: { cookie } });
			expect(invalidLimit.status).toBe(400);
			await expect(invalidLimit.json()).resolves.toMatchObject({ code: 'invalid_limit' });

			const nearLimitCiphertext = encryptedValueWithDataBytes(787_000);
			expect(nearLimitCiphertext.length).toBeGreaterThan(1_390_000);
			expect(nearLimitCiphertext.length).toBeLessThanOrEqual(1_400_000);
			for (let index = 0; index < 11; index += 1) {
				await createNote(cookie, `large-${index}`, crypto.randomUUID(), nearLimitCiphertext);
			}

			const firstPage = await jsonBody(await api('/api/notes', { headers: { cookie } }));
			const firstNotes = firstPage.notes as JsonRecord[];
			expect(firstNotes).toHaveLength(10);
			expect(typeof firstPage.nextCursor).toBe('string');

			const secondPage = await jsonBody(
				await api(`/api/notes?cursor=${encodeURIComponent(String(firstPage.nextCursor))}`, {
					headers: { cookie },
				})
			);
			const secondNotes = secondPage.notes as JsonRecord[];
			expect(secondNotes).toHaveLength(1);
			expect(secondPage.nextCursor).toBeNull();
			expect(new Set([...firstNotes, ...secondNotes].map((note) => note.id)).size).toBe(11);
		},
		20_000
	);
});
