import { blogHomeHtml } from './homeHtml';

type AppEnv = Env & {
	APP_PASSWORD?: string;
	COOKIE_SECRET?: string;
};

type Note = {
	id: string;
	title: string;
	content: string;
	created_at: number;
	updated_at: number;
};

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...extraHeaders,
		},
	});
}

function html(content: string) {
	return new Response(content, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
		},
	});
}

function getCookie(request: Request, name: string) {
	const cookie = request.headers.get('cookie') || '';
	const parts = cookie.split(';').map((item) => item.trim());
	const prefix = name + '=';
	for (const part of parts) {
		if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
	}
	return '';
}

async function sha256Hex(input: string) {
	const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function getSessionToken(env: AppEnv) {
	if (!env.APP_PASSWORD || !env.COOKIE_SECRET) return '';
	return sha256Hex(env.APP_PASSWORD + '|' + env.COOKIE_SECRET);
}

async function isAuthed(request: Request, env: AppEnv) {
	if (!env.APP_PASSWORD || !env.COOKIE_SECRET) return true;
	const session = getCookie(request, 'session');
	if (!session) return false;
	return session === (await getSessionToken(env));
}

function unauthorized() {
	return json({ ok: false, error: 'unauthorized' }, 401);
}

async function listNotes(env: AppEnv) {
	const result = await env.DB.prepare(
		`SELECT id, title, content, created_at, updated_at
		 FROM notes
		 ORDER BY updated_at DESC
		 LIMIT 1000`
	).all<Note>();

	return result.results ?? [];
}

async function getNote(env: AppEnv, id: string) {
	return env.DB.prepare(
		`SELECT id, title, content, created_at, updated_at
		 FROM notes
		 WHERE id = ?
		 LIMIT 1`
	)
		.bind(id)
		.first<Note>();
}

async function ensureAppMetaTable(env: AppEnv) {
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS app_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`
	).run();
}

async function getMeta(env: AppEnv, key: string) {
	const row = await env.DB.prepare(
		`SELECT value FROM app_meta WHERE key = ? LIMIT 1`
	)
		.bind(key)
		.first<{ value: string }>();

	return row?.value ?? null;
}

async function setMeta(env: AppEnv, key: string, value: string) {
	await env.DB.prepare(
		`INSERT INTO app_meta (key, value)
		 VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
	)
		.bind(key, value)
		.run();
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

async function getOrCreateVaultSalt(env: AppEnv) {
	await ensureAppMetaTable(env);
	const existing = await getMeta(env, 'vault_salt');
	if (existing) return existing;

	const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
	await setMeta(env, 'vault_salt', salt);
	return salt;
}

const appIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="8" y="6" width="48" height="52" rx="10" fill="#07c160"/>
  <path d="M20 22h24M20 32h24M20 42h16" stroke="white" stroke-width="5" stroke-linecap="round"/>
</svg>`;

const manifestJson = JSON.stringify({
	name: '我的笔记',
	short_name: '笔记',
	description: '一个部署在 Cloudflare Workers 上的简洁私人笔记。',
	start_url: '/',
	scope: '/',
	display: 'standalone',
	background_color: '#f5f5f5',
	theme_color: '#07c160',
	icons: [
		{
			src: '/app-icon.svg',
			sizes: 'any',
			type: 'image/svg+xml',
			purpose: 'any maskable',
		},
	],
});

const serviceWorkerJs = `const CACHE_NAME = 'private-notes-shell-v1';
const APP_SHELL = ['/', '/manifest.webmanifest', '/app-icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || response.status !== 200) return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});`;

const homeHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Private Notes</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #09111f;
        --panel: rgba(15, 23, 42, 0.78);
        --border: rgba(148, 163, 184, 0.18);
        --text: #e5eefb;
        --muted: #8aa0c2;
        --accent: #7c93ff;
        --accent-2: #a78bfa;
        --danger: #ef4444;
        --shadow: 0 28px 80px rgba(0, 0, 0, 0.35);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--text);
        font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(124, 147, 255, 0.24), transparent 28%),
          radial-gradient(circle at top right, rgba(167, 139, 250, 0.18), transparent 24%),
          linear-gradient(180deg, #0b1220 0%, #09111f 46%, #050b16 100%);
      }
      input, textarea, button { font: inherit; }
      .hidden { display: none !important; }
      .page { max-width: 1480px; margin: 0 auto; padding: 24px; }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 24px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }
      .login { max-width: 480px; margin: 10vh auto 0; padding: 28px; }
      .eyebrow {
        display: inline-flex;
        padding: 6px 10px;
        border-radius: 999px;
        color: #c7d5f6;
        background: rgba(124, 147, 255, 0.14);
        border: 1px solid rgba(124, 147, 255, 0.2);
        margin-bottom: 14px;
      }
      .login-title { margin: 0 0 8px; font-size: 34px; line-height: 1.1; }
      .muted { color: var(--muted); font-size: 13px; }
      .login-desc { margin: 0 0 18px; color: var(--muted); font-size: 15px; }
      .toolbar {
        display: flex;
        gap: 12px;
        align-items: center;
        margin-bottom: 18px;
        flex-wrap: wrap;
      }
      .toolbar-spacer { flex: 1; }
      .layout {
        display: grid;
        grid-template-columns: 320px minmax(420px, 1fr) 320px;
        gap: 16px;
      }
      .sidebar, .editor, .preview {
        min-height: 76vh;
        padding: 18px;
      }
      .panel-title { margin: 0; font-size: 22px; font-weight: 700; }
      .panel-subtitle { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
      .stats {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
        margin: 16px 0;
      }
      .stat {
        padding: 14px;
        border-radius: 18px;
        border: 1px solid rgba(255,255,255,0.06);
        background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04));
      }
      .stat-label { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
      .stat-value { font-size: 24px; font-weight: 700; }
      input, textarea {
        width: 100%;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(9, 17, 31, 0.76);
        color: inherit;
        padding: 12px 14px;
        outline: none;
      }
      input:focus, textarea:focus {
        border-color: rgba(124, 147, 255, 0.72);
        box-shadow: 0 0 0 4px rgba(124, 147, 255, 0.16);
      }
      .title-input {
        font-size: 28px;
        font-weight: 700;
        background: transparent;
        border: 0;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        border-radius: 0;
        padding: 2px 0 14px;
        margin-bottom: 14px;
      }
      .title-input::placeholder { color: rgba(229, 238, 251, 0.38); }
      textarea {
        min-height: 52vh;
        resize: vertical;
      }
      button {
        border: 0;
        border-radius: 14px;
        padding: 10px 16px;
        cursor: pointer;
        color: white;
        background: linear-gradient(135deg, var(--accent), var(--accent-2));
        box-shadow: 0 12px 30px rgba(124, 147, 255, 0.22);
      }
      button.secondary { background: rgba(255,255,255,0.08); box-shadow: none; }
      button.danger {
        background: rgba(239, 68, 68, 0.16);
        color: #fecaca;
        box-shadow: none;
      }
      .search-row, .editor-actions, .editor-footer {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .row {
        display: flex;
        gap: 10px;
        align-items: center;
        margin-bottom: 12px;
      }
      .row.grow > * { flex: 1; }
      .note-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-top: 12px;
      }
      .note-item {
        width: 100%;
        text-align: left;
        padding: 14px;
        background: rgba(255,255,255,0.05);
        border: 1px solid transparent;
        border-radius: 18px;
        color: inherit;
      }
      .note-item.active {
        border-color: rgba(124, 147, 255, 0.6);
        background: linear-gradient(180deg, rgba(124, 147, 255, 0.2), rgba(124, 147, 255, 0.08));
      }
      .note-meta {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
        color: var(--muted);
        font-size: 12px;
      }
      .note-title {
        font-weight: 700;
        margin-bottom: 6px;
      }
      .note-preview {
        color: #cad7ee;
        font-size: 13px;
        line-height: 1.45;
      }
      .preview-box, .preview-meta-card {
        padding: 16px;
        border-radius: 20px;
        border: 1px solid rgba(255,255,255,0.06);
        background: rgba(255,255,255,0.04);
      }
      .preview-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
        margin: 12px 0;
      }
      .preview-body {
        min-height: 360px;
        line-height: 1.7;
        overflow: auto;
      }
      .preview-body h1, .preview-body h2, .preview-body h3 { margin: 0 0 10px; }
      .preview-body p, .preview-body ul { margin: 0 0 12px; }
      .preview-body ul { padding-left: 20px; }
      .preview-body code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        background: rgba(255,255,255,0.08);
        padding: 2px 6px;
        border-radius: 8px;
      }
      .empty-state {
        padding: 24px 18px;
        border-radius: 18px;
        border: 1px dashed rgba(148, 163, 184, 0.22);
        color: var(--muted);
        text-align: center;
      }
      #status { min-height: 20px; }
      @media (max-width: 1280px) {
        .layout { grid-template-columns: 320px 1fr; }
        .preview { grid-column: span 2; min-height: auto; }
      }
      @media (max-width: 900px) {
        .layout { grid-template-columns: 1fr; }
        .preview { grid-column: span 1; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <section id="loginView" class="card login hidden">
        <div class="eyebrow">Private Notes · D1 only</div>
        <h1 class="login-title">像真正的笔记软件，而不是测试页。</h1>
        <p class="login-desc">左边像时间流，中间专心编辑，右边即时预览。适合每天记想法、清单、摘录和日志。</p>
        <div class="row grow">
          <input id="passwordInput" type="password" placeholder="输入登录密码" />
        </div>
        <div class="row">
          <button id="loginBtn">登录</button>
        </div>
        <div id="loginStatus" class="muted"></div>
      </section>

      <section id="appView" class="hidden">
        <div class="toolbar">
          <div>
            <h1 class="panel-title">Private Notes</h1>
            <div class="panel-subtitle">更像博客首页 + 笔记软件编辑器的混合风格</div>
          </div>
          <div class="toolbar-spacer"></div>
          <button id="newBtn">新建笔记</button>
          <button id="logoutBtn" class="secondary">退出登录</button>
        </div>

        <div class="layout">
          <aside class="card sidebar">
            <div class="search-row">
              <input id="searchInput" placeholder="搜索标题或正文…" />
              <button id="searchBtn" class="secondary">搜索</button>
            </div>
            <div class="stats">
              <div class="stat">
                <div class="stat-label">当前结果</div>
                <div id="statCount" class="stat-value">0</div>
              </div>
              <div class="stat">
                <div class="stat-label">状态</div>
                <div id="statMode" class="stat-value" style="font-size:18px">待编辑</div>
              </div>
            </div>
            <div class="muted" id="listMeta">加载中…</div>
            <div id="noteList" class="note-list"></div>
          </aside>

          <main class="card editor">
            <div class="editor-actions" style="justify-content:space-between; margin-bottom:12px;">
              <div>
                <h2 class="panel-title" style="font-size:24px;">编辑器</h2>
                <div class="panel-subtitle">支持实时预览，适合当私人知识卡片和日记本。</div>
              </div>
              <div class="editor-actions">
                <button id="saveBtn">保存</button>
                <button id="deleteBtn" class="danger">删除</button>
              </div>
            </div>
            <div class="row grow">
              <input id="titleInput" class="title-input" placeholder="给这条笔记起个标题…" />
            </div>
            <textarea id="contentInput" placeholder="# 今天记点什么&#10;&#10;- 待办&#10;- 想法&#10;- 摘录"></textarea>
            <div class="editor-footer">
              <span id="status" class="muted"></span>
              <span class="muted">支持基础 Markdown 预览，快捷键 Ctrl/Cmd + S 保存</span>
            </div>
          </main>

          <aside class="card preview">
            <h2 class="panel-title" style="font-size:20px;">阅读预览</h2>
            <div class="panel-subtitle">右侧更像博客阅读视图，方便快速翻看记录。</div>
            <div class="preview-box" style="margin-top:16px;">
              <div id="previewTitle" class="note-title" style="font-size:20px; margin-bottom:4px;">未选择笔记</div>
              <div id="previewSubtitle" class="muted">创建或选择一条笔记后，这里会显示摘要和状态。</div>
            </div>
            <div class="preview-grid">
              <div class="preview-meta-card">
                <div class="stat-label">最后更新</div>
                <div id="previewUpdated">-</div>
              </div>
              <div class="preview-meta-card">
                <div class="stat-label">字数</div>
                <div id="previewWords">0</div>
              </div>
            </div>
            <div id="previewBody" class="preview-box preview-body">
              <div class="empty-state">在左侧选择一条笔记，或者直接新建一条开始写。</div>
            </div>
          </aside>
        </div>
      </section>
    </div>

    <script>
      const state = {
        currentId: null,
        notes: [],
        autoSaveTimer: null,
        loadingNote: false
      };

      const els = {
        loginView: document.getElementById('loginView'),
        appView: document.getElementById('appView'),
        passwordInput: document.getElementById('passwordInput'),
        loginBtn: document.getElementById('loginBtn'),
        loginStatus: document.getElementById('loginStatus'),
        searchInput: document.getElementById('searchInput'),
        searchBtn: document.getElementById('searchBtn'),
        logoutBtn: document.getElementById('logoutBtn'),
        noteList: document.getElementById('noteList'),
        listMeta: document.getElementById('listMeta'),
        statCount: document.getElementById('statCount'),
        statMode: document.getElementById('statMode'),
        newBtn: document.getElementById('newBtn'),
        titleInput: document.getElementById('titleInput'),
        contentInput: document.getElementById('contentInput'),
        saveBtn: document.getElementById('saveBtn'),
        deleteBtn: document.getElementById('deleteBtn'),
        status: document.getElementById('status'),
        previewTitle: document.getElementById('previewTitle'),
        previewSubtitle: document.getElementById('previewSubtitle'),
        previewUpdated: document.getElementById('previewUpdated'),
        previewWords: document.getElementById('previewWords'),
        previewBody: document.getElementById('previewBody')
      };

      function setStatus(text) {
        els.status.textContent = text || '';
      }

      function showLogin() {
        els.loginView.classList.remove('hidden');
        els.appView.classList.add('hidden');
      }

      function showApp() {
        els.loginView.classList.add('hidden');
        els.appView.classList.remove('hidden');
      }

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

      function wordCount(text) {
        return (text || '').replace(/\\s+/g, '').length;
      }

      async function api(url, options) {
        const res = await fetch(url, options);
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) {
          showLogin();
          throw new Error('请先登录');
        }
        if (!res.ok) {
          throw new Error(data.error || '请求失败');
        }
        return data;
      }

      function previewOf(note) {
        return (note.content || '').replace(/\\s+/g, ' ').slice(0, 88) || '（空内容）';
      }

      function escapeHtml(text) {
        return (text || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\"/g, '&quot;');
      }

      function inlineMd(text) {
        return text
          .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
          .replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
      }

      function renderMarkdown(text) {
        const safe = escapeHtml(text || '');
        const lines = safe.split('\\n');
        const html = [];
        let inList = false;

        function closeList() {
          if (inList) {
            html.push('</ul>');
            inList = false;
          }
        }

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line.trim()) {
            closeList();
            continue;
          }

          if (line.startsWith('### ')) {
            closeList();
            html.push('<h3>' + inlineMd(line.slice(4)) + '</h3>');
            continue;
          }

          if (line.startsWith('## ')) {
            closeList();
            html.push('<h2>' + inlineMd(line.slice(3)) + '</h2>');
            continue;
          }

          if (line.startsWith('# ')) {
            closeList();
            html.push('<h1>' + inlineMd(line.slice(2)) + '</h1>');
            continue;
          }

          if (line.startsWith('- ') || line.startsWith('* ')) {
            if (!inList) {
              html.push('<ul>');
              inList = true;
            }
            html.push('<li>' + inlineMd(line.slice(2)) + '</li>');
            continue;
          }

          closeList();
          html.push('<p>' + inlineMd(line) + '</p>');
        }

        closeList();
        return html.join('') || '<div class=\"empty-state\">这条笔记还没有内容。</div>';
      }

      function syncPreview() {
        const title = els.titleInput.value.trim() || '未命名笔记';
        const content = els.contentInput.value;
        const current = state.notes.find((item) => item.id === state.currentId);

        els.previewTitle.textContent = title;
        els.previewSubtitle.textContent = previewOf({ content });
        els.previewUpdated.textContent = current ? formatDate(current.updated_at) : '尚未保存';
        els.previewWords.textContent = String(wordCount(content));
        els.previewBody.innerHTML = renderMarkdown(content);
        els.statMode.textContent = state.currentId ? '编辑中' : '草稿中';
      }

      function renderList() {
        els.noteList.innerHTML = '';
        els.statCount.textContent = String(state.notes.length);
        els.listMeta.textContent = state.notes.length
          ? '共找到 ' + state.notes.length + ' 条笔记'
          : '还没有笔记，先写第一条吧。';

        if (!state.notes.length) {
          els.noteList.innerHTML = '<div class=\"empty-state\">没有匹配结果。可以新建一条，或者换个关键词再搜。</div>';
          return;
        }

        state.notes.forEach((note) => {
          const btn = document.createElement('button');
          btn.className = 'note-item' + (note.id === state.currentId ? ' active' : '');
          btn.type = 'button';

          const meta = document.createElement('div');
          meta.className = 'note-meta';
          meta.innerHTML = '<span>' + formatDate(note.updated_at) + '</span><span>' + wordCount(note.content) + ' 字</span>';

          const title = document.createElement('div');
          title.className = 'note-title';
          title.textContent = note.title || '无标题';

          const preview = document.createElement('div');
          preview.className = 'note-preview';
          preview.textContent = previewOf(note);

          btn.appendChild(meta);
          btn.appendChild(title);
          btn.appendChild(preview);
          btn.onclick = () => openNote(note.id);
          els.noteList.appendChild(btn);
        });
      }

      function fillEditor(note) {
        state.currentId = note ? note.id : null;
        els.titleInput.value = note ? note.title : '';
        els.contentInput.value = note ? note.content : '';
        renderList();
        syncPreview();
      }

      async function refreshNotes(preserveEditor) {
        const q = els.searchInput.value.trim();
        const query = q ? ('?q=' + encodeURIComponent(q)) : '';
        const data = await api('/api/notes' + query);
        state.notes = data.notes || [];
        renderList();

        if (preserveEditor) {
          syncPreview();
          return;
        }

        if (!state.currentId && state.notes.length) {
          fillEditor(state.notes[0]);
        } else if (state.currentId) {
          const current = state.notes.find((item) => item.id === state.currentId);
          if (current) {
            fillEditor(current);
          } else {
            fillEditor(null);
          }
        } else {
          syncPreview();
        }
      }

      async function openNote(id) {
        state.loadingNote = true;
        const data = await api('/api/notes/' + encodeURIComponent(id));
        fillEditor(data.note);
        state.loadingNote = false;
        setStatus('已加载');
      }

      async function saveCurrent(silent) {
        const title = els.titleInput.value.trim();
        const content = els.contentInput.value.trim();

        if (!title && !content) {
          if (!silent) setStatus('标题和内容至少写一个');
          return null;
        }

        if (!silent) setStatus('保存中…');

        let data;
        if (state.currentId) {
          data = await api('/api/notes/' + encodeURIComponent(state.currentId), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: title || '无标题', content })
          });
        } else {
          data = await api('/api/notes', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: title || '无标题', content })
          });
        }

        fillEditor(data.note);
        await refreshNotes(true);
        if (!silent) setStatus('已保存');
        return data.note;
      }

      function scheduleAutoSave() {
        if (state.loadingNote) return;
        syncPreview();
        setStatus('草稿已变更…');
        clearTimeout(state.autoSaveTimer);
        state.autoSaveTimer = setTimeout(() => {
          saveCurrent(true)
            .then((note) => {
              if (note) setStatus('已自动保存');
            })
            .catch((error) => setStatus(error.message || '自动保存失败'));
        }, 1200);
      }

      async function deleteCurrent() {
        if (!state.currentId) {
          setStatus('当前没有可删除的笔记');
          return;
        }
        if (!confirm('确定删除这条笔记吗？')) return;

        await api('/api/notes/' + encodeURIComponent(state.currentId), {
          method: 'DELETE'
        });

        state.currentId = null;
        fillEditor(null);
        await refreshNotes();
        setStatus('已删除');
      }

      async function checkSession() {
        const data = await api('/api/session');
        if (data.authenticated) {
          showApp();
          await refreshNotes();
        } else {
          showLogin();
        }
      }

      els.loginBtn.onclick = async () => {
        try {
          els.loginStatus.textContent = '登录中…';
          await api('/api/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: els.passwordInput.value })
          });
          els.passwordInput.value = '';
          els.loginStatus.textContent = '';
          showApp();
          await refreshNotes();
        } catch (error) {
          els.loginStatus.textContent = error.message || '登录失败';
        }
      };

      els.passwordInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') els.loginBtn.click();
      });

      els.searchBtn.onclick = () => {
        refreshNotes()
          .then(() => setStatus('已刷新搜索结果'))
          .catch((error) => setStatus(error.message || '搜索失败'));
      };

      els.searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          refreshNotes().catch((error) => setStatus(error.message || '搜索失败'));
        }
      });

      els.logoutBtn.onclick = async () => {
        await api('/api/logout', { method: 'POST' });
        state.currentId = null;
        state.notes = [];
        fillEditor(null);
        showLogin();
        setStatus('');
      };

      els.newBtn.onclick = () => {
        clearTimeout(state.autoSaveTimer);
        fillEditor(null);
        els.titleInput.focus();
        setStatus('已切换到新建模式');
      };

      els.saveBtn.onclick = () => {
        saveCurrent(false).catch((error) => setStatus(error.message || '保存失败'));
      };

      els.deleteBtn.onclick = () => {
        deleteCurrent().catch((error) => setStatus(error.message || '删除失败'));
      };

      els.titleInput.addEventListener('input', scheduleAutoSave);
      els.contentInput.addEventListener('input', scheduleAutoSave);

      document.addEventListener('keydown', (event) => {
        const isSave = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';
        if (isSave) {
          event.preventDefault();
          saveCurrent(false).catch((error) => setStatus(error.message || '保存失败'));
        }
      });

      fillEditor(null);
      checkSession().catch(() => showLogin());
    </script>
  </body>
</html>`;

export default {
	async fetch(request: Request, env: AppEnv): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/manifest.webmanifest') {
			return new Response(manifestJson, {
				headers: {
					'content-type': 'application/manifest+json; charset=utf-8',
					'cache-control': 'public, max-age=3600',
				},
			});
		}

		if (url.pathname === '/sw.js') {
			return new Response(serviceWorkerJs, {
				headers: {
					'content-type': 'application/javascript; charset=utf-8',
					'cache-control': 'no-store',
				},
			});
		}

		if (url.pathname === '/app-icon.svg') {
			return new Response(appIconSvg, {
				headers: {
					'content-type': 'image/svg+xml; charset=utf-8',
					'cache-control': 'public, max-age=86400',
				},
			});
		}

		if (url.pathname === '/') {
			return html(blogHomeHtml);
		}

		if (url.pathname === '/api/health' && request.method === 'GET') {
			const result = await env.DB.prepare('SELECT COUNT(*) AS note_count FROM notes').first<{
				note_count: number;
			}>();
			return json({
				ok: true,
				noteCount: result?.note_count ?? 0,
				authEnabled: Boolean(env.APP_PASSWORD && env.COOKIE_SECRET),
				now: Date.now(),
			});
		}

		if (url.pathname === '/api/session' && request.method === 'GET') {
			return json({ ok: true, authenticated: await isAuthed(request, env) });
		}

		if (url.pathname === '/api/login' && request.method === 'POST') {
			if (!env.APP_PASSWORD || !env.COOKIE_SECRET) {
				return json({ ok: false, error: 'server auth not configured' }, 500);
			}

			const body = (await request.json().catch(() => null)) as { password?: string } | null;
			if (!body?.password || body.password !== env.APP_PASSWORD) {
				return unauthorized();
			}

			return json(
				{ ok: true },
				200,
				{
					'set-cookie': `session=${await getSessionToken(env)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
				}
			);
		}

		if (url.pathname === '/api/logout' && request.method === 'POST') {
			return json(
				{ ok: true },
				200,
				{
					'set-cookie': 'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
				}
			);
		}

		if (url.pathname.startsWith('/api/') && !(await isAuthed(request, env))) {
			return unauthorized();
		}

		if (url.pathname === '/api/crypto-config' && request.method === 'GET') {
			return json({
				ok: true,
				vaultSalt: await getOrCreateVaultSalt(env),
				cipher: 'aes-gcm-256',
				kdf: 'pbkdf2-sha256',
				iterations: 250000,
				version: 1,
			});
		}

		if (url.pathname === '/api/notes' && request.method === 'GET') {
			return json({
				ok: true,
				notes: await listNotes(env),
			});
		}

		if (url.pathname === '/api/notes' && request.method === 'POST') {
			const body = (await request.json().catch(() => null)) as
				| { title?: string; content?: string }
				| null;

			const title = body?.title?.trim() || '无标题';
			const content = body?.content?.trim() || '';

			if (!title && !content) {
				return json({ ok: false, error: 'title/content required' }, 400);
			}

			const now = Date.now();
			const note: Note = {
				id: crypto.randomUUID(),
				title,
				content,
				created_at: now,
				updated_at: now,
			};

			await env.DB.prepare(
				`INSERT INTO notes (id, title, content, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`
			)
				.bind(note.id, note.title, note.content, note.created_at, note.updated_at)
				.run();

			return json({ ok: true, note }, 201);
		}

		if (url.pathname.startsWith('/api/notes/')) {
			const id = decodeURIComponent(url.pathname.slice('/api/notes/'.length));
			if (!id) return json({ ok: false, error: 'missing id' }, 400);

			if (request.method === 'GET') {
				const note = await getNote(env, id);
				if (!note) return json({ ok: false, error: 'not_found' }, 404);
				return json({ ok: true, note });
			}

			if (request.method === 'PUT') {
				const body = (await request.json().catch(() => null)) as
					| { title?: string; content?: string }
					| null;

				const title = body?.title?.trim() || '无标题';
				const content = body?.content?.trim() || '';

				const existing = await getNote(env, id);
				if (!existing) return json({ ok: false, error: 'not_found' }, 404);

				await env.DB.prepare(
					`UPDATE notes
					 SET title = ?, content = ?, updated_at = ?
					 WHERE id = ?`
				)
					.bind(title, content, Date.now(), id)
					.run();

				const note = await getNote(env, id);
				return json({ ok: true, note });
			}

			if (request.method === 'DELETE') {
				await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
				return json({ ok: true });
			}
		}

		return json({ ok: false, error: 'not_found' }, 404);
	},
} satisfies ExportedHandler<Env>;
