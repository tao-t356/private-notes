/**
 * @typedef {{ id: string, title: string, content: string, created_at: number, updated_at: number, revision: number }} RawNote
 * @typedef {RawNote & { encrypted: boolean, decryptFailed: boolean }} Note
 * @typedef {{ vaultSalt: string, cipher: 'aes-gcm-256', kdf: 'pbkdf2-sha256', iterations: number, version: 1, keyCheck: string | null }} CryptoConfig
 */

const KEY_CHECK_MARKER = 'private-notes-key-check:v1';

/** @type {{
 * notes: Note[],
 * allNotes: Note[],
 * editingId: string | null,
 * expandedIds: Set<string>,
 * statusTimer: number | null,
 * sessionAuthenticated: boolean,
 * authMode: 'checking' | 'login' | 'unlock',
 * vaultUnlocked: boolean,
 * vaultKey: CryptoKey | null,
 * cryptoConfig: CryptoConfig | null,
 * noteCountMeta: number,
 * decryptFailedCount: number,
 * legacyPlaintextCount: number,
 * unlockError: string
 * }} */
const state = {
  notes: [],
  allNotes: [],
  editingId: null,
  expandedIds: new Set(),
  statusTimer: null,
  sessionAuthenticated: false,
  authMode: 'checking',
  vaultUnlocked: false,
  vaultKey: null,
  cryptoConfig: null,
  noteCountMeta: 0,
  decryptFailedCount: 0,
  legacyPlaintextCount: 0,
  unlockError: ''
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

/** @param {string} id @returns {HTMLButtonElement} */
function getButton(id) {
  const element = getElement(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error('页面元素类型错误：' + id);
  return element;
}

const els = {
  loginView: getElement('loginView'),
  appView: getElement('appView'),
  unlockBadge: getElement('unlockBadge'),
  loginTitle: getElement('loginTitle'),
  loginDesc: getElement('loginDesc'),
  passwordInput: getInput('passwordInput'),
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
  vaultUnlockInput: getInput('vaultUnlockInput'),
  unlockBtn: getButton('unlockBtn'),
  noteCount: getElement('noteCount'),
  noteList: getElement('noteList'),
  editorModal: getElement('editorModal'),
  modalTitle: getElement('modalTitle'),
  editorTitle: getInput('editorTitle'),
  editorContent: getTextArea('editorContent'),
  closeModalBtn: getButton('closeModalBtn'),
  cancelBtn: getButton('cancelBtn'),
  saveBtn: getButton('saveBtn')
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
  const open = !els.editorModal.classList.contains('hidden');
  [els.topbar, els.fabNewBtn, els.fabTopBtn].forEach(function (element) {
    element.classList.toggle('modal-obscured', open);
  });
}

function updateLoginMode() {
  const checking = state.authMode === 'checking';
  const unlockOnly = state.authMode === 'unlock' || (state.sessionAuthenticated && !state.vaultUnlocked);
  els.unlockBadge.classList.toggle('hidden', !unlockOnly);
  els.loginLogoutBtn.classList.toggle('hidden', !unlockOnly);
  els.passwordInput.disabled = checking;
  els.loginBtn.disabled = checking;
  if (checking) {
    els.loginTitle.textContent = '正在打开我的笔记';
    els.loginDesc.textContent = '正在检查当前设备的访问状态，页面会保持在原位。';
    els.passwordInput.placeholder = '请稍候…';
    els.passwordHelp.textContent = '刷新时不再切换页面，只会显示这层锁屏。';
    els.loginBtn.textContent = '请稍候…';
    return;
  }
  els.loginTitle.textContent = unlockOnly ? '解锁我的笔记' : '登录到我的笔记';
  els.loginDesc.textContent = unlockOnly
    ? '你已经通过访问验证。现在输入密码解锁本地加密内容；刷新后不会再出现页面跳转。'
    : '输入密码后即可进入应用，并在本地解锁你的加密笔记。';
  els.passwordInput.placeholder = unlockOnly ? '输入解锁密码' : '输入访问密码';
  els.passwordHelp.textContent = unlockOnly
    ? '密码只在本次页面会话中用于派生解密密钥，不再明文保存到 localStorage。'
    : '同一个密码同时用于访问站点和本地解密。';
  els.loginBtn.textContent = unlockOnly ? '解锁我的笔记' : '进入笔记';
}

function updateVaultUi() {
  els.vaultPanel.classList.add('hidden');
  els.searchInput.disabled = !state.vaultUnlocked;
  els.searchBtn.disabled = !state.vaultUnlocked;
  els.clearSearchBtn.disabled = !state.vaultUnlocked;
  els.newBtn.disabled = !state.vaultUnlocked;
  els.fabNewBtn.disabled = !state.vaultUnlocked;
  els.vaultPanelDesc.textContent = state.unlockError
    ? state.unlockError + '。如果你已经忘记密码，旧密文无法在页面内恢复。'
    : state.noteCountMeta > 0
      ? '你当前有 ' + state.noteCountMeta + ' 条已加密笔记。请输入密码查看内容；忘记密码将无法在页面内恢复旧密文。'
      : '当前还没有可显示的解密内容。输入密码后可正常使用。';
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
  els.vaultUnlockInput.value = '';
}

/**
 * Fetches and validates the server-owned encryption parameters. Unsupported
 * versions fail visibly instead of silently writing incompatible ciphertext.
 * @returns {Promise<CryptoConfig>}
 */
async function getCryptoConfig() {
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

  state.cryptoConfig = /** @type {CryptoConfig} */ (config);
  return state.cryptoConfig;
}

async function refreshMeta() {
  const data = await api('/api/health');
  state.noteCountMeta = data.noteCount || 0;
  updateVaultUi();
}

/**
 * @param {string} passphrase
 * @param {CryptoConfig} config
 */
async function deriveVaultKey(passphrase, config) {
  const salt = base64ToBytes(config.vaultSalt);
  const kdfName = config.kdf === 'pbkdf2-sha256' ? 'PBKDF2' : config.kdf;
  const kdfHash = config.kdf === 'pbkdf2-sha256' ? 'SHA-256' : config.kdf;
  const cipherName = config.cipher === 'aes-gcm-256' ? 'AES-GCM' : config.cipher;
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    kdfName,
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: kdfName,
      salt: salt,
      iterations: config.iterations,
      hash: kdfHash
    },
    keyMaterial,
    { name: cipherName, length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * @param {unknown} value
 */
function isEncryptedValue(value) {
  return typeof value === 'string' && value.startsWith('enc:v1:');
}

/**
 * @param {string} value
 */
async function encryptValue(value) {
  if (!state.cryptoConfig || !state.vaultKey) {
    throw new Error('加密配置尚未就绪');
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherName = state.cryptoConfig.cipher === 'aes-gcm-256'
    ? 'AES-GCM'
    : state.cryptoConfig.cipher;
  const cipher = await crypto.subtle.encrypt(
    { name: cipherName, iv: iv },
    state.vaultKey,
    new TextEncoder().encode(value || '')
  );

  return 'enc:v' + state.cryptoConfig.version + ':' + btoa(JSON.stringify({
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(cipher))
  }));
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
  let legacyPlaintextCount = 0;

  for (const note of rawNotes) {
    try {
      const encrypted = isEncryptedValue(note.title) && isEncryptedValue(note.content);
      if (!encrypted) legacyPlaintextCount += 1;
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

  state.decryptFailedCount = failedCount;
  state.legacyPlaintextCount = legacyPlaintextCount;
  if (rawNotes.length > 0 && failedCount === rawNotes.length) {
    throw new Error('本地解锁密钥不正确');
  }
  return decrypted;
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
    return (note.title || '').toLocaleLowerCase('zh-CN').includes(q)
      || (note.content || '').toLocaleLowerCase('zh-CN').includes(q);
  });
}

function applySearch() {
  state.notes = filterNotes(state.allNotes, els.searchInput.value);
  state.expandedIds.forEach(function (id) {
    if (!state.notes.find(function (note) { return note.id === id; })) {
      state.expandedIds.delete(id);
    }
  });
  renderList();
}

function showLogin() {
  state.authMode = state.sessionAuthenticated ? 'unlock' : 'login';
  els.loginView.classList.remove('hidden');
  els.appView.classList.add('app-dimmed');
  updateLoginMode();
}

function showChecking() {
  state.authMode = 'checking';
  els.loginStatus.textContent = '';
  els.loginView.classList.remove('hidden');
  els.appView.classList.add('app-dimmed');
  updateLoginMode();
}

function showApp() {
  if (state.sessionAuthenticated && state.vaultUnlocked) {
    els.loginView.classList.add('hidden');
    els.appView.classList.remove('app-dimmed');
  } else {
    showLogin();
  }
  updateVaultUi();
}

/** @param {number} ts */
function formatDate(ts) {
  if (!ts) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(ts));
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
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
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
  const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, options || {}));
  const data = await res.json().catch(function () { return {}; });
  if (res.status === 401) {
    state.sessionAuthenticated = false;
    state.vaultUnlocked = false;
    state.vaultKey = null;
    showLogin();
    throw new Error('请先登录');
  }
  if (!res.ok) {
    if (res.status === 409 && data.error === 'revision_conflict') {
      throw new Error('这条笔记已在其他页面更新，请刷新后再编辑');
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
  els.noteCount.textContent = state.notes.length ? ('共 ' + state.notes.length + ' 条') : '0 条';
  if (state.decryptFailedCount > 0) {
    els.noteCount.textContent += ' · ' + state.decryptFailedCount + ' 条无法解密';
  }
  if (state.legacyPlaintextCount > 0) {
    els.noteCount.textContent += ' · ' + state.legacyPlaintextCount + ' 条待加密';
  }

  if (!state.vaultUnlocked) {
    els.noteCount.textContent = state.noteCountMeta ? ('共 ' + state.noteCountMeta + ' 条（已加密）') : '0 条';
    els.noteList.innerHTML = '<div class="empty-feed">正文已加密。登录站点后，再输入本地解锁密钥才能看到内容和搜索结果。</div>';
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

  /** @type {Map<string, Note[]>} */
  const groups = new Map();
  state.notes.forEach(function (note) {
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
        try {
          await navigator.clipboard.writeText(note.content || '');
          setStatus('已复制：' + (note.title || '无标题'));
        } catch (error) {
          setStatus('复制失败，请手动选择文本复制');
        }
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
          renderList();
        };
        card.appendChild(toggleBtn);
      }

      group.appendChild(card);
    });

    els.noteList.appendChild(group);
  });
}

async function refreshNotes() {
  if (!state.vaultUnlocked) {
    state.notes = [];
    state.allNotes = [];
    state.decryptFailedCount = 0;
    state.legacyPlaintextCount = 0;
    await refreshMeta();
    renderList();
    return;
  }

  state.allNotes = await decryptNotes(await fetchRawNotes());
  state.noteCountMeta = state.allNotes.length;
  updateVaultUi();
  applySearch();
}

/** @param {Note | null} note */
function openComposer(note) {
  state.editingId = note ? note.id : null;
  els.modalTitle.textContent = note ? '编辑笔记' : '新建笔记';
  els.editorTitle.value = note ? note.title : '';
  els.editorContent.value = note ? note.content : '';
  els.editorModal.classList.remove('hidden');
  updateModalUi();
  els.editorTitle.focus();
}

function closeComposer() {
  els.editorModal.classList.add('hidden');
  state.editingId = null;
  updateModalUi();
}

async function saveComposer() {
  const title = els.editorTitle.value.trim() || '无标题';
  const content = els.editorContent.value.trim();
  if (!title && !content) {
    setStatus('标题和内容至少写一个');
    return;
  }
  if (!state.vaultUnlocked || !state.vaultKey) {
    setStatus('请先输入本地解锁密钥');
    return;
  }

  setStatus('保存中…');

  const encryptedTitle = await encryptValue(title);
  const encryptedContent = await encryptValue(content);

  let data;
  if (state.editingId) {
    const currentNote = state.allNotes.find(function (note) {
      return note.id === state.editingId;
    });
    if (!currentNote) {
      throw new Error('找不到待编辑的笔记，请刷新后重试');
    }
    data = await api('/api/notes/' + encodeURIComponent(state.editingId), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: encryptedTitle,
        content: encryptedContent,
        revision: currentNote.revision
      })
    });
  } else {
    data = await api('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: encryptedTitle, content: encryptedContent })
    });
  }

  closeComposer();
  await refreshNotes();
  setStatus('已保存');
}

/** @param {string} id */
async function deleteNote(id) {
  if (!id) {
    setStatus('当前没有可删除的记录');
    return;
  }
  if (!confirm('确定删除这条笔记吗？')) return;

  const currentNote = state.allNotes.find(function (note) {
    return note.id === id;
  });
  if (!currentNote) throw new Error('找不到待删除的笔记，请刷新后重试');

  await api('/api/notes/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: { 'if-match': String(currentNote.revision) }
  });

  await refreshNotes();
  setStatus('已删除');
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
    throw new Error('当前密码无法通过密钥校验');
  }
}

/**
 * Initializes the set-once key check only after a real login and successful
 * loading of existing notes.
 * @param {CryptoConfig} config
 */
async function initializeKeyCheck(config) {
  const encryptedMarker = await encryptValue(KEY_CHECK_MARKER);
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

  if (typeof data.keyCheck !== 'string' || !data.keyCheck) {
    throw new Error('服务器未返回有效的密钥校验标记');
  }
  config.keyCheck = data.keyCheck;
  await verifyKeyCheck(config);
}

/**
 * @param {string} passphrase
 * @param {boolean} allowKeyCheckInit
 */
async function unlockVault(passphrase, allowKeyCheckInit) {
  if (!passphrase) {
    throw new Error('请输入密码');
  }

  const config = await getCryptoConfig();
  if (!config.keyCheck && !allowKeyCheckInit) {
    throw new Error('当前会话尚未建立密钥校验标记。请退出当前会话后重新登录');
  }

  state.vaultKey = await deriveVaultKey(passphrase, config);
  try {
    await verifyKeyCheck(config);
    state.vaultUnlocked = true;
    state.unlockError = '';
    await refreshNotes();

    if (!config.keyCheck) {
      if (state.decryptFailedCount > 0) {
        throw new Error('旧笔记未能全部解密，已停止初始化密钥校验标记');
      }
      await initializeKeyCheck(config);
    }
  } catch (error) {
    state.vaultUnlocked = false;
    state.vaultKey = null;
    throw error;
  }
}

async function checkSession() {
  showChecking();
  const data = await api('/api/session');
  if (data.authenticated) {
    state.sessionAuthenticated = true;
    state.vaultUnlocked = false;
    state.vaultKey = null;
    state.unlockError = '';
    await refreshMeta();
    state.authMode = 'unlock';
    showLogin();
    renderList();
  } else {
    state.sessionAuthenticated = false;
    state.vaultUnlocked = false;
    state.vaultKey = null;
    state.unlockError = '';
    showLogin();
    renderList();
  }
}

els.loginBtn.onclick = async function () {
  try {
    const unlockOnly = state.sessionAuthenticated && !state.vaultUnlocked;
    let performedLogin = false;
    els.loginStatus.textContent = unlockOnly ? '解锁中…' : '登录中…';
    const password = els.passwordInput.value;
    if (!password) throw new Error('请输入密码');
    if (!unlockOnly) {
      await api('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: password })
      });
      performedLogin = true;
    }
    state.sessionAuthenticated = true;
    await unlockVault(password, performedLogin);
    clearSensitiveInputs();
    showApp();
    setStatus(unlockOnly ? '已解锁' : '已登录并解锁');

    els.loginStatus.textContent = '';
  } catch (error) {
    state.vaultUnlocked = false;
    state.vaultKey = null;
    const message = error instanceof Error ? error.message : '登录失败';
    if (state.sessionAuthenticated) {
      state.unlockError = message;
      await refreshMeta();
      showLogin();
    } else {
      showLogin();
    }
    els.loginStatus.textContent = message;
  }
};

[els.passwordInput].forEach(function (input) {
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') els.loginBtn.click();
  });
});

els.vaultUnlockInput.addEventListener('keydown', function (event) {
  if (event.key === 'Enter') els.unlockBtn.click();
});

els.searchBtn.onclick = function () {
  applySearch();
  setStatus('已在本地更新搜索结果');
};

els.searchInput.addEventListener('input', function () {
  updateSearchUi();
  applySearch();
});

els.searchInput.addEventListener('keydown', function (event) {
  if (event.key === 'Enter') els.searchBtn.click();
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

els.unlockBtn.onclick = function () {
  unlockVault(els.vaultUnlockInput.value, false)
    .then(function () {
      els.vaultUnlockInput.value = '';
      setStatus('已解锁本地密文');
    })
    .catch(function (error) {
      state.vaultUnlocked = false;
      state.vaultKey = null;
      state.unlockError = '当前密码无法解锁现有加密笔记';
      updateVaultUi();
      setStatus(error.message || '解锁失败');
    });
};

els.fabTopBtn.onclick = function () {
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

async function logout() {
  await api('/api/logout', { method: 'POST' });
  state.notes = [];
  state.allNotes = [];
  state.sessionAuthenticated = false;
  state.vaultUnlocked = false;
  state.vaultKey = null;
  state.cryptoConfig = null;
  state.noteCountMeta = 0;
  state.decryptFailedCount = 0;
  state.legacyPlaintextCount = 0;
  clearSensitiveInputs();
  state.unlockError = '';
  els.loginStatus.textContent = '';
  showLogin();
  renderList();
  setStatus('');
}

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

els.closeModalBtn.onclick = closeComposer;
els.cancelBtn.onclick = closeComposer;
els.saveBtn.onclick = function () {
  saveComposer().catch(function (error) {
    setStatus(error.message || '保存失败');
  });
};

document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && !els.editorModal.classList.contains('hidden')) {
    closeComposer();
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

updateSearchUi();
updateScrollUi();
updateModalUi();
checkSession().catch(function (error) {
  showLogin();
  els.loginStatus.textContent = error instanceof Error ? error.message : '无法连接到服务';
});
