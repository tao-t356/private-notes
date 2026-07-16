import {
	SESSION_MAX_AGE_SECONDS,
	SESSION_COOKIE_NAME,
	MAX_PASSWORD_LENGTH,
	cleanupOldLoginRateLimits,
	clearFailedLogins,
	createSessionToken,
	getAuthConfigurationError,
	getConfiguredVaultCount,
	getLoginRateLimit,
	getSession,
	getVaultIdForPassword,
	recordFailedLogin,
	resolveCookieSecret,
	tooManyLoginAttempts,
} from './auth';
import { ensureApplicationSchema } from './schema';
import { createBrandedManifest, getAppBranding, rewriteBrandedHtml } from './branding';

type AppEnv = Omit<Env, 'APP_NAME' | 'APP_SHORT_NAME' | 'APP_DESCRIPTION'> & {
	APP_PASSWORD?: string;
	APP_PASSWORDS?: string;
	COOKIE_SECRET?: string;
	APP_NAME?: string;
	APP_SHORT_NAME?: string;
	APP_DESCRIPTION?: string;
};

type Note = {
	id: string;
	title: string;
	content: string;
	created_at: number;
	updated_at: number;
	revision: number;
};

type NoteCursor = {
	id: string;
	updatedAt: number;
};

type NoteShare = {
	ciphertext: string;
	expires_at: number;
};

type ShareToken = {
	id: string;
	proofHash: string;
	signature: string;
};

const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 10;
const MAX_LOGIN_BODY_BYTES = 4096;
const MAX_NOTE_BODY_BYTES = 1_500_000;
const MAX_ENCRYPTED_TITLE_LENGTH = 32_768;
const MAX_ENCRYPTED_CONTENT_LENGTH = 1_400_000;
const MAX_KEY_CHECK_LENGTH = 16_384;
const MAX_SHARE_BODY_BYTES = 1_100_000;
const MAX_SHARE_CIPHERTEXT_LENGTH = 1_000_000;
const MAX_SHARE_CONSUME_BODY_BYTES = 1024;
const SHARE_TTL_SECONDS = new Set([60 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60]);
const NOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENCRYPTED_VALUE_PATTERN = /^enc:v1:([A-Za-z0-9+/]+={0,2})$/;
const SHARE_ENCRYPTED_VALUE_PATTERN = /^share:v1:([A-Za-z0-9+/]+={0,2})$/;
const SHARE_PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHARE_TOKEN_PATTERN = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
const PADDED_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BRANDED_HTML_PATHS = new Map<string, 'app' | 'share'>([
	['/', 'app'],
	['/index.html', 'app'],
	['/share', 'share'],
	['/share.html', 'share'],
]);

class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'ApiError';
	}
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
			...extraHeaders,
		},
	});
}

function unauthorized() {
	return json({ ok: false, error: 'unauthorized' }, 401);
}

function serviceUnavailable() {
	return json({ ok: false, error: 'service_unavailable', code: 'auth_not_configured' }, 503);
}

function shareUnavailable() {
	return json({ ok: false, error: 'share_unavailable', code: 'share_unavailable' }, 410);
}

function withCommonHeaders(response: Response, requestId: string) {
	const headers = new Headers(response.headers);
	headers.set('x-request-id', requestId);
	headers.set('x-content-type-options', 'nosniff');
	headers.set('referrer-policy', 'no-referrer');
	headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
	headers.set('x-frame-options', 'DENY');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function getRequestId(request: Request) {
	const ray = request.headers.get('cf-ray');
	return ray && ray.length <= 128 ? ray : crypto.randomUUID();
}

function contentTypeIsJson(request: Request) {
	return request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

async function readJsonObject(request: Request, maxBytes: number) {
	if (!contentTypeIsJson(request)) {
		throw new ApiError(415, 'unsupported_media_type', 'content-type must be application/json');
	}

	const declaredLength = request.headers.get('content-length');
	if (declaredLength && (/^\d+$/.test(declaredLength) === false || Number(declaredLength) > maxBytes)) {
		throw new ApiError(413, 'payload_too_large', 'request body is too large');
	}

	if (!request.body) throw new ApiError(400, 'invalid_json', 'JSON object required');
	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let totalBytes = 0;
	let text = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel();
			throw new ApiError(413, 'payload_too_large', 'request body is too large');
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ApiError(400, 'invalid_json', 'valid JSON object required');
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ApiError(400, 'invalid_json', 'JSON object required');
	}
	return parsed as Record<string, unknown>;
}

function requireCiphertextEnvelope(
	value: unknown,
	field: string,
	maxLength: number,
	pattern: RegExp,
	versionLabel: string
) {
	if (typeof value !== 'string' || value.length > maxLength || value.length < 24) {
		throw new ApiError(400, 'invalid_ciphertext', `${field} must be valid ${versionLabel} ciphertext`);
	}

	const match = pattern.exec(value);
	try {
		if (!match) throw new Error('invalid envelope');
		const envelope = JSON.parse(atob(match[1])) as { data?: unknown; iv?: unknown };
		if (!envelope || typeof envelope !== 'object' || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string') {
			throw new Error('invalid envelope fields');
		}
		if (getBase64DecodedLength(envelope.iv) !== 12 || getBase64DecodedLength(envelope.data) < 16) {
			throw new Error('invalid AES-GCM payload');
		}
	} catch {
		throw new ApiError(400, 'invalid_ciphertext', `${field} must be valid ${versionLabel} ciphertext`);
	}
	return value;
}

function getBase64DecodedLength(value: string) {
	if (!value || value.length % 4 !== 0 || !PADDED_BASE64_PATTERN.test(value)) return -1;
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
	return (value.length / 4) * 3 - padding;
}

function requireEncryptedValue(value: unknown, field: string, maxLength: number) {
	return requireCiphertextEnvelope(value, field, maxLength, ENCRYPTED_VALUE_PATTERN, 'enc:v1');
}

function requireShareCiphertext(value: unknown) {
	return requireCiphertextEnvelope(
		value,
		'ciphertext',
		MAX_SHARE_CIPHERTEXT_LENGTH,
		SHARE_ENCRYPTED_VALUE_PATTERN,
		'share:v1'
	);
}

function requireNoteId(value: unknown, field = 'id') {
	if (typeof value !== 'string' || !NOTE_ID_PATTERN.test(value)) {
		throw new ApiError(400, 'invalid_id', `${field} must be a UUID`);
	}
	return value.toLowerCase();
}

function bytesToBase64(bytes: Uint8Array) {
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array) {
	return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function requireShareProof(value: unknown) {
	if (typeof value !== 'string' || !SHARE_PROOF_PATTERN.test(value)) {
		throw new ApiError(400, 'invalid_share_proof', 'proof must be a 256-bit base64url value');
	}
	return value;
}

function requireShareToken(value: unknown): ShareToken {
	const match = typeof value === 'string' ? SHARE_TOKEN_PATTERN.exec(value) : null;
	if (!match) throw new ApiError(400, 'invalid_share_token', 'invalid signed share token');
	return { id: match[1], proofHash: match[2], signature: match[3] };
}

function requireShareTtl(value: unknown) {
	if (!Number.isSafeInteger(value) || !SHARE_TTL_SECONDS.has(value as number)) {
		throw new ApiError(400, 'invalid_share_expiry', 'expiresInSeconds must be 3600, 86400, or 604800');
	}
	return value as number;
}

async function hashShareSecret(namespace: 'proof' | 'token', value: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`private-notes-share:${namespace}:v1\u0000${value}`)
	);
	return bytesToBase64Url(new Uint8Array(digest));
}

function createShareTokenId() {
	return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function safeEqual(a: string, b: string) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index += 1) {
		diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}
	return diff === 0;
}

async function signShareToken(env: AppEnv, id: string, proofHash: string) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(env.COOKIE_SECRET!),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`private-notes-share-token:v1\u0000${id}\u0000${proofHash}`)
	);
	return bytesToBase64Url(new Uint8Array(signature));
}

function base64UrlEncode(value: string) {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string) {
	if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new ApiError(400, 'invalid_cursor', 'invalid notes cursor');
	}
	try {
		const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		throw new ApiError(400, 'invalid_cursor', 'invalid notes cursor');
	}
}

function encodeNoteCursor(note: Note) {
	return base64UrlEncode(JSON.stringify({ updatedAt: note.updated_at, id: note.id } satisfies NoteCursor));
}

function decodeNoteCursor(value: string | null): NoteCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(base64UrlDecode(value)) as Partial<NoteCursor>;
		if (
			!Number.isSafeInteger(parsed.updatedAt) ||
			(parsed.updatedAt as number) < 0 ||
			typeof parsed.id !== 'string' ||
			!NOTE_ID_PATTERN.test(parsed.id)
		) {
			throw new Error('invalid cursor fields');
		}
		return { updatedAt: parsed.updatedAt as number, id: parsed.id.toLowerCase() };
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ApiError(400, 'invalid_cursor', 'invalid notes cursor');
	}
}

function getListLimit(value: string | null) {
	if (value === null) return DEFAULT_LIST_LIMIT;
	if (!/^\d{1,4}$/.test(value)) throw new ApiError(400, 'invalid_limit', 'limit must be an integer');
	const limit = Number(value);
	if (limit < 1 || limit > MAX_LIST_LIMIT) {
		throw new ApiError(400, 'invalid_limit', `limit must be between 1 and ${MAX_LIST_LIMIT}`);
	}
	return limit;
}

async function listNotes(env: AppEnv, vaultId: string, cursor: NoteCursor | null, limit: number) {
	const statement = cursor
		? env.DB.prepare(
				`SELECT id, title, content, created_at, updated_at, updated_at AS revision
				 FROM notes
				 WHERE vault_id = ?
				   AND (updated_at < ? OR (updated_at = ? AND id < ?))
				 ORDER BY updated_at DESC, id DESC
				 LIMIT ?`
			).bind(vaultId, cursor.updatedAt, cursor.updatedAt, cursor.id, limit + 1)
		: env.DB.prepare(
				`SELECT id, title, content, created_at, updated_at, updated_at AS revision
				 FROM notes
				 WHERE vault_id = ?
				 ORDER BY updated_at DESC, id DESC
				 LIMIT ?`
			).bind(vaultId, limit + 1);
	const result = await statement.all<Note>();
	const rows = result.results ?? [];
	const hasMore = rows.length > limit;
	const notes = hasMore ? rows.slice(0, limit) : rows;
	return { notes, nextCursor: hasMore && notes.length ? encodeNoteCursor(notes[notes.length - 1]) : null };
}

async function getNote(env: AppEnv, id: string, vaultId: string) {
	return env.DB.prepare(
		`SELECT id, title, content, created_at, updated_at, updated_at AS revision
		 FROM notes
		 WHERE id = ? AND vault_id = ?
		 LIMIT 1`
	)
		.bind(id, vaultId)
		.first<Note>();
}

async function createNoteShare(
	env: AppEnv,
	vaultId: string,
	ciphertext: string,
	proof: string,
	expiresInSeconds: number
) {
	const now = Date.now();
	const expiresAt = now + expiresInSeconds * 1000;
	const proofHash = await hashShareSecret('proof', proof);

	await env.DB.prepare('DELETE FROM note_shares WHERE expires_at <= ?').bind(now).run();
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const tokenId = createShareTokenId();
		const tokenHash = await hashShareSecret('token', tokenId);
		const signature = await signShareToken(env, tokenId, proofHash);
		const token = `${tokenId}.${proofHash}.${signature}`;
		const created = await env.DB.prepare(
			`INSERT INTO note_shares (token_hash, proof_hash, vault_id, ciphertext, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(token_hash) DO NOTHING
			 RETURNING expires_at`
		)
			.bind(tokenHash, proofHash, vaultId, ciphertext, now, expiresAt)
			.first<{ expires_at: number }>();
		if (created) return { token, expiresAt: created.expires_at };
	}

	throw new Error('failed to allocate a unique share token');
}

async function consumeNoteShare(env: AppEnv, parsedToken: ShareToken, proof: string) {
	const [expectedSignature, suppliedProofHash] = await Promise.all([
		signShareToken(env, parsedToken.id, parsedToken.proofHash),
		hashShareSecret('proof', proof),
	]);
	if (
		!safeEqual(parsedToken.signature, expectedSignature) ||
		!safeEqual(parsedToken.proofHash, suppliedProofHash)
	) {
		return null;
	}
	const tokenHash = await hashShareSecret('token', parsedToken.id);
	const share = await env.DB.prepare(
		`DELETE FROM note_shares
		 WHERE token_hash = ? AND proof_hash = ?
		 RETURNING ciphertext, expires_at`
	)
		.bind(tokenHash, parsedToken.proofHash)
		.first<NoteShare>();

	if (!share) return null;
	if (share.expires_at <= Date.now()) return null;
	return share;
}

function getVaultMetaKey(vaultId: string, name: 'salt' | 'key_check') {
	const baseKey = name === 'salt' ? 'vault_salt' : 'vault_key_check';
	return vaultId === 'default' ? baseKey : `${baseKey}:${vaultId}`;
}

async function getOrCreateVaultSalt(env: AppEnv, vaultId: string) {
	const key = getVaultMetaKey(vaultId, 'salt');
	const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
	const row = await env.DB.prepare(
		`INSERT INTO app_meta (key, value)
		 VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = app_meta.value
		 RETURNING value`
	)
		.bind(key, salt)
		.first<{ value: string }>();
	if (!row) throw new Error('failed to initialize vault salt');
	return row.value;
}

async function getVaultKeyCheck(env: AppEnv, vaultId: string) {
	const row = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ? LIMIT 1')
		.bind(getVaultMetaKey(vaultId, 'key_check'))
		.first<{ value: string }>();
	return row?.value ?? null;
}

async function initializeVaultKeyCheck(env: AppEnv, vaultId: string, candidate: string) {
	const row = await env.DB.prepare(
		`INSERT INTO app_meta (key, value)
		 VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = app_meta.value
		 RETURNING value`
	)
		.bind(getVaultMetaKey(vaultId, 'key_check'), candidate)
		.first<{ value: string }>();
	if (!row) throw new Error('failed to initialize vault key check');
	return row.value;
}

async function handleRequest(request: Request, env: AppEnv): Promise<Response> {
	const url = new URL(request.url);
	const branding = getAppBranding(env);
	const brandedPage = BRANDED_HTML_PATHS.get(url.pathname);
	if (brandedPage) {
		const assetResponse = await env.ASSETS.fetch(request);
		if (request.method !== 'GET' || !assetResponse.ok) return assetResponse;
		return rewriteBrandedHtml(assetResponse, branding, brandedPage);
	}

	if (url.pathname === '/manifest.webmanifest' && (request.method === 'GET' || request.method === 'HEAD')) {
		return createBrandedManifest(branding, request.method === 'HEAD');
	}

	if (url.pathname.startsWith('/api/')) {
		try {
			await ensureApplicationSchema(env);
			const cookieSecret = await resolveCookieSecret(env);
			if (cookieSecret !== env.COOKIE_SECRET) {
				env = Object.assign(Object.create(env), { COOKIE_SECRET: cookieSecret }) as AppEnv;
			}
		} catch {
			console.error('Failed to initialize the application schema or managed signing secret');
			return serviceUnavailable();
		}
	}

	const authConfigurationError = getAuthConfigurationError(env);
	if (url.pathname.startsWith('/api/') && authConfigurationError) {
		console.error(`Authentication configuration error: ${authConfigurationError}`);
		return serviceUnavailable();
	}

	if (url.pathname === '/api/session' && request.method === 'GET') {
		const session = await getSession(request, env);
		return json({ ok: true, authenticated: session.authenticated, vaultId: session.vaultId });
	}

	if (url.pathname === '/api/login' && request.method === 'POST') {
		const body = await readJsonObject(request, MAX_LOGIN_BODY_BYTES);
		if (typeof body.password !== 'string' || !body.password || body.password.length > MAX_PASSWORD_LENGTH) {
			throw new ApiError(400, 'invalid_password', 'password is required');
		}

		const rateLimit = await getLoginRateLimit(request, env);
		if (rateLimit.limited) return tooManyLoginAttempts(rateLimit.retryAfterSeconds);

		const vaultId = await getVaultIdForPassword(env, body.password);
		if (!vaultId) {
			const failure = await recordFailedLogin(env, rateLimit.key);
			if (failure.locked) return tooManyLoginAttempts(failure.retryAfterSeconds);
			return unauthorized();
		}

		await clearFailedLogins(env, rateLimit.key);
		await cleanupOldLoginRateLimits(env);
		const token = await createSessionToken(env, vaultId);
		if (!token) throw new Error('failed to create session token');

		return json(
			{ ok: true, vaultId },
			200,
			{
				'set-cookie': `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
			}
		);
	}

	if (url.pathname === '/api/logout' && request.method === 'POST') {
		return json(
			{ ok: true },
			200,
			{
				'set-cookie': `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
			}
		);
	}

	const shareConsumeMatch = /^\/api\/shares\/([^/]+)\/consume$/.exec(url.pathname);
	if (shareConsumeMatch && request.method === 'POST') {
		const token = requireShareToken(shareConsumeMatch[1]);
		const body = await readJsonObject(request, MAX_SHARE_CONSUME_BODY_BYTES);
		const proof = requireShareProof(body.proof);
		const share = await consumeNoteShare(env, token, proof);
		return share
			? json({ ok: true, ciphertext: share.ciphertext, expiresAt: share.expires_at })
			: shareUnavailable();
	}

	const session = url.pathname.startsWith('/api/') ? await getSession(request, env) : null;
	if (session && !session.authenticated) return unauthorized();
	const vaultId = session?.vaultId || 'default';

	if (url.pathname === '/api/shares' && request.method === 'POST') {
		const body = await readJsonObject(request, MAX_SHARE_BODY_BYTES);
		const ciphertext = requireShareCiphertext(body.ciphertext);
		const proof = requireShareProof(body.proof);
		const expiresInSeconds = requireShareTtl(body.expiresInSeconds);
		const share = await createNoteShare(env, vaultId, ciphertext, proof, expiresInSeconds);
		return json({ ok: true, token: share.token, expiresAt: share.expiresAt }, 201);
	}

	if (url.pathname === '/api/health' && request.method === 'GET') {
		const result = await env.DB.prepare('SELECT COUNT(*) AS note_count FROM notes WHERE vault_id = ?')
			.bind(vaultId)
			.first<{ note_count: number }>();
		return json({
			ok: true,
			noteCount: result?.note_count ?? 0,
			authEnabled: true,
			vaultCount: getConfiguredVaultCount(env),
			now: Date.now(),
		});
	}

	if (url.pathname === '/api/crypto-config' && request.method === 'GET') {
		const vaultSalt = await getOrCreateVaultSalt(env, vaultId);
		const keyCheck = await getVaultKeyCheck(env, vaultId);
		return json({
			ok: true,
			vaultSalt,
			keyCheck,
			cipher: 'aes-gcm-256',
			kdf: 'pbkdf2-sha256',
			iterations: 250000,
			version: 1,
		});
	}

	if (url.pathname === '/api/crypto-config/key-check' && request.method === 'POST') {
		const body = await readJsonObject(request, MAX_KEY_CHECK_LENGTH + 1024);
		const candidate = requireEncryptedValue(body.keyCheck, 'keyCheck', MAX_KEY_CHECK_LENGTH);
		const keyCheck = await initializeVaultKeyCheck(env, vaultId, candidate);
		return json({ ok: true, keyCheck });
	}

	if (url.pathname === '/api/notes' && request.method === 'GET') {
		const cursor = decodeNoteCursor(url.searchParams.get('cursor'));
		const limit = getListLimit(url.searchParams.get('limit'));
		const result = await listNotes(env, vaultId, cursor, limit);
		return json({ ok: true, notes: result.notes, nextCursor: result.nextCursor });
	}

	if (url.pathname === '/api/notes' && request.method === 'POST') {
		const body = await readJsonObject(request, MAX_NOTE_BODY_BYTES);
		const title = requireEncryptedValue(body.title, 'title', MAX_ENCRYPTED_TITLE_LENGTH);
		const content = requireEncryptedValue(body.content, 'content', MAX_ENCRYPTED_CONTENT_LENGTH);
		const id = body.id === undefined ? crypto.randomUUID() : requireNoteId(body.id);
		const now = Date.now();

		const note = await env.DB.prepare(
			`INSERT INTO notes (id, vault_id, title, content, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO NOTHING
			 RETURNING id, title, content, created_at, updated_at, updated_at AS revision`
		)
			.bind(id, vaultId, title, content, now, now)
			.first<Note>();
		if (!note) return json({ ok: false, error: 'conflict', code: 'id_conflict' }, 409);
		return json({ ok: true, note }, 201);
	}

	if (url.pathname.startsWith('/api/notes/')) {
		let decodedId: string;
		try {
			decodedId = decodeURIComponent(url.pathname.slice('/api/notes/'.length));
		} catch {
			throw new ApiError(400, 'invalid_id', 'id must be a UUID');
		}
		const id = requireNoteId(decodedId);

		if (request.method === 'GET') {
			const note = await getNote(env, id, vaultId);
			if (!note) return json({ ok: false, error: 'not_found' }, 404);
			return json({ ok: true, note });
		}

		if (request.method === 'PUT') {
			const body = await readJsonObject(request, MAX_NOTE_BODY_BYTES);
			const title = requireEncryptedValue(body.title, 'title', MAX_ENCRYPTED_TITLE_LENGTH);
			const content = requireEncryptedValue(body.content, 'content', MAX_ENCRYPTED_CONTENT_LENGTH);
			if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) {
				throw new ApiError(428, 'revision_required', 'a positive revision is required');
			}

			const now = Date.now();
			const note = await env.DB.prepare(
				`UPDATE notes
				 SET title = ?,
				     content = ?,
				     updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
				 WHERE id = ? AND vault_id = ? AND updated_at = ?
				 RETURNING id, title, content, created_at, updated_at, updated_at AS revision`
			)
				.bind(title, content, now, now, id, vaultId, body.revision)
				.first<Note>();

			if (note) return json({ ok: true, note });
			const existing = await getNote(env, id, vaultId);
			if (!existing) return json({ ok: false, error: 'not_found' }, 404);
			return json(
				{ ok: false, error: 'revision_conflict', currentRevision: existing.revision },
				409
			);
		}

		if (request.method === 'DELETE') {
			const revisionHeader = request.headers.get('if-match');
			if (!revisionHeader || !/^\d+$/.test(revisionHeader) || Number(revisionHeader) < 1) {
				throw new ApiError(428, 'revision_required', 'If-Match must contain the current positive revision');
			}
			const revision = Number(revisionHeader);
			if (!Number.isSafeInteger(revision)) {
				throw new ApiError(428, 'revision_required', 'If-Match must contain the current positive revision');
			}
			const deleted = await env.DB.prepare(
				'DELETE FROM notes WHERE id = ? AND vault_id = ? AND updated_at = ? RETURNING id'
			)
				.bind(id, vaultId, revision)
				.first<{ id: string }>();
			if (!deleted) {
				const existing = await getNote(env, id, vaultId);
				if (!existing) return json({ ok: false, error: 'not_found' }, 404);
				return json(
					{ ok: false, error: 'revision_conflict', currentRevision: existing.revision },
					409
				);
			}
			return json({ ok: true });
		}
	}

	return json({ ok: false, error: 'not_found' }, 404);
}

export default {
	async fetch(request: Request, env: AppEnv): Promise<Response> {
		const requestId = getRequestId(request);
		try {
			return withCommonHeaders(await handleRequest(request, env), requestId);
		} catch (error) {
			if (error instanceof ApiError) {
				return withCommonHeaders(
					json({ ok: false, error: error.message, code: error.code }, error.status),
					requestId
				);
			}

			console.error(`Unhandled request error (${requestId})`, error);
			return withCommonHeaders(json({ ok: false, error: 'internal_error', requestId }, 500), requestId);
		}
	},
} satisfies ExportedHandler<Env>;
