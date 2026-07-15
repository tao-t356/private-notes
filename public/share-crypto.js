const SHARE_AAD = new TextEncoder().encode('private-notes-share:v1');
const SHARE_PROOF_CONTEXT = new TextEncoder().encode('private-notes-share-proof:v1');

/** @param {Uint8Array} bytes */
function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + chunkSize)));
  }
  return btoa(binary);
}

/** @param {Uint8Array} bytes */
function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** @param {string} value */
function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** @param {string} value */
function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('invalid key encoding');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return base64ToBytes(padded);
}

/** @param {Uint8Array} keyBytes */
export async function createShareProof(keyBytes) {
  const input = new Uint8Array(SHARE_PROOF_CONTEXT.length + 1 + keyBytes.length);
  input.set(SHARE_PROOF_CONTEXT, 0);
  input.set(keyBytes, SHARE_PROOF_CONTEXT.length + 1);
  try {
    const digest = await crypto.subtle.digest('SHA-256', input);
    return bytesToBase64Url(new Uint8Array(digest));
  } finally {
    input.fill(0);
  }
}

/** @param {string} fragment */
export function parseShareKeyFragment(fragment) {
  if (!fragment.startsWith('v1.')) throw new Error('unsupported share key version');
  const keyBytes = base64UrlToBytes(fragment.slice(3));
  if (keyBytes.byteLength !== 32) throw new Error('invalid share key length');
  return keyBytes;
}

/**
 * @param {unknown} payload
 * @returns {Promise<{ ciphertext: string, keyFragment: string, proof: string }>}
 */
export async function encryptSharedPayload(payload) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const keyFragment = 'v1.' + bytesToBase64Url(keyBytes);
  const proof = await createShareProof(keyBytes);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv, additionalData: SHARE_AAD },
      key,
      plaintext
    );
    return {
      ciphertext: 'share:v1:' + btoa(JSON.stringify({
        iv: bytesToBase64(iv),
        data: bytesToBase64(new Uint8Array(encrypted))
      })),
      keyFragment: keyFragment,
      proof: proof
    };
  } finally {
    keyBytes.fill(0);
    plaintext.fill(0);
  }
}

/** @param {unknown} value */
function parseCiphertext(value) {
  if (typeof value !== 'string') throw new Error('server did not return ciphertext');
  const match = /^share:v1:([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('unsupported share ciphertext version');
  const envelope = JSON.parse(atob(match[1]));
  if (!envelope || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string') {
    throw new Error('invalid share ciphertext envelope');
  }
  const iv = base64ToBytes(envelope.iv);
  const data = base64ToBytes(envelope.data);
  if (iv.byteLength !== 12 || data.byteLength < 16) throw new Error('invalid share ciphertext parameters');
  return { iv: iv, data: data };
}

/** @param {string} ciphertext @param {Uint8Array} keyBytes @returns {Promise<unknown>} */
export async function decryptSharedPayload(ciphertext, keyBytes) {
  const envelope = parseCiphertext(ciphertext);
  const keyMaterial = Uint8Array.from(keyBytes);
  let key;
  try {
    key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, ['decrypt']);
  } finally {
    keyMaterial.fill(0);
  }
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: envelope.iv, additionalData: SHARE_AAD },
    key,
    envelope.data
  );
  const bytes = new Uint8Array(plain);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    bytes.fill(0);
  }
}
