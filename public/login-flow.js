/**
 * @typedef {{token: string, vaultId: string, expiresAt: number}} LoginSession
 * @typedef {(url: string, options?: RequestInit) => Promise<any>} LoginRequest
 */

/** @param {unknown} value @returns {value is LoginSession} */
export function isLoginSession(value) {
  if (!value || typeof value !== 'object') return false;
  const session = /** @type {Partial<LoginSession>} */ (value);
  return typeof session.token === 'string' && session.token.length > 0 && session.token.length <= 4096
    && typeof session.vaultId === 'string' && session.vaultId.length > 0
    && typeof session.expiresAt === 'number' && Number.isSafeInteger(session.expiresAt)
    && session.expiresAt > Date.now();
}

/**
 * A single JSON login works even when Safari discards Set-Cookie. Never navigate
 * to a native form or put a password/token in a URL.
 * @param {string} password
 * @param {LoginRequest} request
 * @returns {Promise<LoginSession>}
 */
export async function loginWithToken(password, request) {
  const session = await request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: password })
  });
  if (!isLoginSession(session)) throw new Error('登录响应不完整，请更新服务端后重试');
  return session;
}
