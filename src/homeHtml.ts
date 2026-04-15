export const blogHomeHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Private Notes</title>
    <meta name="theme-color" content="#07c160" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="我的笔记" />
    <meta name="description" content="一个部署在 Cloudflare Workers 上的简洁私人笔记。" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='8' y='6' width='48' height='52' rx='10' fill='%2307c160'/%3E%3Cpath d='M20 22h24M20 32h24M20 42h16' stroke='white' stroke-width='5' stroke-linecap='round'/%3E%3C/svg%3E" />
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f5f5;
        --panel: #ffffff;
        --panel-border: #e5e7eb;
        --text: #111827;
        --muted: #6b7280;
        --accent: #07c160;
        --accent-2: #06ad56;
        --danger: #ef4444;
        --shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
      }
      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body {
        margin: 0;
        color: var(--text);
        font: 14px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--bg);
        -webkit-tap-highlight-color: transparent;
        overscroll-behavior-y: contain;
      }
      button, input, textarea { font: inherit; }
      .hidden { display: none !important; }
      .page {
        max-width: 920px;
        margin: 0 auto;
        padding: 16px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 18px;
        box-shadow: var(--shadow);
      }
      .login-wrap {
        min-height: calc(100vh - 48px);
        display: grid;
        place-items: center;
        padding: 24px 0;
      }
      .login-card {
        width: min(420px, 100%);
        padding: 28px;
      }
      .login-brand {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: 16px;
      }
      .login-brand-icon {
        width: 48px;
        height: 48px;
        border-radius: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, var(--accent), var(--accent-2));
        color: white;
        font-size: 22px;
        box-shadow: 0 10px 24px rgba(7, 193, 96, 0.18);
      }
      .login-mini {
        color: var(--muted);
        font-size: 12px;
      }
      .login-title {
        margin: 2px 0 0;
        font-size: 26px;
        line-height: 1.2;
      }
      .muted {
        color: var(--muted);
      }
      .login-desc {
        margin: 0 0 18px;
        color: var(--muted);
        font-size: 14px;
      }
      .login-actions {
        margin-top: 14px;
      }
      .login-submit {
        width: 100%;
        height: 44px;
      }
      .login-foot {
        margin-top: 12px;
        min-height: 18px;
        color: var(--muted);
        font-size: 12px;
      }
      .field-stack {
        display: grid;
        gap: 8px;
        margin-bottom: 12px;
      }
      .field-label {
        font-size: 13px;
        color: #374151;
        font-weight: 600;
      }
      .field-help {
        margin-top: -2px;
        color: var(--muted);
        font-size: 12px;
      }
      .security-note {
        margin-top: 10px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }
      .vault-panel {
        margin-bottom: 12px;
        padding: 14px;
        border-radius: 16px;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
      }
      .vault-panel-title {
        margin: 0 0 6px;
        font-size: 15px;
        font-weight: 700;
      }
      .vault-panel-desc {
        margin: 0 0 12px;
        color: var(--muted);
        font-size: 13px;
      }
      .vault-panel-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .unlock-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 9px;
        border-radius: 999px;
        background: #ecfdf5;
        color: #166534;
        border: 1px solid #bbf7d0;
        font-size: 12px;
        margin-bottom: 10px;
      }
      .input, .textarea {
        width: 100%;
        border-radius: 16px;
        border: 1px solid #d1d5db;
        background: #ffffff;
        color: inherit;
        outline: none;
      }
      .input {
        height: 46px;
        padding: 0 14px;
      }
      .textarea {
        min-height: 320px;
        padding: 14px;
        resize: vertical;
      }
      .input:focus, .textarea:focus {
        border-color: rgba(7, 193, 96, 0.65);
        box-shadow: 0 0 0 4px rgba(7, 193, 96, 0.12);
      }
      .btn {
        height: 42px;
        padding: 0 16px;
        border: 0;
        border-radius: 14px;
        cursor: pointer;
        touch-action: manipulation;
        color: white;
        background: linear-gradient(135deg, var(--accent), var(--accent-2));
        box-shadow: 0 8px 18px rgba(7, 193, 96, 0.16);
      }
      .btn.secondary {
        background: #f3f4f6;
        color: #374151;
        box-shadow: none;
      }
      .btn.danger {
        background: #fef2f2;
        color: #b91c1c;
        box-shadow: none;
      }
      .topbar {
        display: flex;
        gap: 16px;
        justify-content: space-between;
        align-items: center;
        padding: 14px 16px;
        margin-bottom: 14px;
        flex-wrap: wrap;
        position: sticky;
        top: 0;
        z-index: 20;
        background: rgba(255, 255, 255, 0.92);
        backdrop-filter: blur(12px);
        border-color: rgba(229, 231, 235, 0.9);
      }
      .topbar-title {
        margin: 0;
        font-size: 21px;
      }
      .topbar-subtitle {
        color: var(--muted);
        margin-top: 4px;
      }
      .topbar-actions {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .search-wrap {
        position: relative;
        width: min(360px, 100%);
      }
      .clear-search {
        position: absolute;
        top: 50%;
        right: 8px;
        transform: translateY(-50%);
        width: 28px;
        height: 28px;
        border-radius: 999px;
        border: 0;
        background: #f3f4f6;
        color: #6b7280;
        display: none;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        line-height: 1;
        box-shadow: none;
        cursor: pointer;
      }
      .clear-search.show {
        display: flex;
      }
      .fab-new {
        display: none;
      }
      .fab-top {
        display: none;
      }
      .search {
        width: 100%;
        padding-right: 38px;
      }
      .status-line {
        position: fixed;
        left: 50%;
        bottom: 22px;
        transform: translate(-50%, 10px);
        min-width: 160px;
        max-width: min(90vw, 420px);
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(17, 24, 39, 0.9);
        color: #fff;
        box-shadow: 0 10px 24px rgba(17, 24, 39, 0.18);
        opacity: 0;
        pointer-events: none;
        transition: opacity .18s ease, transform .18s ease;
        text-align: center;
        z-index: 60;
      }
      .status-line.show {
        opacity: 1;
        transform: translate(-50%, 0);
      }
      .layout {
        display: grid;
        grid-template-columns: 1fr;
        gap: 18px;
      }
      .feed {
        padding: 18px;
      }
      .section-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-end;
        margin-bottom: 16px;
      }
      .section-title {
        margin: 0;
        font-size: 22px;
      }
      .section-desc {
        color: var(--muted);
        margin-top: 4px;
        font-size: 13px;
      }
      .note-list {
        display: grid;
        gap: 12px;
      }
      .group-block {
        display: grid;
        gap: 10px;
      }
      .group-title {
        margin: 4px 0 0;
        font-size: 13px;
        color: var(--muted);
        font-weight: 600;
      }
      .search-highlight {
        background: #fff3bf;
        color: inherit;
        padding: 0 2px;
        border-radius: 4px;
      }
      .note-card {
        border: 1px solid #ececec;
        border-radius: 14px;
        background: #ffffff;
        padding: 14px 14px 12px;
        color: inherit;
      }
      .note-card-meta {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 8px;
      }
      .note-card-title {
        font-size: 21px;
        font-weight: 700;
        margin-bottom: 6px;
      }
      .empty-feed {
        padding: 34px 20px;
        border-radius: 20px;
        border: 1px dashed rgba(148, 163, 184, 0.24);
        text-align: center;
        color: var(--muted);
      }
      .note-card-text {
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.8;
        font-size: 15px;
        color: #1f2937;
        user-select: text;
        -webkit-user-select: text;
      }
      .note-card-text-wrap.collapsed {
        position: relative;
        overflow: hidden;
      }
      .note-card-text-wrap.collapsed::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 56px;
        background: linear-gradient(180deg, rgba(255,255,255,0), #ffffff 78%);
        pointer-events: none;
      }
      .note-card-text.is-empty {
        color: var(--muted);
      }
      .note-card-detail {
        color: var(--muted);
        margin: 8px 0 16px;
      }
      .note-actions {
        display: flex;
        gap: 10px;
        margin-bottom: 12px;
        flex-wrap: wrap;
      }
      .note-actions .btn {
        height: 32px;
        padding: 0 11px;
        border-radius: 10px;
        font-size: 13px;
      }
      .note-expand {
        margin-top: 10px;
      }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(3, 7, 18, 0.7);
        display: grid;
        place-items: center;
        padding: 20px;
      }
      .modal-card {
        width: min(860px, 100%);
        padding: 22px;
      }
      .modal-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        margin-bottom: 16px;
      }
      .modal-actions {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
        margin-top: 14px;
      }
      @media (max-width: 980px) {
        .note-card-title {
          font-size: 20px;
        }
      }
      @media (max-width: 640px) {
        .page {
          padding: 10px;
          padding-bottom: calc(88px + env(safe-area-inset-bottom));
        }
        .login-wrap {
          padding: 8px 0;
          min-height: 100dvh;
        }
        .login-card {
          width: 100%;
          padding: 20px 16px;
          border-radius: 16px;
        }
        .login-brand {
          gap: 12px;
          margin-bottom: 14px;
        }
        .login-brand-icon {
          width: 42px;
          height: 42px;
          border-radius: 14px;
          font-size: 20px;
        }
        .login-title {
          font-size: 22px;
        }
        .login-desc {
          font-size: 13px;
          margin-bottom: 14px;
        }
        .input {
          height: 44px;
          border-radius: 14px;
        }
        .topbar {
          padding: 14px;
          gap: 12px;
          align-items: stretch;
          border-radius: 14px;
        }
        .topbar-title {
          font-size: 20px;
        }
        .topbar-subtitle {
          font-size: 12px;
        }
        .topbar-actions {
          width: 100%;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        .search-wrap {
          width: 100%;
          grid-column: 1 / -1;
        }
        .search {
          width: 100%;
          grid-column: 1 / -1;
        }
        .topbar-new-btn {
          display: none;
        }
        .topbar-actions .btn {
          width: 100%;
          padding: 0 10px;
          font-size: 14px;
        }
        .status-line {
          bottom: calc(76px + env(safe-area-inset-bottom));
          max-width: calc(100vw - 24px);
          padding: 9px 12px;
          font-size: 12px;
        }
        .feed {
          padding: 14px 12px;
          border-radius: 16px;
        }
        .section-head {
          display: block;
          margin-bottom: 12px;
        }
        .section-title {
          font-size: 18px;
        }
        .section-desc,
        .group-title,
        .note-card-meta {
          font-size: 12px;
        }
        .note-list {
          gap: 10px;
        }
        .group-block {
          gap: 8px;
        }
        .note-card {
          padding: 12px;
          border-radius: 12px;
        }
        .note-card-title {
          font-size: 18px;
          line-height: 1.35;
        }
        .note-card-detail {
          margin: 6px 0 12px;
        }
        .note-card-text {
          font-size: 14px;
          line-height: 1.72;
        }
        .note-actions {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
          margin-bottom: 10px;
        }
        .note-actions .btn,
        .note-expand {
          width: 100%;
        }
        .note-actions .btn {
          height: 34px;
          padding: 0 8px;
          font-size: 12px;
        }
        .note-expand {
          margin-top: 8px;
          height: 34px;
          font-size: 12px;
        }
        .modal-backdrop {
          padding: 0;
          align-items: end;
        }
        .modal-card {
          width: 100%;
          min-height: 88dvh;
          padding: 16px 14px calc(14px + env(safe-area-inset-bottom));
          border-radius: 18px 18px 0 0;
          border-left: 0;
          border-right: 0;
          border-bottom: 0;
        }
        .modal-head {
          gap: 10px;
          align-items: flex-start;
          margin-bottom: 12px;
        }
        .modal-head .section-title {
          font-size: 18px;
        }
        .textarea {
          min-height: 48dvh;
          font-size: 16px;
        }
        .modal-actions {
          position: sticky;
          bottom: 0;
          background: linear-gradient(180deg, rgba(255,255,255,0), rgba(255,255,255,0.98) 28%);
          padding-top: 12px;
          margin-top: 12px;
        }
        .fab-new {
          position: fixed;
          right: 16px;
          bottom: calc(16px + env(safe-area-inset-bottom));
          width: 56px;
          height: 56px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          font-size: 30px;
          line-height: 1;
          z-index: 30;
          box-shadow: 0 14px 32px rgba(7, 193, 96, 0.26);
        }
        .fab-top {
          position: fixed;
          right: 20px;
          bottom: calc(84px + env(safe-area-inset-bottom));
          width: 44px;
          height: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          font-size: 20px;
          line-height: 1;
          z-index: 29;
          background: rgba(17, 24, 39, 0.92);
          color: #ffffff;
          box-shadow: 0 12px 24px rgba(17, 24, 39, 0.16);
          opacity: 0;
          pointer-events: none;
          transform: translateY(8px);
          transition: opacity .18s ease, transform .18s ease;
        }
        .fab-top.show {
          opacity: 1;
          pointer-events: auto;
          transform: translateY(0);
        }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <section id="loginView" class="login-wrap hidden">
        <div class="card login-card">
          <div class="login-brand">
            <div class="login-brand-icon">✎</div>
            <div>
              <div class="login-mini">Private Notes</div>
              <h1 class="login-title">登录到我的笔记</h1>
            </div>
          </div>
          <div id="unlockBadge" class="unlock-badge hidden">✓ 已通过访问验证，只需输入密码解锁内容</div>
          <p id="loginDesc" class="login-desc">输入密码后即可进入应用，并在本地解锁你的加密笔记。</p>

          <div class="field-stack">
            <label class="field-label" for="passwordInput">密码</label>
            <input id="passwordInput" class="input" type="password" placeholder="输入密码" />
            <div class="field-help">同一个密码同时用于访问站点和本地解密。</div>
          </div>

          <div class="login-actions">
            <button id="loginBtn" class="btn login-submit">进入笔记</button>
          </div>
          <div class="security-note">端到端加密开启后，服务器只保存密文；搜索会在本地浏览器里完成。忘记密码将无法恢复旧密文。</div>
          <div id="loginStatus" class="login-foot"></div>
        </div>
      </section>

      <section id="appView" class="hidden">
        <header class="card topbar">
          <div>
            <h1 class="topbar-title">我的笔记</h1>
            <div class="topbar-subtitle">端到端加密 · 本地解锁 · 本地搜索</div>
          </div>
          <div class="topbar-actions">
            <div class="search-wrap">
              <input id="searchInput" class="input search" placeholder="搜索标题或正文…" />
              <button id="clearSearchBtn" class="clear-search" type="button" aria-label="清空搜索">×</button>
            </div>
            <button id="searchBtn" class="btn secondary">搜索</button>
            <button id="newBtn" class="btn topbar-new-btn">新建笔记</button>
            <button id="logoutBtn" class="btn secondary">退出登录</button>
          </div>
        </header>

        <div id="statusLine" class="status-line"></div>

        <section id="vaultPanel" class="vault-panel hidden">
          <h2 class="vault-panel-title">内容已加密</h2>
          <p id="vaultPanelDesc" class="vault-panel-desc">请输入密码查看笔记内容。如果忘记了，只能清空旧密文后重新开始。</p>
          <div class="field-stack">
            <label class="field-label" for="vaultUnlockInput">密码</label>
            <input id="vaultUnlockInput" class="input" type="password" placeholder="输入密码" />
          </div>
          <div class="vault-panel-actions">
            <button id="unlockBtn" class="btn">解锁内容</button>
            <button id="resetVaultBtn" class="btn danger">忘记密码，清空旧笔记</button>
          </div>
        </section>

        <main class="layout">
          <section class="card feed">
            <div class="section-head">
              <div>
                <h2 class="section-title">全部笔记</h2>
                <div class="section-desc">按更新时间排序，支持直接复制内容。</div>
              </div>
              <div id="noteCount" class="muted">0 条</div>
            </div>
            <div id="noteList" class="note-list"></div>
          </section>
        </main>
      </section>
    </div>

    <div id="editorModal" class="modal-backdrop hidden">
      <div class="card modal-card">
        <div class="modal-head">
          <div>
            <h2 id="modalTitle" class="section-title">新建笔记</h2>
            <div class="section-desc">保留简单编辑窗，平时主要还是用来浏览和复制。</div>
          </div>
          <button id="closeModalBtn" class="btn secondary">关闭</button>
        </div>
        <input id="editorTitle" class="input" placeholder="标题" />
        <div style="height:12px"></div>
        <textarea id="editorContent" class="textarea" placeholder="# 今天想到什么&#10;&#10;- 一条记录&#10;- 一个链接&#10;- 一个待办"></textarea>
        <div class="modal-actions">
          <button id="cancelBtn" class="btn secondary">取消</button>
          <button id="saveBtn" class="btn">保存</button>
        </div>
      </div>
    </div>
    <button id="fabNewBtn" class="btn fab-new" type="button" aria-label="新建笔记">＋</button>
    <button id="fabTopBtn" class="fab-top" type="button" aria-label="回到顶部">↑</button>

    <script>
      const state = {
        notes: [],
        allNotes: [],
        editingId: null,
        expandedIds: new Set(),
        searchTimer: null,
        statusTimer: null,
        sessionAuthenticated: false,
        vaultUnlocked: false,
        vaultKey: null,
        vaultSalt: '',
        noteCountMeta: 0,
        unlockError: ''
      };
      const SESSION_KEY = 'private-notes-passphrase';

      const els = {
        loginView: document.getElementById('loginView'),
        appView: document.getElementById('appView'),
        unlockBadge: document.getElementById('unlockBadge'),
        loginDesc: document.getElementById('loginDesc'),
        passwordInput: document.getElementById('passwordInput'),
        loginBtn: document.getElementById('loginBtn'),
        loginStatus: document.getElementById('loginStatus'),
        searchInput: document.getElementById('searchInput'),
        clearSearchBtn: document.getElementById('clearSearchBtn'),
        searchBtn: document.getElementById('searchBtn'),
        newBtn: document.getElementById('newBtn'),
        fabNewBtn: document.getElementById('fabNewBtn'),
        fabTopBtn: document.getElementById('fabTopBtn'),
        logoutBtn: document.getElementById('logoutBtn'),
        statusLine: document.getElementById('statusLine'),
        vaultPanel: document.getElementById('vaultPanel'),
        vaultPanelDesc: document.getElementById('vaultPanelDesc'),
        vaultUnlockInput: document.getElementById('vaultUnlockInput'),
        unlockBtn: document.getElementById('unlockBtn'),
        resetVaultBtn: document.getElementById('resetVaultBtn'),
        noteCount: document.getElementById('noteCount'),
        noteList: document.getElementById('noteList'),
        editorModal: document.getElementById('editorModal'),
        modalTitle: document.getElementById('modalTitle'),
        editorTitle: document.getElementById('editorTitle'),
        editorContent: document.getElementById('editorContent'),
        closeModalBtn: document.getElementById('closeModalBtn'),
        cancelBtn: document.getElementById('cancelBtn'),
        saveBtn: document.getElementById('saveBtn')
      };

      function setStatus(text) {
        clearTimeout(state.statusTimer);
        if (!text) {
          els.statusLine.textContent = '';
          els.statusLine.classList.remove('show');
          return;
        }
        els.statusLine.textContent = text;
        els.statusLine.classList.add('show');
        state.statusTimer = setTimeout(function () {
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

      function updateLoginMode() {
        const unlockOnly = state.sessionAuthenticated && !state.vaultUnlocked;
        els.unlockBadge.classList.toggle('hidden', !unlockOnly);
        els.loginDesc.textContent = unlockOnly
          ? '你已经通过访问验证。现在输入同一个密码即可解锁内容；如果忘记了，也可以进入后清空旧密文重新开始。'
          : '输入密码后即可进入应用，并在本地解锁你的加密笔记。';
        els.loginBtn.textContent = unlockOnly ? '解锁我的笔记' : '进入笔记';
      }

      function updateVaultUi() {
        els.vaultPanel.classList.toggle('hidden', state.vaultUnlocked || !state.sessionAuthenticated);
        els.searchInput.disabled = !state.vaultUnlocked;
        els.searchBtn.disabled = !state.vaultUnlocked;
        els.clearSearchBtn.disabled = !state.vaultUnlocked;
        els.newBtn.disabled = !state.vaultUnlocked;
        els.fabNewBtn.disabled = !state.vaultUnlocked;
        els.vaultPanelDesc.textContent = state.unlockError
          ? state.unlockError + '。如果你已经忘记密码，只能清空旧密文后重新开始。'
          : state.noteCountMeta > 0
            ? '你当前有 ' + state.noteCountMeta + ' 条已加密笔记。请输入密码查看内容；如果忘记了，只能清空旧密文后重新开始。'
            : '当前还没有可显示的解密内容。输入密码后可正常使用。';
      }

      function bytesToBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
      }

      function base64ToBytes(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      }

      function storeSessionPassphrase(passphrase) {
        try {
          localStorage.setItem(SESSION_KEY, passphrase);
        } catch (error) {}
      }

      function readSessionPassphrase() {
        try {
          return localStorage.getItem(SESSION_KEY) || '';
        } catch (error) {
          return '';
        }
      }

      function clearSessionPassphrase() {
        try {
          localStorage.removeItem(SESSION_KEY);
        } catch (error) {}
      }

      async function getCryptoConfig() {
        const data = await api('/api/crypto-config');
        state.vaultSalt = data.vaultSalt;
        return data;
      }

      async function refreshMeta() {
        const data = await api('/api/health');
        state.noteCountMeta = data.noteCount || 0;
        updateVaultUi();
      }

      async function deriveVaultKey(passphrase, saltBase64) {
        const salt = base64ToBytes(saltBase64);
        const keyMaterial = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(passphrase),
          'PBKDF2',
          false,
          ['deriveKey']
        );

        return crypto.subtle.deriveKey(
          {
            name: 'PBKDF2',
            salt: salt,
            iterations: 250000,
            hash: 'SHA-256'
          },
          keyMaterial,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      }

      function isEncryptedValue(value) {
        return typeof value === 'string' && value.startsWith('enc:v1:');
      }

      async function encryptValue(value) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const cipher = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: iv },
          state.vaultKey,
          new TextEncoder().encode(value || '')
        );

        return 'enc:v1:' + btoa(JSON.stringify({
          iv: bytesToBase64(iv),
          data: bytesToBase64(new Uint8Array(cipher))
        }));
      }

      async function decryptValue(value) {
        if (!isEncryptedValue(value)) return value || '';

        const payload = JSON.parse(atob(value.slice(7)));
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
          state.vaultKey,
          base64ToBytes(payload.data)
        );

        return new TextDecoder().decode(plain);
      }

      async function decryptNotes(rawNotes) {
        const decrypted = [];
        let encryptedCount = 0;
        let failedCount = 0;

        for (const note of rawNotes) {
          try {
            const encrypted = isEncryptedValue(note.title) || isEncryptedValue(note.content);
            if (encrypted) encryptedCount += 1;

            decrypted.push({
              id: note.id,
              title: await decryptValue(note.title),
              content: await decryptValue(note.content),
              created_at: note.created_at,
              updated_at: note.updated_at,
              encrypted: encrypted
            });
          } catch (error) {
            failedCount += 1;
          }
        }

        if (encryptedCount > 0 && failedCount === encryptedCount) {
          throw new Error('本地解锁密钥不正确');
        }

        return decrypted;
      }

      function filterNotes(notes, query) {
        const q = (query || '').trim().toLowerCase();
        if (!q) return notes;
        return notes.filter(function (note) {
          return (note.title || '').toLowerCase().includes(q) || (note.content || '').toLowerCase().includes(q);
        });
      }

      function showLogin() {
        els.loginView.classList.remove('hidden');
        els.appView.classList.add('hidden');
        updateLoginMode();
      }

      function showApp() {
        els.loginView.classList.add('hidden');
        els.appView.classList.remove('hidden');
        updateVaultUi();
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

      function formatGroupLabel(ts) {
        const d = new Date(ts);
        const now = new Date();
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

      function wordCount(text) {
        return (text || '').replace(/\\s+/g, '').length;
      }

      function previewOf(note) {
        return (note.content || '').replace(/\\s+/g, ' ').slice(0, 120) || '（空内容）';
      }

      function escapeHtml(text) {
        return (text || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      function escapeRegExp(text) {
        return text.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
      }

      function highlightText(text, query) {
        const safe = escapeHtml(text || '');
        if (!query) return safe;
        const escaped = escapeRegExp(query.trim());
        if (!escaped) return safe;
        return safe.replace(new RegExp(escaped, 'gi'), function (match) {
          return '<mark class="search-highlight">' + match + '</mark>';
        });
      }

      function getDisplayContent(note) {
        const content = note.content || '';
        const lines = content.split('\\n');
        const expanded = state.expandedIds.has(note.id);
        return {
          text: expanded ? content : lines.slice(0, 30).join('\\n'),
          expanded: expanded,
          canExpand: lines.length > 30
        };
      }

      async function api(url, options) {
        const res = await fetch(url, options);
        const data = await res.json().catch(function () { return {}; });
        if (res.status === 401) {
          state.sessionAuthenticated = false;
          state.vaultUnlocked = false;
          state.vaultKey = null;
          showLogin();
          throw new Error('请先登录');
        }
        if (!res.ok) {
          throw new Error(data.error || '请求失败');
        }
        return data;
      }

      function renderList() {
        els.noteList.innerHTML = '';
        els.noteCount.textContent = state.notes.length ? ('共 ' + state.notes.length + ' 条') : '0 条';

        if (!state.vaultUnlocked) {
          els.noteCount.textContent = state.noteCountMeta ? ('共 ' + state.noteCountMeta + ' 条（已加密）') : '0 条';
          els.noteList.innerHTML = '<div class="empty-feed">正文已加密。登录站点后，再输入本地解锁密钥才能看到内容和搜索结果。</div>';
          return;
        }

        if (!state.notes.length) {
          els.noteList.innerHTML = '<div class="empty-feed">现在还没有笔记。点击右上角“新建笔记”，写第一条就行。</div>';
          return;
        }

        const groups = new Map();
        state.notes.forEach(function (note) {
          const key = formatGroupLabel(note.updated_at);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(note);
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
            card.className = 'note-card';

            const meta = document.createElement('div');
            meta.className = 'note-card-meta';
            meta.innerHTML = '<span>' + formatDate(note.updated_at) + '</span><span>' + wordCount(note.content) + ' 字</span>';

            const title = document.createElement('div');
            title.className = 'note-card-title';
            title.innerHTML = highlightText(note.title || '无标题', els.searchInput.value.trim());

            const preview = document.createElement('div');
            preview.className = 'note-card-detail';
            preview.innerHTML = highlightText(previewOf(note), els.searchInput.value.trim());

            const actions = document.createElement('div');
            actions.className = 'note-actions';

            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'btn';
            copyBtn.textContent = '复制全文';
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
            editBtn.onclick = function () {
              openComposer(note);
            };

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'btn danger';
            deleteBtn.textContent = '删除';
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
            card.appendChild(preview);
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
          await refreshMeta();
          renderList();
          return;
        }

        const q = els.searchInput.value.trim();
        const data = await api('/api/notes');
        state.allNotes = await decryptNotes(data.notes || []);
        state.notes = filterNotes(state.allNotes, q);
        state.noteCountMeta = state.allNotes.length;
        updateVaultUi();
        state.expandedIds.forEach(function (id) {
          if (!state.notes.find(function (note) { return note.id === id; })) {
            state.expandedIds.delete(id);
          }
        });
        renderList();
      }

      function openComposer(note) {
        state.editingId = note ? note.id : null;
        els.modalTitle.textContent = note ? '编辑笔记' : '新建笔记';
        els.editorTitle.value = note ? note.title : '';
        els.editorContent.value = note ? note.content : '';
        els.editorModal.classList.remove('hidden');
        els.editorTitle.focus();
      }

      function closeComposer() {
        els.editorModal.classList.add('hidden');
        state.editingId = null;
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
          data = await api('/api/notes/' + encodeURIComponent(state.editingId), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: encryptedTitle, content: encryptedContent })
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

      async function deleteNote(id) {
        if (!id) {
          setStatus('当前没有可删除的记录');
          return;
        }
        if (!confirm('确定删除这条笔记吗？')) return;

        await api('/api/notes/' + encodeURIComponent(id), {
          method: 'DELETE'
        });

        await refreshNotes();
        setStatus('已删除');
      }

      async function unlockVault(passphrase) {
        if (!passphrase) {
          throw new Error('请输入密码');
        }

        const config = await getCryptoConfig();
        state.vaultKey = await deriveVaultKey(passphrase, config.vaultSalt);
        state.vaultUnlocked = true;
        state.unlockError = '';
        storeSessionPassphrase(passphrase);
        await refreshNotes();
      }

      async function resetEncryptedNotes() {
        await api('/api/reset-encrypted-notes', { method: 'DELETE' });
        state.notes = [];
        state.allNotes = [];
        state.noteCountMeta = 0;
        state.expandedIds = new Set();
        await refreshMeta();
      }

      async function checkSession() {
        const data = await api('/api/session');
        if (data.authenticated) {
          state.sessionAuthenticated = true;
          state.vaultUnlocked = false;
          state.vaultKey = null;
          state.unlockError = '';
          showApp();
          await refreshMeta();
          const cachedPassphrase = readSessionPassphrase();
          if (cachedPassphrase) {
            try {
              await unlockVault(cachedPassphrase);
              setStatus('已自动恢复解锁状态');
            } catch (error) {
              clearSessionPassphrase();
              state.vaultUnlocked = false;
              state.vaultKey = null;
              state.unlockError = '自动解锁失败，请重新输入密码';
              updateVaultUi();
            }
          }
        } else {
          const cachedPassphrase = readSessionPassphrase();
          if (cachedPassphrase) {
            try {
              await api('/api/login', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ password: cachedPassphrase })
              });
              state.sessionAuthenticated = true;
              state.vaultUnlocked = false;
              state.vaultKey = null;
              state.unlockError = '';
              showApp();
              await refreshMeta();
              await unlockVault(cachedPassphrase);
              setStatus('已自动登录并恢复解锁');
              return;
            } catch (error) {
              clearSessionPassphrase();
            }
          }

          state.sessionAuthenticated = false;
          state.vaultUnlocked = false;
          state.vaultKey = null;
          state.unlockError = '';
          clearSessionPassphrase();
          showLogin();
        }
      }

      els.loginBtn.onclick = async function () {
        try {
          els.loginStatus.textContent = '登录中…';
          const password = els.passwordInput.value.trim();
          if (!password) throw new Error('请输入密码');
          await api('/api/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: password })
          });
          state.sessionAuthenticated = true;
          await unlockVault(password);
          els.passwordInput.value = '';
          els.vaultUnlockInput.value = '';
          showApp();
          setStatus('已登录并解锁');

          els.loginStatus.textContent = '';
        } catch (error) {
          if (state.sessionAuthenticated) {
            state.unlockError = '当前密码无法解锁现有加密笔记';
            showApp();
            await refreshMeta();
            clearSessionPassphrase();
          } else {
            showLogin();
          }
          state.vaultUnlocked = false;
          state.vaultKey = null;
          els.loginStatus.textContent = error.message || '登录失败';
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
        refreshNotes()
          .then(function () { setStatus('已刷新搜索结果'); })
          .catch(function (error) { setStatus(error.message || '搜索失败'); });
      };

      els.searchInput.addEventListener('input', function () {
        updateSearchUi();
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(function () {
          refreshNotes().catch(function (error) {
            setStatus(error.message || '搜索失败');
          });
        }, 260);
      });

      els.searchInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') els.searchBtn.click();
      });

      els.clearSearchBtn.onclick = function () {
        els.searchInput.value = '';
        updateSearchUi();
        refreshNotes().catch(function (error) {
          setStatus(error.message || '搜索失败');
        });
      };

      els.newBtn.onclick = function () {
        openComposer(null);
      };

      els.fabNewBtn.onclick = function () {
        openComposer(null);
      };

      els.unlockBtn.onclick = function () {
        unlockVault(els.vaultUnlockInput.value)
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

      els.resetVaultBtn.onclick = function () {
        if (!confirm('忘记密码后，旧的加密笔记无法恢复。确定清空当前加密笔记并重新开始吗？')) return;
        resetEncryptedNotes()
          .then(function () {
            state.vaultUnlocked = false;
            state.vaultKey = null;
            state.unlockError = '';
            clearSessionPassphrase();
            els.vaultUnlockInput.value = '';
            els.passwordInput.value = '';
            updateVaultUi();
            renderList();
            setStatus('已清空旧密文笔记，可以重新开始');
          })
          .catch(function (error) {
            setStatus(error.message || '重置失败');
          });
      };

      els.fabTopBtn.onclick = function () {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };

      els.logoutBtn.onclick = async function () {
        await api('/api/logout', { method: 'POST' });
        state.notes = [];
        state.allNotes = [];
        state.sessionAuthenticated = false;
        state.vaultUnlocked = false;
        state.vaultKey = null;
        state.noteCountMeta = 0;
        els.vaultUnlockInput.value = '';
        els.passwordInput.value = '';
        state.unlockError = '';
        clearSessionPassphrase();
        showLogin();
        setStatus('');
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

      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
          navigator.serviceWorker.register('/sw.js').catch(function () {});
        });
      }

      updateSearchUi();
      updateScrollUi();
      checkSession().catch(function () {
        showLogin();
      });
    </script>
  </body>
</html>`;
