/**
 * @typedef {(url: string, options?: RequestInit) => Promise<any>} LoginRequest
 *
 * @param {string} password
 * @param {LoginRequest} request
 * @param {(token: string) => void} submitNativeForm
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
    const formTokenResponse = await request('/api/login/form-token');
    if (!formTokenResponse || typeof formTokenResponse.token !== 'string' || !formTokenResponse.token) {
      throw new Error('服务器未返回有效的登录表单令牌');
    }
    submitNativeForm(formTokenResponse.token);
    return 'native-form';
  }

  return 'session';
}
