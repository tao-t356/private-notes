import { encryptSharedPayload } from './share-crypto.js';
import { createQrSvg } from './qr.js';
import { loginWithToken, isLoginSession } from './login-flow.js';
import { createDeviceSessionStore, clearLegacyDeviceStore, DEVICE_SESSION_KEY, LEGACY_DEVICE_SESSION_KEY, LOGOUT_EVENT_KEY } from './device-session.js';

const deviceStore = createDeviceSessionStore();
/** @type {import('./login-flow.js').LoginSession | null} */
let activeSession = null;
let storageMessage = '';
let authGeneration = 0;
/** @type {Set<AbortController>} */
const pendingRequests = new Set();
clearLegacyDeviceStore();
try { deviceStore.forgetLegacy(); } catch { /* Best effort cleanup only. */ }

/**
 * @typedef {{ id: string, title: string, content: string, created_at: number, updated_at: number, revision: number }} RawNote
 * @typedef {RawNote & { encrypted: boolean, decryptFailed: boolean }} Note
 * @typedef {{ vaultSalt: string, cipher: 'aes-gcm-256', kdf: 'pbkdf2-sha256', iterations: number, version: 1, keyCheck: string | null }} CryptoConfig
 * @typedef {{ title: string, content: string, payload: { id?: string, revision?: number, title: string, content: string } }} SaveAttempt
 */

class VaultPasswordError extends Error {}
class SessionChangedError extends Error {
  constructor() { super('登录状态已改变'); }
}

const KEY_CHECK_MARKER = 'private-notes-key-check:v1';
const NOTE_RENDER_BATCH_SIZE = 50;
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
});
const dayFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit'
});

/** @type {{
 * notes: Note[],
 * allNotes: Note[],
 * editingId: string | null,
 * editingRevision: number | null,
 * editorCreateId: string | null,
 * editorOperationId: number,
 * editorSaving: boolean,
 * editorAttempt: SaveAttempt | null,
 * sharingNoteId: string | null,
 * shareOperationId: number,
 * shareCreating: boolean,
 * shareReturnFocus: HTMLElement | null,
 * loginSubmitting: boolean,
 * restoreSubmitting: boolean,
 * authView: 'restoring' | 'login' | 'app',
 * restoreError: string,
 * notesLoading: boolean,
 * notesError: string,
 * listReady: boolean,
 * refreshOperationId: number,
 * visibleLimit: number,
 * searchQuery: string,
 * searchTimer: number | null,
 * searchComposing: boolean,
 * searchIndex: Map<string, { title: string, content: string }>,
 * deletingIds: Set<string>,
 * expandedIds: Set<string>,
 * statusTimer: number | null,
 * sessionAuthenticated: boolean,
 * authMode: 'login' | 'recover',
 * vaultUnlocked: boolean,
 * vaultKey: CryptoKey | null,
 * cryptoConfig: CryptoConfig | null,
 * noteCountMeta: number,
 * decryptFailedCount: number,
 * legacyPlaintextCount: number,
 * unlockError: string,
 * appShortName: string
 * }} */
const state = {
  notes: [],
  allNotes: [],
  editingId: null,
  editingRevision: null,
  editorCreateId: null,
  editorOperationId: 0,
  editorSaving: false,
  editorAttempt: null,
  sharingNoteId: null,
  shareOperationId: 0,
  shareCreating: false,
  shareReturnFocus: null,
  loginSubmitting: false,
  restoreSubmitting: false,
  authView: 'restoring',
  restoreError: '',
  notesLoading: false,
  notesError: '',
  listReady: false,
  refreshOperationId: 0,
  visibleLimit: NOTE_RENDER_BATCH_SIZE,
  searchQuery: '',
  searchTimer: null,
  searchComposing: false,
  searchIndex: new Map(),
  deletingIds: new Set(),
  expandedIds: new Set(),
  statusTimer: null,
  sessionAuthenticated: false,
  authMode: 'login',
  vaultUnlocked: false,
  vaultKey: null,
  cryptoConfig: null,
  noteCountMeta: 0,
  decryptFailedCount: 0,
  legacyPlaintextCount: 0,
  unlockError: '',
  appShortName: document.documentElement.dataset.appShortName || '我的笔记'
};
/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function getElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error('页面缺少必要元素：' + id);
  return element;
}

/** @param {string} id @returns {HTMLInputElement} */
function getInput(id) {
  const element = getElement(id);
  if (!(element instanceof HTMLInputElement)) throw new Error('页面元素类型错误：' + id);
  return element;
}

/** @param {string} id @returns {HTMLTextAreaElement} */
function getTextArea(id) {
  const element = getElement(id);
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('页面元素类型错误：' + id);
  return element;
}

/** @param {string} id @returns {HTMLSelectElement} */
function getSelect(id) {
  const element = getElement(id);
  if (!(element instanceof HTMLSelectElement)) throw new Error('页面元素类型错误：' + id);
  return element;
}

/** @param {string} id @returns {HTMLButtonElement} */
function getButton(id) {
  const element = getElement(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error('页面元素类型错误：' + id);
  return element;
}

const els = {
  loginView: getElement('loginView'),
  loginForm: getElement('loginForm'),
  appView: getElement('appView'),
  loginTitle: getElement('loginTitle'),
  loginDesc: getElement('loginDesc'),
  passwordInput: getInput('passwordInput'),
  rememberDevice: getInput('rememberDevice'),
  deviceStatus: getElement('deviceStatus'),
  passwordHelp: getElement('passwordHelp'),
  loginBtn: getButton('loginBtn'),
  loginLogoutBtn: getButton('loginLogoutBtn'),
  loginStatus: getElement('loginStatus'),
  topbar: getElement('topbar'),
  searchInput: getInput('searchInput'),
  clearSearchBtn: getButton('clearSearchBtn'),
  searchBtn: getButton('searchBtn'),
  newBtn: getButton('newBtn'),
  fabNewBtn: getButton('fabNewBtn'),
  fabTopBtn: getButton('fabTopBtn'),
  logoutBtn: getButton('logoutBtn'),
  statusLine: getElement('statusLine'),
  vaultPanel: getElement('vaultPanel'),
  vaultPanelDesc: getElement('vaultPanelDesc'),
  noteCount: getElement('noteCount'),
  noteList: getElement('noteList'),
  loadPanel: getElement('loadPanel'),
  loadMessage: getElement('loadMessage'),
  retryLoadBtn: getButton('retryLoadBtn'),
  loadMoreBtn: getButton('loadMoreBtn'),
  editorModal: getElement('editorModal'),
  modalTitle: getElement('modalTitle'),
  editorTitle: getInput('editorTitle'),
  editorContent: getTextArea('editorContent'),
  editorStatus: getElement('editorStatus'),
  closeModalBtn: getButton('closeModalBtn'),
  cancelBtn: getButton('cancelBtn'),
  saveBtn: getButton('saveBtn'),
  shareModal: getElement('shareModal'),
  shareNoteLabel: getElement('shareNoteLabel'),
  shareExpiry: getSelect('shareExpiry'),
  shareSetup: getElement('shareSetup'),
  shareResult: getElement('shareResult'),
  shareLinkInput: getInput('shareLinkInput'),
  shareLinkLabel: getElement('shareLinkLabel'),
  shareExpiryLabel: getElement('shareExpiryLabel'),
  shareQrPanel: getElement('shareQrPanel'),
  shareQr: getElement('shareQr'),
  closeShareModalBtn: getButton('closeShareModalBtn'),
  cancelShareBtn: getButton('cancelShareBtn'),
  createShareBtn: getButton('createShareBtn'),
  copyShareLinkBtn: getButton('copyShareLinkBtn')
};

/** @param {string} text */
function setStatus(text) {
  if (state.statusTimer !== null) window.clearTimeout(state.statusTimer);
  if (!text) {
    els.statusLine.textContent = '';
    els.statusLine.classList.remove('show');
    return;
  }
  els.statusLine.textContent = text;
  els.statusLine.classList.add('show');
  state.statusTimer = window.setTimeout(function () {
    els.statusLine.classList.remove('show');
  }, 1800);
}

function updateSearchUi() {
  const hasText = Boolean(els.searchInput.value.trim());
  els.clearSearchBtn.classList.toggle('show', hasText);
}

function updateScrollUi() {
  const shouldShow = window.scrollY > 320;
  els.fabTopBtn.classList.toggle('show', shouldShow);
}

function updateModalUi() {
  const open = !els.editorModal.classList.contains('hidden') || !els.shareModal.classList.contains('hidden');
  [els.topbar, els.fabNewBtn, els.fabTopBtn].forEach(function (element) {
    element.classList.toggle('modal-obscured', open);
  });
  [els.loginView, els.appView, els.fabNewBtn, els.fabTopBtn].forEach(function (element) {
    element.inert = open;
  });
}

function updateLoginMode() {
  const recovering = state.authMode === 'recover';
  els.loginBtn.disabled = state.loginSubmitting;
  els.rememberDevice.disabled = state.loginSubmitting;
  els.loginTitle.textContent = recovering ? '输入原笔记密码' : '登录到' + state.appShortName;
  els.loginDesc.textContent = recovering
    ? '访问密码已验证。旧笔记使用的是以前的密码，请输入原密码继续，不会改动笔记。'
    : '输入密码即可进入；记住设备后下次会恢复登录，再输入笔记密码解锁。';
  els.passwordInput.placeholder = recovering ? '原笔记密码' : '输入密码';
  els.passwordHelp.textContent = recovering ? '仅密码修改过的旧笔记需要这一步。' : '使用你设置的密码，不要求大小写或特殊符号。';
  els.loginBtn.textContent = state.loginSubmitting ? '正在打开…' : '进入笔记';
  els.loginLogoutBtn.classList.toggle('hidden', !recovering);
}

function updateLoadUi() {
  const restoring = state.authView === 'restoring';
  const error = restoring ? state.restoreError : state.notesError;
  const loading = restoring ? !error : state.notesLoading || (!state.listReady && !error);
  els.loadPanel.classList.toggle('hidden', state.authView === 'login' || (!loading && !error));
  els.loadMessage.textContent = error || (restoring ? '正在恢复笔记…' : '正在加载笔记…');
  els.retryLoadBtn.classList.toggle('hidden', !error);
  els.retryLoadBtn.disabled = state.restoreSubmitting || state.notesLoading;
  els.noteList.setAttribute('aria-busy', String(state.authView !== 'login' && loading));
  if (state.authView !== 'login' && !state.listReady) els.noteCount.textContent = error ? '尚未加载' : '正在加载…';
}

function updateVaultUi() {
  const ready = state.vaultUnlocked && state.listReady && !state.notesLoading;
  els.vaultPanel.classList.add('hidden');
  els.searchInput.disabled = !ready;
  els.searchBtn.disabled = !ready;
  els.clearSearchBtn.disabled = !ready;
  els.newBtn.disabled = !ready;
  els.fabNewBtn.disabled = !ready;
  els.logoutBtn.disabled = state.authView === 'login';
  els.vaultPanelDesc.textContent = state.unlockError
    ? state.unlockError + '。如果你已经忘记密码，旧密文无法在页面内恢复。'
    : state.noteCountMeta > 0
      ? '你当前有 ' + state.noteCountMeta + ' 条已加密笔记。请输入密码查看内容；忘记密码将无法在页面内恢复旧密文。'
      : '当前还没有可显示的解密内容。输入密码后可正常使用。';
  updateLoadUi();
}

/** @param {Uint8Array} bytes */
function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

/** @param {string} base64 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function clearSensitiveInputs() {
  els.passwordInput.value = '';
}

/**
 * Fetches and validates the server-owned encryption parameters. Unsupported
 * versions fail visibly instead of silently writing incompatible ciphertext.
 * @returns {Promise<CryptoConfig>}
 */
async function getCryptoConfig() {
  const generation = authGeneration;
  const data = await api('/api/crypto-config');
  const config = {
    vaultSalt: String(data.vaultSalt || ''),
    cipher: String(data.cipher || ''),
    kdf: String(data.kdf || ''),
    iterations: Number(data.iterations),
    version: Number(data.version),
    keyCheck: typeof data.keyCheck === 'string' && data.keyCheck ? data.keyCheck : null
  };

  if (!config.vaultSalt) {
    throw new Error('服务器未返回加密盐值');
  }
  if (config.cipher !== 'aes-gcm-256') {
    throw new Error('暂不支持服务器指定的加密算法：' + config.cipher);
  }
  if (config.kdf !== 'pbkdf2-sha256') {
    throw new Error('暂不支持服务器指定的密钥派生算法：' + config.kdf);
  }
  if (!Number.isSafeInteger(config.iterations) || config.iterations < 100000 || config.iterations > 10000000) {
    throw new Error('服务器返回的密钥派生迭代次数无效');
  }
  if (config.version !== 1) {
    throw new Error('暂不支持加密协议版本：' + config.version);
  }

  if (generation !== authGeneration) throw new Error('登录状态已改变');
  state.cryptoConfig = /** @type {CryptoConfig} */ (config);
  return state.cryptoConfig;
}

async function refreshMeta() {
  const generation = authGeneration;
  const data = await api('/api/health');
  if (generation !== authGeneration) return;
  state.noteCountMeta = data.noteCount || 0;
  updateVaultUi();
}

/**
 * @param {string} passphrase
 * @param {CryptoConfig} config
 */
async function deriveVaultKey(passphrase, config) {
  const generation = authGeneration;
  if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('请使用 HTTPS 打开笔记，并启用浏览器 JavaScript');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name: 'PBKDF2', salt: base64ToBytes(config.vaultSalt),
    iterations: config.iterations, hash: 'SHA-256'}, material, 256);
  if (generation !== authGeneration) throw new SessionChangedError();
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * @param {unknown} value
 */
function isEncryptedValue(value) {
  return typeof value === 'string' && value.startsWith('enc:v1:');
}

/**
 * @param {string} value
 * @param {CryptoKey | null} [key]
 * @param {CryptoConfig | null} [config]
 */
async function encryptValue(value, key = state.vaultKey, config = state.cryptoConfig) {
  if (!config || !key) {
    throw new Error('加密配置尚未就绪');
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherName = config.cipher === 'aes-gcm-256' ? 'AES-GCM' : config.cipher;
  const cipher = await crypto.subtle.encrypt(
    { name: cipherName, iv: iv },
    key,
    new TextEncoder().encode(value || '')
  );

  return 'enc:v' + config.version + ':' + btoa(JSON.stringify({
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(cipher))
  }));
}

/**
 * Encrypts a decrypted note with a fresh random key that is never sent to the
 * server. The proof lets the share endpoint authorize consumption without
 * learning that key.
 * @param {Note} note
 */
async function encryptShare(note) {
  return encryptSharedPayload({
    v: 1,
    title: note.title || '无标题',
    content: note.content || '',
    createdAt: note.created_at,
    sharedAt: Date.now()
  });
}

/**
 * Keeps existing enc:v1 payloads readable while rejecting unknown versions.
 * @param {string} value
 */
async function decryptValue(value) {
  if (!isEncryptedValue(value)) return value || '';
  if (!state.cryptoConfig || !state.vaultKey) {
    throw new Error('解密配置尚未就绪');
  }

  const prefix = value.match(/^enc:v(\d+):/);
  const payloadVersion = Number(prefix && prefix[1]);
  if (!prefix || payloadVersion !== 1) {
    throw new Error('不支持的密文版本');
  }

  const payload = JSON.parse(atob(value.slice(prefix[0].length)));
  const cipherName = state.cryptoConfig.cipher === 'aes-gcm-256'
    ? 'AES-GCM'
    : state.cryptoConfig.cipher;
  const plain = await crypto.subtle.decrypt(
    { name: cipherName, iv: base64ToBytes(payload.iv) },
    state.vaultKey,
    base64ToBytes(payload.data)
  );

  return new TextDecoder().decode(plain);
}

/**
 * @param {RawNote[]} rawNotes
 * @returns {Promise<Note[]>}
 */
async function decryptNotes(rawNotes) {
  /** @type {Note[]} */
  const decrypted = [];
  let failedCount = 0;

  for (const note of rawNotes) {
    try {
      const encrypted = isEncryptedValue(note.title) && isEncryptedValue(note.content);
      decrypted.push({
        id: note.id,
        title: await decryptValue(note.title),
        content: await decryptValue(note.content),
        created_at: note.created_at,
        updated_at: note.updated_at,
        revision: note.revision,
        encrypted: encrypted,
        decryptFailed: false
      });
    } catch (error) {
      failedCount += 1;
      decrypted.push({
        id: note.id,
        title: '⚠ 无法解密此笔记',
        content: '这条笔记无法使用当前密钥解密。服务器中的原始密文仍然保留；为避免覆盖，编辑、复制和删除已禁用。',
        created_at: note.created_at,
        updated_at: note.updated_at,
        revision: note.revision,
        encrypted: true,
        decryptFailed: true
      });
    }
  }

  if (rawNotes.length > 0 && failedCount === rawNotes.length && !state.cryptoConfig?.keyCheck) {
    throw new VaultPasswordError('旧笔记需要原来的密码，请输入原密码');
  }
  return decrypted;
}

function refreshLocalMetadata() {
  state.noteCountMeta = state.allNotes.length;
  state.decryptFailedCount = state.allNotes.filter(function (note) { return note.decryptFailed; }).length;
  state.legacyPlaintextCount = state.allNotes.filter(function (note) { return !note.encrypted; }).length;
  const ids = new Set(state.allNotes.map(function (note) { return note.id; }));
  state.searchIndex.forEach(function (_, id) { if (!ids.has(id)) state.searchIndex.delete(id); });
  state.expandedIds.forEach(function (id) { if (!ids.has(id)) state.expandedIds.delete(id); });
}

/** @param {Note} note */
function indexNote(note) {
  state.searchIndex.set(note.id, {
    title: (note.title || '').toLocaleLowerCase('zh-CN'),
    content: (note.content || '').toLocaleLowerCase('zh-CN')
  });
}

/** @param {Note} note */
function upsertLocalNote(note) {
  state.refreshOperationId += 1;
  state.notesLoading = false;
  state.notesError = '';
  state.listReady = true;
  state.allNotes = state.allNotes.filter(function (item) { return item.id !== note.id; });
  state.allNotes.push(note);
  state.allNotes.sort(function (a, b) {
    return b.updated_at - a.updated_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  });
  indexNote(note);
  refreshLocalMetadata();
  updateVaultUi();
  applySearch();
}

/**
 * Search is memory-only: keystrokes never trigger API requests or repeat
 * decryption work.
 * @param {Note[]} notes
 * @param {string} query
 */
function filterNotes(notes, query) {
  const q = (query || '').trim().toLocaleLowerCase('zh-CN');
  if (!q) return notes;
  return notes.filter(function (note) {
    if (note.decryptFailed) return true;
    if (!state.searchIndex.has(note.id)) indexNote(note);
    const indexed = state.searchIndex.get(note.id);
    return Boolean(indexed && (indexed.title.includes(q) || indexed.content.includes(q)));
  });
}

function cancelSearch() {
  if (state.searchTimer !== null) window.clearTimeout(state.searchTimer);
  state.searchTimer = null;
}

function scheduleSearch() {
  cancelSearch();
  if (state.searchComposing) return;
  state.searchTimer = window.setTimeout(applySearch, 150);
}

function applySearch() {
  cancelSearch();
  const query = els.searchInput.value.trim();
  if (state.searchQuery !== query) state.visibleLimit = NOTE_RENDER_BATCH_SIZE;
  state.searchQuery = query;
  state.notes = filterNotes(state.allNotes, query);
  renderList();
}

function showLogin() {
  if (state.authView === 'login' && state.sessionAuthenticated && activeSession) {
    state.authMode = 'recover';
  }
  state.authView = 'login';
  els.loginView.classList.remove('hidden');
  els.appView.classList.add('app-dimmed');
  updateLoginMode();
  updateVaultUi();
}

/** @param {string} [error] */
function showRestoring(error = '') {
  state.authView = 'restoring';
  state.restoreError = error;
  els.loginView.classList.add('hidden');
  els.appView.classList.remove('app-dimmed');
  updateVaultUi();
}

function showApp() {
  if (state.sessionAuthenticated && state.vaultUnlocked) {
    state.authView = 'app';
    els.loginView.classList.add('hidden');
    els.appView.classList.remove('app-dimmed');
  } else {
    showLogin();
  }
  updateVaultUi();
}

/** @param {number} ts */
function formatDate(ts) {
  return ts ? dateFormatter.format(new Date(ts)) : '-';
}

/** @param {number} ts */
function formatGroupLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  /** @param {Date} value */
  const startOf = function (value) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  };
  const diffDays = Math.floor((startOf(now) - startOf(d)) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  return dayFormatter.format(d);
}

/** @param {string} text */
function wordCount(text) {
  return (text || '').replace(/\s+/g, '').length;
}

/** @param {string} text */
function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {string} text @param {string} query */
function highlightText(text, query) {
  const safe = escapeHtml(text || '');
  if (!query) return safe;
  const escaped = escapeRegExp(query.trim());
  if (!escaped) return safe;
  return safe.replace(new RegExp(escaped, 'gi'), function (match) {
    return '<mark class="search-highlight">' + match + '</mark>';
  });
}

/** @param {Note} note */
function getDisplayContent(note) {
  const content = note.content || '';
  const lines = content.split('\n');
  const expanded = state.expandedIds.has(note.id);
  return {
    text: expanded ? content : lines.slice(0, 30).join('\n'),
    expanded: expanded,
    canExpand: lines.length > 30
  };
}

/**
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
async function api(url, options) {
  const generation = authGeneration;
  const headers = new Headers(options?.headers);
  if (activeSession && url !== '/api/login') headers.set('authorization', 'Bearer ' + activeSession.token);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (controller && url !== '/api/logout') pendingRequests.add(controller);
  let timer = 0;
  /** @type {Promise<never>} */
  const deadline = new Promise(function (_, reject) {
    timer = window.setTimeout(function () {
      if (controller) controller.abort();
      reject(new Error('request timed out'));
    }, 15000);
  });
  let result;
  try {
    result = await Promise.race([
      (async function () {
        const res = await fetch(url, Object.assign({}, options || {}, {
          credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', headers: headers,
          signal: controller ? controller.signal : undefined
        }));
        const data = await res.json().catch(function () { return {}; });
        return { res: res, data: data };
      }()),
      deadline
    ]);
  } catch {
    if (generation !== authGeneration) throw new SessionChangedError();
    throw new Error('连接中断或超时，请重试；无需重新设置密码');
  } finally {
    window.clearTimeout(timer);
    if (controller) pendingRequests.delete(controller);
  }
  const res = result.res;
  const data = result.data;
  if (res.status === 401) {
    if (url === '/api/login') throw new Error('密码不正确，请重试');
    if (generation === authGeneration) { forgetDevice(); resetLocalSession(); }
    throw new Error('登录已失效，请重新输入密码');
  }
  if (!res.ok) {
    if (res.status === 409 && data.error === 'revision_conflict') {
      throw new Error('这条笔记已在其他页面更新，当前输入已保留，请先复制内容再重新打开笔记');
    }
    if (res.status === 409 && data.code === 'id_conflict') {
      throw new Error('此前的新建请求可能已经保存，当前输入已保留，请先复制内容再刷新确认');
    }
    if (res.status === 503 && data.code === 'auth_not_configured') {
      throw new Error('服务端认证尚未正确配置，请检查必需 Secrets');
    }
    throw new Error(data.error || '请求失败');
  }
  return data;
}

/**
 * Loads every cursor page once per refresh so local search covers the complete
 * vault, not only the first page.
 * @returns {Promise<RawNote[]>}
 */
async function fetchRawNotes() {
  const generation = authGeneration;
  /** @type {RawNote[]} */
  const notes = [];
  /** @type {string | null} */
  let cursor = null;
  const seenCursors = new Set();

  do {
    const query = cursor
      ? '?limit=10&cursor=' + encodeURIComponent(cursor)
      : '?limit=10';
    const data = await api('/api/notes' + query);
    if (generation !== authGeneration) throw new SessionChangedError();
    if (!Array.isArray(data.notes)) {
      throw new Error('服务器返回的笔记列表格式无效');
    }
    notes.push(...data.notes);

    const nextCursor = typeof data.nextCursor === 'string' && data.nextCursor
      ? data.nextCursor
      : null;
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new Error('服务器返回了重复的分页游标');
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return notes;
}

function renderList() {
  els.noteList.innerHTML = '';
  els.loadMoreBtn.classList.add('hidden');
  if (state.authView === 'restoring' || (state.vaultUnlocked && !state.listReady)) {
    updateLoadUi();
    return;
  }
  els.noteCount.textContent = state.notes.length ? ('共 ' + state.notes.length + ' 条') : '0 条';
  if (state.decryptFailedCount > 0) {
    els.noteCount.textContent += ' · ' + state.decryptFailedCount + ' 条无法解密';
  }
  if (state.legacyPlaintextCount > 0) {
    els.noteCount.textContent += ' · ' + state.legacyPlaintextCount + ' 条待加密';
  }

  if (!state.vaultUnlocked) {
    els.noteCount.textContent = state.noteCountMeta ? ('共 ' + state.noteCountMeta + ' 条（已加密）') : '0 条';
    els.noteList.innerHTML = '<div class="empty-feed">正文已加密。登录站点后，再输入笔记密码才能看到内容和搜索结果。</div>';
    return;
  }

  if (!state.notes.length) {
    els.noteList.innerHTML = '<div class="empty-feed">现在还没有笔记。点击右上角“新建笔记”，写第一条就行。</div>';
    return;
  }

  if (state.decryptFailedCount > 0) {
    const warning = document.createElement('div');
    warning.className = 'decrypt-warning';
    warning.setAttribute('role', 'alert');
    warning.textContent = '有 ' + state.decryptFailedCount + ' 条笔记无法解密，已保留占位且不会被静默隐藏。请确认密码和加密配置后再处理。';
    els.noteList.appendChild(warning);
  }
  if (state.legacyPlaintextCount > 0) {
    const warning = document.createElement('div');
    warning.className = 'decrypt-warning';
    warning.setAttribute('role', 'status');
    warning.textContent = '有 ' + state.legacyPlaintextCount + ' 条历史笔记仍包含旧版明文。逐条打开并保存后会转换为客户端密文。';
    els.noteList.appendChild(warning);
  }

  const visibleNotes = state.notes.slice(0, state.visibleLimit);
  const remaining = state.notes.length - visibleNotes.length;
  els.loadMoreBtn.classList.toggle('hidden', remaining === 0);
  els.loadMoreBtn.textContent = '显示更多笔记（剩余 ' + remaining + ' 条）';
  /** @type {Map<string, Note[]>} */
  const groups = new Map();
  visibleNotes.forEach(function (note) {
    const key = formatGroupLabel(note.updated_at);
    const group = groups.get(key);
    if (group) {
      group.push(note);
    } else {
      groups.set(key, [note]);
    }
  });

  groups.forEach(function (notes, groupLabel) {
    const group = document.createElement('section');
    group.className = 'group-block';

    const groupTitle = document.createElement('div');
    groupTitle.className = 'group-title';
    groupTitle.textContent = groupLabel;
    group.appendChild(groupTitle);

    notes.forEach(function (note) {
      const card = document.createElement('article');
      card.className = 'note-card' + (note.decryptFailed ? ' decrypt-failed' : '');

      const meta = document.createElement('div');
      meta.className = 'note-card-meta';
      meta.innerHTML = '<span>' + formatDate(note.updated_at) + '</span><span>' + (note.decryptFailed ? '无法解密' : wordCount(note.content) + ' 字') + '</span>';

      const title = document.createElement('div');
      title.className = 'note-card-title';
      title.innerHTML = highlightText(note.title || '无标题', els.searchInput.value.trim());

      const actions = document.createElement('div');
      actions.className = 'note-actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn';
      copyBtn.textContent = '复制全文';
      copyBtn.disabled = note.decryptFailed;
      copyBtn.onclick = async function () {
        const generation = authGeneration;
        try {
          await navigator.clipboard.writeText(note.content || '');
          if (generation === authGeneration) setStatus('已复制：' + (note.title || '无标题'));
        } catch (error) {
          if (generation === authGeneration) setStatus('复制失败，请手动选择文本复制');
        }
      };

      const shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.className = 'btn secondary';
      shareBtn.textContent = '分享';
      shareBtn.disabled = note.decryptFailed;
      shareBtn.onclick = function () {
        openShareDialog(note);
      };

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn secondary';
      editBtn.textContent = '编辑';
      editBtn.disabled = note.decryptFailed;
      editBtn.onclick = function () {
        openComposer(note);
      };

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn danger';
      deleteBtn.textContent = '删除';
      deleteBtn.disabled = note.decryptFailed;
      deleteBtn.onclick = function () {
        deleteNote(note.id).catch(function (error) {
          setStatus(error.message || '删除失败');
        });
      };

      const body = document.createElement('div');
      const displayContent = getDisplayContent(note);
      body.className = 'note-card-text' + (note.content ? '' : ' is-empty');
      body.textContent = note.content ? displayContent.text : '这条笔记还没有内容。';
      const bodyWrap = document.createElement('div');
      bodyWrap.className = 'note-card-text-wrap' + (displayContent.canExpand && !displayContent.expanded ? ' collapsed' : '');
      bodyWrap.appendChild(body);

      card.appendChild(meta);
      card.appendChild(actions);
      actions.appendChild(copyBtn);
      actions.appendChild(shareBtn);
      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);
      card.appendChild(title);
      card.appendChild(bodyWrap);

      if (displayContent.canExpand) {
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'btn secondary note-expand';
        toggleBtn.textContent = displayContent.expanded ? '收起' : '展开全文';
        toggleBtn.onclick = function () {
          if (state.expandedIds.has(note.id)) {
            state.expandedIds.delete(note.id);
          } else {
            state.expandedIds.add(note.id);
          }
          const currentDisplay = getDisplayContent(note);
          body.textContent = note.content ? currentDisplay.text : '这条笔记还没有内容。';
          bodyWrap.classList.toggle('collapsed', currentDisplay.canExpand && !currentDisplay.expanded);
          toggleBtn.textContent = currentDisplay.expanded ? '收起' : '展开全文';
        };
        card.appendChild(toggleBtn);
      }

      group.appendChild(card);
    });

    els.noteList.appendChild(group);
  });
}

async function refreshNotes() {
  const generation = authGeneration;
  const operationId = ++state.refreshOperationId;
  state.notesLoading = true;
  state.notesError = '';
  updateVaultUi();
  try {
    if (!state.vaultUnlocked) {
      await refreshMeta();
      if (generation !== authGeneration || operationId !== state.refreshOperationId) return;
      state.notes = [];
      state.allNotes = [];
      state.searchIndex.clear();
      state.decryptFailedCount = 0;
      state.legacyPlaintextCount = 0;
      renderList();
      return;
    }

    const rawNotes = await fetchRawNotes();
    if (generation !== authGeneration || operationId !== state.refreshOperationId) return;
    const notes = await decryptNotes(rawNotes);
    if (generation !== authGeneration || operationId !== state.refreshOperationId || !state.vaultUnlocked) return;
    state.allNotes = notes;
    state.listReady = true;
    state.searchIndex.clear();
    notes.forEach(indexNote);
    refreshLocalMetadata();
    applySearch();
  } catch (error) {
    if (generation !== authGeneration || operationId !== state.refreshOperationId) return;
    state.notesError = error instanceof Error ? error.message : '笔记加载失败，请重试';
    throw error;
  } finally {
    if (generation === authGeneration && operationId === state.refreshOperationId) {
      state.notesLoading = false;
      updateVaultUi();
    }
  }
}

function createNoteId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** @param {boolean} saving */
function setEditorSaving(saving) {
  state.editorSaving = saving;
  [els.saveBtn, els.cancelBtn, els.closeModalBtn, els.editorTitle, els.editorContent].forEach(function (element) {
    element.disabled = saving;
  });
  els.saveBtn.textContent = saving ? '保存中…' : '保存';
  els.editorModal.setAttribute('aria-busy', String(saving));
}

/** @param {number} operationId @param {number} generation */
function isCurrentEditorOperation(operationId, generation) {
  return operationId === state.editorOperationId && generation === authGeneration &&
    !els.editorModal.classList.contains('hidden');
}

/** @param {Note | null} note */
function openComposer(note) {
  if (state.editorSaving) { setStatus('正在保存，请稍候'); return; }
  if (!state.vaultUnlocked || !state.listReady || state.notesLoading || note?.decryptFailed) return;
  state.editorOperationId += 1;
  state.editingId = note ? note.id : null;
  state.editingRevision = note ? note.revision : null;
  state.editorCreateId = note ? null : createNoteId();
  state.editorAttempt = null;
  setEditorSaving(false);
  els.modalTitle.textContent = note ? '编辑笔记' : '新建笔记';
  els.editorTitle.value = note ? note.title : '';
  els.editorContent.value = note ? note.content : '';
  els.editorStatus.textContent = '';
  els.editorModal.classList.remove('hidden');
  updateModalUi();
  els.editorTitle.focus();
}

/** @param {boolean} [force] */
function closeComposer(force = false) {
  if (state.editorSaving && !force) { setStatus('正在保存，请稍候'); return; }
  state.editorOperationId += 1;
  setEditorSaving(false);
  els.editorModal.classList.add('hidden');
  state.editingId = null;
  state.editingRevision = null;
  state.editorCreateId = null;
  state.editorAttempt = null;
  els.editorTitle.value = '';
  els.editorContent.value = '';
  els.editorStatus.textContent = '';
  updateModalUi();
}

async function saveComposer() {
  if (state.editorSaving || els.editorModal.classList.contains('hidden')) return;
  const titleInput = els.editorTitle.value.trim();
  const content = els.editorContent.value;
  if (!titleInput && !content.trim()) {
    els.editorStatus.textContent = '标题和内容至少写一个';
    return;
  }
  if (!state.vaultUnlocked || !state.vaultKey || !state.cryptoConfig) {
    els.editorStatus.textContent = '请先输入笔记密码解锁';
    return;
  }

  const title = titleInput || '无标题';
  const editingId = state.editingId;
  const revision = state.editingRevision;
  const createId = state.editorCreateId;
  if ((editingId && (!Number.isSafeInteger(revision) || Number(revision) < 1)) || (!editingId && !createId)) {
    throw new Error('编辑状态无效，请保留内容并重新打开编辑器');
  }
  const key = state.vaultKey;
  const config = state.cryptoConfig;
  const operationId = state.editorOperationId;
  const generation = authGeneration;
  setEditorSaving(true);
  els.editorStatus.textContent = '保存中…';
  try {
    let attempt = state.editorAttempt;
    if (!attempt || attempt.title !== title || attempt.content !== content) {
      const encryptedValues = await Promise.all([
        encryptValue(title, key, config), encryptValue(content, key, config)
      ]);
      if (!isCurrentEditorOperation(operationId, generation)) return;
      attempt = {
        title: title,
        content: content,
        payload: Object.assign({ title: encryptedValues[0], content: encryptedValues[1] },
          editingId ? { revision: Number(revision) } : { id: String(createId) })
      };
      state.editorAttempt = attempt;
    }
    if (!isCurrentEditorOperation(operationId, generation)) return;
    const data = await api(editingId ? '/api/notes/' + encodeURIComponent(editingId) : '/api/notes', {
      method: editingId ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(attempt.payload)
    });
    if (!isCurrentEditorOperation(operationId, generation)) return;
    const saved = /** @type {RawNote | undefined} */ (data.note);
    if (!saved || saved.id !== (editingId || createId) || !Number.isSafeInteger(saved.revision) ||
      !Number.isSafeInteger(saved.created_at) || !Number.isSafeInteger(saved.updated_at)) {
      throw new Error('保存响应不完整，当前输入已保留，请重试确认');
    }
    upsertLocalNote({ ...saved, title: title, content: content, encrypted: true, decryptFailed: false });
    closeComposer(true);
    setStatus('已保存');
  } catch (error) {
    if (!isCurrentEditorOperation(operationId, generation)) return;
    els.editorStatus.textContent = error instanceof Error ? error.message : '保存失败，当前输入已保留';
    throw error;
  } finally {
    if (isCurrentEditorOperation(operationId, generation)) setEditorSaving(false);
  }
}

/** @param {string} id */
async function deleteNote(id) {
  if (!state.vaultUnlocked || !state.listReady || state.notesLoading || state.deletingIds.has(id)) return;
  const currentNote = state.allNotes.find(function (note) { return note.id === id; });
  if (!currentNote || currentNote.decryptFailed) return;
  if (!confirm('确定删除这条笔记吗？')) return;
  const generation = authGeneration;
  state.deletingIds.add(id);
  try {
    await api('/api/notes/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'if-match': String(currentNote.revision) }
    });
    if (generation !== authGeneration) return;
    state.refreshOperationId += 1;
    state.allNotes = state.allNotes.filter(function (note) { return note.id !== id; });
    refreshLocalMetadata();
    applySearch();
    setStatus('已删除');
  } finally {
    if (generation === authGeneration) state.deletingIds.delete(id);
  }
}

/** @param {Note} note */
function openShareDialog(note) {
  if (note.decryptFailed) {
    setStatus('无法分享未成功解密的笔记');
    return;
  }
  if (state.shareCreating) {
    setStatus('上一条分享链接仍在创建，请稍候');
    return;
  }
  const activeElement = document.activeElement;
  state.shareReturnFocus = activeElement instanceof HTMLElement ? activeElement : null;
  state.shareOperationId += 1;
  state.sharingNoteId = note.id;
  els.shareNoteLabel.textContent = '分享“' + (note.title || '无标题') + '”，原笔记不受影响';
  els.shareExpiry.value = '86400';
  els.shareSetup.classList.remove('hidden');
  els.shareResult.classList.add('hidden');
  els.shareLinkInput.value = '';
  els.shareExpiryLabel.textContent = '';
  els.shareQr.textContent = '';
  els.shareQrPanel.classList.add('hidden');
  els.createShareBtn.classList.remove('hidden');
  els.createShareBtn.disabled = false;
  els.createShareBtn.textContent = '创建分享链接';
  els.cancelShareBtn.textContent = '取消';
  els.shareModal.classList.remove('hidden');
  els.shareModal.setAttribute('aria-hidden', 'false');
  updateModalUi();
  els.shareExpiry.focus();
}

/** @param {boolean} [force] */
function closeShareDialog(force) {
  if (state.shareCreating && !force) {
    setStatus('链接正在创建，请稍候');
    return;
  }
  const returnFocus = state.shareReturnFocus;
  state.shareOperationId += 1;
  setShareCreating(false);
  els.shareModal.classList.add('hidden');
  els.shareModal.setAttribute('aria-hidden', 'true');
  els.shareLinkInput.value = '';
  els.shareResult.classList.add('hidden');
  els.shareQr.textContent = '';
  els.shareQrPanel.classList.add('hidden');
  state.sharingNoteId = null;
  state.shareReturnFocus = null;
  updateModalUi();
  if (!force && returnFocus && returnFocus.isConnected) returnFocus.focus();
}

/** @param {boolean} creating */
function setShareCreating(creating) {
  state.shareCreating = creating;
  els.shareExpiry.disabled = creating;
  els.closeShareModalBtn.disabled = creating;
  els.cancelShareBtn.disabled = creating;
  els.createShareBtn.disabled = creating;
  els.createShareBtn.textContent = creating ? '加密并创建中…' : '创建分享链接';
  if (creating) {
    els.shareModal.setAttribute('aria-busy', 'true');
    els.shareModal.focus();
  } else {
    els.shareModal.removeAttribute('aria-busy');
  }
}

/** @param {number} operationId @param {string} noteId */
function isCurrentShareOperation(operationId, noteId) {
  return operationId === state.shareOperationId &&
    noteId === state.sharingNoteId &&
    !els.shareModal.classList.contains('hidden');
}

/**
 * A forced close is not exposed in the UI. One-time records created by an
 * invalidated request are consumed so they cannot remain as unreachable
 * orphans; reusable records remain available until their normal expiry.
 * @param {string} token
 * @param {string} proof
 */
async function discardStaleShare(token, proof) {
  try {
    await fetch('/api/shares/' + encodeURIComponent(token) + '/consume', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: proof })
    });
  } catch {
    // Best effort only: closing the page can still interrupt any browser request.
  }
}

async function createShareLink() {
  const note = state.allNotes.find(function (item) {
    return item.id === state.sharingNoteId;
  });
  if (!note || note.decryptFailed) throw new Error('找不到可分享的已解密笔记');

  const expiresInSeconds = Number(els.shareExpiry.value);
  if (![3600, 86400, 604800].includes(expiresInSeconds)) {
    throw new Error('请选择有效的链接期限');
  }
  const selectedOption = els.shareExpiry.options[els.shareExpiry.selectedIndex];
  const shareMode = selectedOption?.dataset.shareMode;
  if (shareMode !== 'one_time' && shareMode !== 'reusable') {
    throw new Error('请选择有效的分享方式');
  }

  const noteId = note.id;
  const generation = authGeneration;
  const operationId = ++state.shareOperationId;
  setShareCreating(true);
  try {
    const encrypted = await encryptShare(note);
    if (generation !== authGeneration || !isCurrentShareOperation(operationId, noteId)) return;
    const data = await api('/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ciphertext: encrypted.ciphertext,
        proof: encrypted.proof,
        expiresInSeconds: expiresInSeconds,
        shareMode: shareMode
      })
    });
    const token = String(data.token || '');
    const expiresAt = Number(data.expiresAt);
    if (!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token) || !Number.isSafeInteger(expiresAt)) {
      throw new Error('服务器返回的分享信息无效');
    }

    if (!isCurrentShareOperation(operationId, noteId)) {
      if (shareMode === 'one_time') await discardStaleShare(token, encrypted.proof);
      return;
    }

    const shareUrl = new URL('/share', window.location.origin);
    shareUrl.searchParams.set('t', token);
    shareUrl.hash = encrypted.keyFragment;
    const shareUrlText = shareUrl.toString();
    els.shareLinkInput.value = shareUrlText;
    let qrReady = true;
    try {
      els.shareQr.innerHTML = createQrSvg(shareUrlText);
      els.shareQrPanel.classList.remove('hidden');
    } catch {
      qrReady = false;
      els.shareQr.textContent = '';
      els.shareQrPanel.classList.add('hidden');
    }
    els.shareLinkLabel.textContent = shareMode === 'one_time' ? '一次性分享链接' : '定时分享链接';
    els.shareExpiryLabel.textContent = shareMode === 'one_time'
        ? '最晚有效至 ' + formatDate(expiresAt) + '；首次主动查看后立即失效。'
        : '有效至 ' + formatDate(expiresAt) + '；可在期限内重复查看。';
    els.shareSetup.classList.add('hidden');
    els.shareResult.classList.remove('hidden');
    els.createShareBtn.classList.add('hidden');
    els.cancelShareBtn.textContent = '完成';
    els.copyShareLinkBtn.focus();
    setStatus(qrReady
      ? (shareMode === 'one_time' ? '阅后即焚链接已创建' : '定时分享链接已创建')
      : '二维码生成失败，分享链接已创建，请复制链接');
  } catch (error) {
    if (!isCurrentShareOperation(operationId, noteId)) return;
    throw error;
  } finally {
    if (isCurrentShareOperation(operationId, noteId)) setShareCreating(false);
  }
}

async function copyShareLink() {
  const generation = authGeneration;
  const link = els.shareLinkInput.value;
  if (!link) throw new Error('请先创建分享链接');
  try {
    await navigator.clipboard.writeText(link);
    if (generation === authGeneration) setStatus('分享链接已复制');
  } catch {
    if (generation !== authGeneration) return;
    els.shareLinkInput.focus();
    els.shareLinkInput.select();
    setStatus('请手动复制已选中的链接');
  }
}

/**
 * @param {CryptoConfig} config
 */
async function verifyKeyCheck(config) {
  if (!config.keyCheck) return;
  try {
    const marker = await decryptValue(config.keyCheck);
    if (marker !== KEY_CHECK_MARKER) {
      throw new Error('marker mismatch');
    }
  } catch (error) {
    throw new VaultPasswordError('原笔记密码不正确，请重试');
  }
}

/**
 * Initializes the set-once key check only after a real login and successful
 * loading of existing notes.
 * @param {CryptoConfig} config
 */
async function initializeKeyCheck(config) {
  const generation = authGeneration;
  const key = state.vaultKey;
  const encryptedMarker = await encryptValue(KEY_CHECK_MARKER, key, config);
  if (generation !== authGeneration) throw new SessionChangedError();
  let data;
  try {
    data = await api('/api/crypto-config/key-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keyCheck: encryptedMarker })
    });
  } catch (error) {
    throw new Error('无法初始化密钥校验标记。请确认后端已升级，然后退出当前会话并重新登录');
  }

  if (generation !== authGeneration) throw new SessionChangedError();
  if (typeof data.keyCheck !== 'string' || !data.keyCheck) {
    throw new Error('服务器未返回有效的密钥校验标记');
  }
  config.keyCheck = data.keyCheck;
  await verifyKeyCheck(config);
}

/**
 * @param {string} passphrase
 */
async function unlockVault(passphrase) {
  const generation = authGeneration;
  const config = await getCryptoConfig();
  const key = await deriveVaultKey(passphrase, config);
  if (generation !== authGeneration) return;
  state.vaultKey = key;
  await verifyKeyCheck(config);
  if (generation !== authGeneration) return;
  state.vaultUnlocked = true;
  state.unlockError = '';
  // Older databases without a marker need one successful decrypt pass before
  // initialization. Keep the authenticated shell visible if that pass fails;
  // the retry button can repeat only the list load without another login.
  if (!config.keyCheck) {
    try {
      await refreshNotes();
      if (generation !== authGeneration) return;
      if (state.decryptFailedCount > 0) throw new VaultPasswordError('旧笔记需要原来的密码，请输入原密码');
      await initializeKeyCheck(config);
    } catch (error) {
      if (generation !== authGeneration) return;
      if (error instanceof VaultPasswordError) throw error;
      state.notesError = error instanceof Error ? error.message : '笔记加载失败，请重试';
    }
  }
}

/** @param {CryptoConfig} config */
function cryptoConfigId(config) {
  return JSON.stringify([config.version, config.vaultSalt, config.kdf, config.iterations, config.cipher, config.keyCheck]);
}

function forgetDevice() {
  try { deviceStore.clear(); } catch { /* The page can still be used without storage. */ }
  clearLegacyDeviceStore();
}

function rememberCurrentDevice() {
  storageMessage = '';
  try {
    if (!els.rememberDevice.checked) { deviceStore.clear(); deviceStore.forgetLegacy(); return; }
    if (!activeSession) return;
    deviceStore.save({token: activeSession.token, vaultId: activeSession.vaultId, expiresAt: activeSession.expiresAt});
    deviceStore.forgetLegacy();
  } catch {
    storageMessage = '当前浏览器不允许记住登录，本次仍可使用；关闭后需再次输入密码。';
  } finally {
    els.deviceStatus.textContent = storageMessage;
    els.deviceStatus.classList.toggle('hidden', !storageMessage);
  }
}

async function loadNotesAfterLogin() {
  const generation = authGeneration;
  try {
    await refreshNotes();
    if (generation !== authGeneration || !state.vaultUnlocked) return;
    // A legacy vault may have failed its first initialization because the
    // notes request was transiently unavailable. Retry the marker write after
    // the notes are successfully loaded, without asking for the password again.
    if (state.cryptoConfig && !state.cryptoConfig.keyCheck && state.decryptFailedCount === 0) {
      await initializeKeyCheck(state.cryptoConfig);
      if (generation !== authGeneration) return;
    }
  }
  catch (error) {
    if (generation !== authGeneration) return;
    state.notesError = error instanceof Error ? error.message : '笔记加载失败，请重试';
    updateLoadUi();
  }
}

async function checkSession() {
  if (state.restoreSubmitting) return;
  const generation = authGeneration;
  state.restoreSubmitting = true;
  showRestoring();
  try {
    let saved;
    try { saved = deviceStore.load(); }
    catch {
      showLogin();
      els.loginStatus.textContent = '无法读取本机登录记录，请输入密码继续';
      return;
    }
    if (!saved) { showLogin(); return; }
    // v3 deliberately stores no vault key. Restore the server session only;
    // the user must enter the vault password again to unlock local ciphertext.
    deviceStore.forgetLegacy();
    activeSession = saved;
    const data = await api('/api/session');
    if (generation !== authGeneration) return;
    if (!data.authenticated || !isLoginSession(data) || saved.vaultId !== data.vaultId) {
      forgetDevice(); resetLocalSession(); return;
    }
    activeSession = data;
    state.sessionAuthenticated = true;
    const config = await getCryptoConfig();
    if (generation !== authGeneration) return;
    state.cryptoConfig = config;
    state.authMode = 'recover';
    showLogin();
    els.loginStatus.textContent = '已恢复登录会话，请输入原笔记密码解锁';
    return;
  } catch (error) {
    if (generation !== authGeneration) return;
    state.vaultKey = null;
    state.vaultUnlocked = false;
    const message = error instanceof Error ? error.message : '暂时无法恢复笔记，请重试';
    if (error instanceof VaultPasswordError) {
      forgetDevice();
      state.authMode = 'recover';
      showLogin();
      els.loginStatus.textContent = message;
    } else {
      showRestoring(message);
    }
  } finally {
    if (generation === authGeneration) {
      state.restoreSubmitting = false;
      updateLoadUi();
    }
  }
}

els.loginForm.addEventListener('submit', async function (event) {
  event.preventDefault();
  if (state.loginSubmitting) return;
  const generation = ++authGeneration;
  state.loginSubmitting = true;
  updateLoginMode();
  try {
    const password = els.passwordInput.value;
    if (!password) throw new Error('请输入密码');
    els.loginStatus.textContent = '正在打开…';
    if (state.authMode !== 'recover') {
      const session = await loginWithToken(password, api);
      if (generation !== authGeneration) return;
      activeSession = session;
      state.sessionAuthenticated = true;
    }
    await unlockVault(password);
    if (generation !== authGeneration) return;
    rememberCurrentDevice();
    clearSensitiveInputs();
    state.authMode = 'login';
    showApp();
    els.loginStatus.textContent = '';
    await loadNotesAfterLogin();
  } catch (error) {
    if (generation !== authGeneration) return;
    state.vaultUnlocked = false;
    state.vaultKey = null;
    if (error instanceof VaultPasswordError && activeSession) {
      state.authMode = 'recover';
      clearSensitiveInputs();
    }
    showLogin();
    els.loginStatus.textContent = error instanceof Error ? error.message : '打开失败，请重试';
  } finally {
    if (generation === authGeneration) {
      state.loginSubmitting = false;
      updateLoginMode();
    }
  }
});

els.retryLoadBtn.onclick = function () {
  const task = state.authView === 'restoring' ? checkSession() : loadNotesAfterLogin();
  task.catch(function (error) { setStatus(error instanceof Error ? error.message : '加载失败，请重试'); });
};

els.loadMoreBtn.onclick = function () {
  state.visibleLimit += NOTE_RENDER_BATCH_SIZE;
  renderList();
};

els.searchBtn.onclick = function () {
  applySearch();
  setStatus('已在本地更新搜索结果');
};

els.searchInput.addEventListener('input', function () {
  updateSearchUi();
  scheduleSearch();
});

els.searchInput.addEventListener('compositionstart', function () {
  state.searchComposing = true;
  cancelSearch();
});

els.searchInput.addEventListener('compositionend', function () {
  state.searchComposing = false;
  scheduleSearch();
});

els.searchInput.addEventListener('keydown', function (event) {
  if (event.key === 'Enter' && !state.searchComposing && !event.isComposing) els.searchBtn.click();
});

els.clearSearchBtn.onclick = function () {
  els.searchInput.value = '';
  updateSearchUi();
  applySearch();
};

els.newBtn.onclick = function () {
  openComposer(null);
};

els.fabNewBtn.onclick = function () {
  openComposer(null);
};

els.fabTopBtn.onclick = function () {
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

async function logout() {
  // Cookie cleanup must not delay local locking, even when the device is offline.
  const request = api('/api/logout', { method: 'POST' }).catch(function () {});
  resetLocalSession();
  try { deviceStore.clear(); }
  catch { els.loginStatus.textContent = '未能清除设备记录，请清除此站点的浏览器数据。'; }
  try { deviceStore.notifyLogout(); }
  catch { els.loginStatus.textContent += ' 无法通知其他标签页，请一并关闭它们。'; }
  clearLegacyDeviceStore();
  await request;
}

function resetLocalSession() {
  authGeneration += 1;
  pendingRequests.forEach(function (controller) { controller.abort(); });
  pendingRequests.clear();
  cancelSearch();
  state.authMode = 'login';
  activeSession = null;
  els.deviceStatus.classList.add('hidden');
  closeComposer(true);
  closeShareDialog(true);
  state.notes = [];
  state.allNotes = [];
  state.searchIndex.clear();
  state.expandedIds.clear();
  state.deletingIds.clear();
  state.searchQuery = '';
  state.searchComposing = false;
  state.visibleLimit = NOTE_RENDER_BATCH_SIZE;
  state.refreshOperationId += 1;
  state.notesLoading = false;
  state.notesError = '';
  state.listReady = false;
  state.restoreSubmitting = false;
  state.restoreError = '';
  state.loginSubmitting = false;
  state.sessionAuthenticated = false;
  state.vaultUnlocked = false;
  state.vaultKey = null;
  state.cryptoConfig = null;
  state.noteCountMeta = 0;
  state.decryptFailedCount = 0;
  state.legacyPlaintextCount = 0;
  els.searchInput.value = '';
  els.shareNoteLabel.textContent = '';
  els.shareExpiryLabel.textContent = '';
  els.vaultPanelDesc.textContent = '';
  clearSensitiveInputs();
  state.unlockError = '';
  els.loginStatus.textContent = '';
  updateSearchUi();
  showLogin();
  renderList();
  setStatus('');
}

window.addEventListener('storage', function (event) {
  const deviceRemoved = (event.key === DEVICE_SESSION_KEY || event.key === null) && event.newValue === null;
  if (deviceRemoved || (event.key === LOGOUT_EVENT_KEY && event.newValue !== null)) resetLocalSession();
});

els.logoutBtn.onclick = function () {
  logout().catch(function (error) {
    setStatus(error instanceof Error ? error.message : '退出失败');
  });
};

els.loginLogoutBtn.onclick = function () {
  logout().catch(function (error) {
    els.loginStatus.textContent = error instanceof Error ? error.message : '退出失败';
  });
};

els.closeModalBtn.onclick = function () { closeComposer(); };
els.cancelBtn.onclick = function () { closeComposer(); };
els.saveBtn.onclick = function () {
  saveComposer().catch(function (error) {
    setStatus(error.message || '保存失败');
  });
};
els.closeShareModalBtn.onclick = function () {
  closeShareDialog();
};
els.cancelShareBtn.onclick = function () {
  closeShareDialog();
};
els.createShareBtn.onclick = function () {
  createShareLink().catch(function (error) {
    setStatus(error instanceof Error ? error.message : '创建分享链接失败');
  });
};
els.copyShareLinkBtn.onclick = function () {
  copyShareLink().catch(function (error) {
    setStatus(error instanceof Error ? error.message : '复制分享链接失败');
  });
};

document.addEventListener('keydown', function (event) {
  if (event.key === 'Tab' && !els.shareModal.classList.contains('hidden')) {
    const focusable = /** @type {HTMLElement[]} */ (Array.from(els.shareModal.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )).filter(function (element) {
      return element instanceof HTMLElement && element.getClientRects().length > 0;
    }));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;
    if (!first || !last) {
      event.preventDefault();
      els.shareModal.focus();
    } else if (!(activeElement instanceof HTMLElement) ||
      !els.shareModal.contains(activeElement) ||
      !focusable.includes(activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey ? activeElement === first : activeElement === last) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }
  if (event.key === 'Escape') {
    if (!els.shareModal.classList.contains('hidden')) {
      event.preventDefault();
      closeShareDialog();
    } else if (!els.editorModal.classList.contains('hidden')) {
      closeComposer();
    }
  }
  const isSave = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';
  if (isSave && !els.editorModal.classList.contains('hidden')) {
    event.preventDefault();
    saveComposer().catch(function (error) {
      setStatus(error.message || '保存失败');
    });
  }
});

window.addEventListener('scroll', updateScrollUi, { passive: true });

els.loginStatus.textContent = '';
checkSession().catch(function (error) {
  showRestoring(error instanceof Error ? error.message : '无法连接到服务，请重试');
});
