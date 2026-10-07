import { createShareProof, decryptSharedPayload, parseShareKeyFragment } from './share-crypto.js';

/**
 * @typedef {{ token: string, keyBytes: Uint8Array, shareMode: 'one_time' | 'reusable' | null }} ShareLinkData
 * @typedef {{ v: 1, title: string, content: string, createdAt: number, sharedAt: number }} SharedNotePayload
 */

/** @param {string} id @returns {HTMLElement} */
function getElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error('页面缺少必要元素：' + id);
  return element;
}

/** @param {string} id @returns {HTMLButtonElement} */
function getButton(id) {
  const element = getElement(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error('页面元素类型错误：' + id);
  return element;
}

const els = {
  intro: getElement('shareIntro'),
  consumeBtn: getButton('consumeShareBtn'),
  status: getElement('shareStatus'),
  note: getElement('sharedNote'),
  meta: getElement('sharedMeta'),
  title: getElement('sharedTitle'),
  content: getElement('sharedContent'),
  clearBtn: getButton('clearSharedNoteBtn')
};

/** @type {ShareLinkData | null} */
let linkData = null;

/** @param {string} message @param {boolean} [isError] */
function setStatus(message, isError) {
  els.status.textContent = message;
  els.status.classList.toggle('is-error', Boolean(isError));
}

function parseShareLink() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('t') || '';
  const fragment = url.hash.slice(1);
  window.history.replaceState(null, '', url.pathname);
  if (!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token) || !fragment.startsWith('v1.')) {
    throw new Error('分享链接不完整或格式无效');
  }
  const keyBytes = parseShareKeyFragment(fragment);
  return { token: token, keyBytes: keyBytes, shareMode: null };
}

/** @param {unknown} value @returns {SharedNotePayload} */
function validatePayload(value) {
  if (!value || typeof value !== 'object') throw new Error('分享内容格式无效');
  const payload = /** @type {Record<string, unknown>} */ (value);
  if (
    payload.v !== 1 ||
    typeof payload.title !== 'string' ||
    typeof payload.content !== 'string' ||
    !Number.isSafeInteger(payload.createdAt) ||
    !Number.isSafeInteger(payload.sharedAt)
  ) {
    throw new Error('分享内容格式无效');
  }
  return /** @type {SharedNotePayload} */ (payload);
}

/** @param {number} timestamp */
function formatDate(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function clearPageContent() {
  els.title.textContent = '';
  els.content.textContent = '';
  els.meta.textContent = '';
  els.note.classList.add('hidden');
  if (linkData) linkData.keyBytes.fill(0);
  linkData = null;
}

function clearDisplayedNote() {
  els.title.textContent = '';
  els.content.textContent = '';
  els.meta.textContent = '';
  els.note.classList.add('hidden');
}

async function consumeShare() {
  if (!linkData) throw new Error('分享链接缺少解密密钥');
  els.consumeBtn.disabled = true;
  setStatus(linkData.shareMode === 'one_time' ? '正在查看并使一次性链接失效…' : '正在加载分享内容…');
  const proof = await createShareProof(linkData.keyBytes);
  const response = await fetch('/api/shares/' + encodeURIComponent(linkData.token) + '/consume', {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proof: proof })
  });
  const data = await response.json().catch(function () { return {}; });
  if (!response.ok) {
    if (response.status === 410 && data.code === 'share_unavailable') {
      const wasReusable = linkData?.shareMode === 'reusable';
      clearPageContent();
      els.consumeBtn.disabled = true;
      throw new Error(wasReusable
        ? '这条定时分享已过期或链接不完整'
        : '这条分享已被查看、已过期或链接不完整');
    }
    throw new Error('暂时无法领取分享内容');
  }

  try {
    const payload = validatePayload(await decryptSharedPayload(data.ciphertext, linkData.keyBytes));
    const shareMode = data.shareMode === 'reusable' ? 'reusable' : 'one_time';
    linkData.shareMode = shareMode;
    if (shareMode === 'one_time') {
      linkData.keyBytes.fill(0);
      linkData = null;
    } else {
      els.consumeBtn.disabled = false;
      els.consumeBtn.textContent = '再次查看';
    }
    els.meta.textContent = shareMode === 'one_time'
      ? '原笔记创建于 ' + formatDate(payload.createdAt) + ' · 查看后立即失效'
      : '原笔记创建于 ' + formatDate(payload.createdAt) + ' · 期限内可重复查看';
    els.title.textContent = payload.title || '无标题';
    els.content.textContent = payload.content || '这条笔记没有正文。';
    if (shareMode === 'one_time') {
      els.intro.classList.add('hidden');
    } else {
      els.intro.classList.remove('hidden');
    }
    els.note.classList.remove('hidden');
    setStatus(shareMode === 'one_time' ? '已查看；一次性链接已失效。' : '已查看；链接在有效期内仍可再次查看。');
  } catch (error) {
    if (data.shareMode === 'reusable' && linkData) {
      clearDisplayedNote();
      els.consumeBtn.disabled = false;
    } else {
      clearPageContent();
    }
    throw new Error(data.shareMode === 'reusable'
      ? '分享记录仍可使用，但当前链接无法解密这条内容'
      : '分享记录已处理，但当前链接无法解密这条内容');
  }
}

els.consumeBtn.onclick = function () {
  consumeShare().catch(function (error) {
    if (linkData) els.consumeBtn.disabled = false;
    setStatus(error instanceof Error ? error.message : '无法查看分享内容', true);
  });
};

els.clearBtn.onclick = function () {
  if (linkData?.shareMode === 'reusable') {
    clearDisplayedNote();
    setStatus('当前页面中的明文已清除，可再次查看。');
  } else {
    clearPageContent();
    setStatus('当前页面中的明文已清除。');
  }
};

window.addEventListener('pagehide', clearPageContent);

try {
  linkData = parseShareLink();
  els.consumeBtn.disabled = false;
  setStatus('链接有效。点击“查看分享内容”后加载明文。');
} catch (error) {
  els.consumeBtn.disabled = true;
  setStatus(error instanceof Error ? error.message : '分享链接无效', true);
}
