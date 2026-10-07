/**
 * @typedef {(url: string, options?: RequestInit) => Promise<any>} LoginRequest
 *
 * @param {string} password
 * @param {LoginRequest} request
 * @param {() => void} submitNativeForm
 * @returns {Promise<'session' | 'native-form'>}
 */
export async function loginWithSessionProbe(password, request, submitNativeForm) {
  await request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: password })
  });

  const session = await request('/api/session');
  if (!session.authenticated) {
    submitNativeForm();
    return 'native-form';
  }

  return 'session';
}
