type AuthEnv = {
	DB: D1Database;
	APP_PASSWORD?: string;
	APP_PASSWORDS?: string;
	COOKIE_SECRET?: string;
};

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
export const SESSION_COOKIE_NAME = '__Host-session';
export const MAX_PASSWORD_LENGTH = 1024;

const LOGIN_MAX_FAILED_ATTEMPTS = 5;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const DEFAULT_VAULT_ID = 'default';
const MAX_SESSION_TOKEN_LENGTH = 4096;
const MIN_COOKIE_SECRET_LENGTH = 32;
const MANAGED_SIGNING_SECRET_META_KEY = 'managed_signing_secret:v1';
const MANAGED_SIGNING_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UNSAFE_NEW_APP_PASSWORDS = new Set(['replace-with-a-long-unique-passphrase']);
const UNSAFE_COOKIE_SECRETS = new Set([
	'change-this-to-a-long-random-string',
	'replace-with-at-least-32-random-characters',
]);

type VaultCredential = {
	vaultId: string;
	password: string;
};

type SessionData = {
	authenticated: boolean;
	vaultId: string;
};

function getCookie(request: Request, name: string) {
	const cookie = request.headers.get('cookie') || '';
	const prefix = `${name}=`;

	for (const item of cookie.split(';')) {
		const part = item.trim();
		if (!part.startsWith(prefix)) continue;

		try {
			return decodeURIComponent(part.slice(prefix.length));
		} catch {
			return '';
		}
	}

	return '';
}

function base64UrlEncode(input: string | Uint8Array) {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input: string) {
	if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new Error('invalid base64url');
	const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

async function hmacSha256Base64Url(secret: string, data: string) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return base64UrlEncode(new Uint8Array(signature));
}

function safeEqual(a: string, b: string) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

function normalizeVaultId(value: string) {
	const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
	return normalized.replace(/^-|-$/g, '') || DEFAULT_VAULT_ID;
}

function isUsableCookieSecret(value: unknown) {
	return (
		typeof value === 'string' &&
		value.length >= MIN_COOKIE_SECRET_LENGTH &&
		!UNSAFE_COOKIE_SECRETS.has(value)
	);
}

function isManagedSigningSecret(value: unknown) {
	return typeof value === 'string' && MANAGED_SIGNING_SECRET_PATTERN.test(value);
}

/**
 * Legacy Deploy to Cloudflare installs could ask users for Worker secrets, but
 * could not generate a unique random value for each deployment. Keep an
 * explicit COOKIE_SECRET as the preferred override; otherwise atomically
 * initialize one per D1 database.
 */
export async function resolveCookieSecret(env: AuthEnv) {
	const configuredSecret = env.COOKIE_SECRET;
	if (typeof configuredSecret === 'string' && isUsableCookieSecret(configuredSecret)) return configuredSecret;
	const useManagedSecret =
		typeof configuredSecret !== 'string' ||
		configuredSecret.length === 0 ||
		UNSAFE_COOKIE_SECRETS.has(configuredSecret);
	if (!useManagedSecret) {
		throw new Error('COOKIE_SECRET override is shorter than 32 characters');
	}

	const existing = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ? LIMIT 1')
		.bind(MANAGED_SIGNING_SECRET_META_KEY)
		.first<{ value: string }>();
	if (existing) {
		if (!isManagedSigningSecret(existing.value)) {
			throw new Error('managed signing secret is invalid');
		}
		return existing.value;
	}

	const candidate = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
	const created = await env.DB.prepare(
		`INSERT INTO app_meta (key, value)
		 VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = app_meta.value
		 RETURNING value`
	)
		.bind(MANAGED_SIGNING_SECRET_META_KEY, candidate)
		.first<{ value: string }>();
	if (!created || !isManagedSigningSecret(created.value)) {
		throw new Error('failed to initialize managed signing secret');
	}
	return created.value;
}

function getVaultCredentials(env: AuthEnv) {
	const credentials: VaultCredential[] = [];
	if (typeof env.APP_PASSWORD === 'string' && env.APP_PASSWORD.length > 0) {
		credentials.push({ vaultId: DEFAULT_VAULT_ID, password: env.APP_PASSWORD });
	}

	for (const item of (env.APP_PASSWORDS || '').split(',')) {
		const trimmed = item.trim();
		if (!trimmed) continue;

		const separatorIndex = trimmed.indexOf('=');
		if (separatorIndex <= 0) continue;

		const vaultId = normalizeVaultId(trimmed.slice(0, separatorIndex));
		const password = trimmed.slice(separatorIndex + 1).trim();
		if (!password) continue;
		credentials.push({ vaultId, password });
	}

	return credentials;
}

/** Returns a safe diagnostic for the Worker entry point; null means authentication is usable. */
export function getAuthConfigurationError(env: AuthEnv) {
	if (typeof env.COOKIE_SECRET !== 'string' || env.COOKIE_SECRET.length < MIN_COOKIE_SECRET_LENGTH) {
		return 'COOKIE_SECRET is missing or shorter than 32 characters';
	}
	if (UNSAFE_COOKIE_SECRETS.has(env.COOKIE_SECRET)) return 'COOKIE_SECRET still uses an example value';

	const credentials = getVaultCredentials(env);
	if (credentials.length === 0) {
		return 'APP_PASSWORD or APP_PASSWORDS is missing';
	}

	const vaultIds = new Set<string>();
	const passwords = new Set<string>();
	for (const credential of credentials) {
		if (UNSAFE_NEW_APP_PASSWORDS.has(credential.password)) return 'APP_PASSWORD still uses an example value';
		if (credential.password.length > MAX_PASSWORD_LENGTH) return 'vault password exceeds the supported length';
		if (vaultIds.has(credential.vaultId)) return `duplicate vault id: ${credential.vaultId}`;
		if (passwords.has(credential.password)) return 'duplicate vault password';
		vaultIds.add(credential.vaultId);
		passwords.add(credential.password);
	}

	return null;
}

export function getConfiguredVaultCount(env: AuthEnv) {
	return getVaultCredentials(env).length;
}

async function getCredentialFingerprint(env: AuthEnv, credential: VaultCredential) {
	if (!env.COOKIE_SECRET) return '';
	return hmacSha256Base64Url(
		env.COOKIE_SECRET,
		`session-credential\u0000${credential.vaultId}\u0000${credential.password}`
	);
}

export async function getVaultIdForPassword(env: AuthEnv, password: string) {
	if (getAuthConfigurationError(env)) return null;

	const suppliedFingerprint = await hmacSha256Base64Url(env.COOKIE_SECRET!, `login-password\u0000${password}`);
	for (const credential of getVaultCredentials(env)) {
		const configuredFingerprint = await hmacSha256Base64Url(
			env.COOKIE_SECRET!,
			`login-password\u0000${credential.password}`
		);
		if (safeEqual(suppliedFingerprint, configuredFingerprint)) return credential.vaultId;
	}
	return null;
}

export async function createSessionToken(env: AuthEnv, vaultId = DEFAULT_VAULT_ID) {
	if (getAuthConfigurationError(env)) return '';
	const normalizedVaultId = normalizeVaultId(vaultId);
	const credential = getVaultCredentials(env).find((item) => item.vaultId === normalizedVaultId);
	if (!credential) return '';

	const now = Math.floor(Date.now() / 1000);
	const payload = base64UrlEncode(
		JSON.stringify({
			v: 2,
			vaultId: normalizedVaultId,
			credential: await getCredentialFingerprint(env, credential),
			iat: now,
			exp: now + SESSION_MAX_AGE_SECONDS,
		})
	);
	const signature = await hmacSha256Base64Url(env.COOKIE_SECRET!, payload);
	return `${payload}.${signature}`;
}

async function verifySessionToken(env: AuthEnv, token: string) {
	if (getAuthConfigurationError(env) || token.length > MAX_SESSION_TOKEN_LENGTH) return null;
	const parts = token.split('.');
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	const [payload, signature] = parts;
	const expectedSignature = await hmacSha256Base64Url(env.COOKIE_SECRET!, payload);
	if (!safeEqual(signature, expectedSignature)) return null;

	try {
		const data = JSON.parse(base64UrlDecode(payload)) as {
			credential?: unknown;
			exp?: unknown;
			v?: unknown;
			vaultId?: unknown;
		};
		const now = Math.floor(Date.now() / 1000);
		if (
			data.v !== 2 ||
			typeof data.exp !== 'number' ||
			!Number.isSafeInteger(data.exp) ||
			data.exp <= now ||
			typeof data.vaultId !== 'string' ||
			normalizeVaultId(data.vaultId) !== data.vaultId ||
			typeof data.credential !== 'string'
		) {
			return null;
		}

		const credential = getVaultCredentials(env).find((item) => item.vaultId === data.vaultId);
		if (!credential) return null;
		const currentFingerprint = await getCredentialFingerprint(env, credential);
		return safeEqual(data.credential, currentFingerprint) ? credential.vaultId : null;
	} catch {
		return null;
	}
}

export async function getSession(request: Request, env: AuthEnv): Promise<SessionData> {
	if (getAuthConfigurationError(env)) {
		return { authenticated: false, vaultId: DEFAULT_VAULT_ID };
	}

	const session = getCookie(request, SESSION_COOKIE_NAME);
	if (!session) return { authenticated: false, vaultId: DEFAULT_VAULT_ID };
	const vaultId = await verifySessionToken(env, session);
	return vaultId
		? { authenticated: true, vaultId }
		: { authenticated: false, vaultId: DEFAULT_VAULT_ID };
}

function getClientIp(request: Request) {
	return (request.headers.get('cf-connecting-ip') || 'unknown').slice(0, 128);
}

async function getLoginRateLimitKey(request: Request, env: AuthEnv) {
	return hmacSha256Base64Url(env.COOKIE_SECRET!, `login-ip\u0000${getClientIp(request)}`);
}

export async function getLoginRateLimit(request: Request, env: AuthEnv) {
	const key = await getLoginRateLimitKey(request, env);
	const now = Date.now();
	const row = await env.DB.prepare(
		`SELECT locked_until
		 FROM auth_rate_limits
		 WHERE key = ?
		 LIMIT 1`
	)
		.bind(key)
		.first<{ locked_until: number }>();

	if (row?.locked_until && row.locked_until > now) {
		return {
			key,
			limited: true,
			retryAfterSeconds: Math.ceil((row.locked_until - now) / 1000),
		};
	}

	return { key, limited: false, retryAfterSeconds: 0 };
}

export async function recordFailedLogin(env: AuthEnv, key: string) {
	const now = Date.now();
	const row = await env.DB.prepare(
		`INSERT INTO auth_rate_limits (key, attempts, first_attempt_at, locked_until, updated_at)
		 VALUES (?, 1, ?, 0, ?)
		 ON CONFLICT(key) DO UPDATE SET
			attempts = CASE
				WHEN excluded.updated_at - auth_rate_limits.first_attempt_at > ? THEN 1
				ELSE auth_rate_limits.attempts + 1
			END,
			first_attempt_at = CASE
				WHEN excluded.updated_at - auth_rate_limits.first_attempt_at > ? THEN excluded.updated_at
				ELSE auth_rate_limits.first_attempt_at
			END,
			locked_until = CASE
				WHEN excluded.updated_at - auth_rate_limits.first_attempt_at > ? THEN 0
				WHEN auth_rate_limits.attempts + 1 >= ? THEN excluded.updated_at + ?
				ELSE auth_rate_limits.locked_until
			END,
			updated_at = excluded.updated_at
		 RETURNING attempts, locked_until`
	)
		.bind(
			key,
			now,
			now,
			LOGIN_RATE_LIMIT_WINDOW_MS,
			LOGIN_RATE_LIMIT_WINDOW_MS,
			LOGIN_RATE_LIMIT_WINDOW_MS,
			LOGIN_MAX_FAILED_ATTEMPTS,
			LOGIN_LOCKOUT_MS
		)
		.first<{ attempts: number; locked_until: number }>();

	if (!row) throw new Error('failed to update login rate limit');
	return {
		attempts: row.attempts,
		locked: row.locked_until > now,
		retryAfterSeconds: row.locked_until > now ? Math.ceil((row.locked_until - now) / 1000) : 0,
	};
}

export async function clearFailedLogins(env: AuthEnv, key: string) {
	await env.DB.prepare('DELETE FROM auth_rate_limits WHERE key = ?').bind(key).run();
}

export async function cleanupOldLoginRateLimits(env: AuthEnv) {
	const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
	await env.DB.prepare('DELETE FROM auth_rate_limits WHERE updated_at < ?').bind(cutoff).run();
}

export function tooManyLoginAttempts(retryAfterSeconds: number) {
	const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
	const minutes = Math.max(1, Math.ceil(seconds / 60));
	return new Response(
		JSON.stringify({
			ok: false,
			error: `登录失败次数过多，请 ${minutes} 分钟后再试`,
			retryAfterSeconds: seconds,
		}),
		{
			status: 429,
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'no-store',
				'retry-after': String(seconds),
				'x-content-type-options': 'nosniff',
			},
		}
	);
}
