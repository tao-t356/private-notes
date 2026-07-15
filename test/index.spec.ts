import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { decryptSharedPayload, encryptSharedPayload, parseShareKeyFragment } from '../public/share-crypto.js';
import worker from '../src';

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

	it('fails closed when required authentication secrets are missing', async () => {
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
