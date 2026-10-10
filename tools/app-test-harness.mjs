import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
const { createLogoutSignal, LOGOUT_EVENT_KEY } = await import('../public/device-session.js');
const { createMemoryVaultKeyBackend, createVaultKeyStore } = await import('../public/vault-key-store.js');
import { isLoginSession, loginWithToken } from '../public/login-flow.js';
import { encryptSharedPayload } from '../public/share-crypto.js';
import { createQrSvg } from '../public/qr.js';

const root = new URL('../', import.meta.url);
const sourcePromise = readFile(new URL('public/app.js', root), 'utf8');
const htmlPromise = readFile(new URL('public/index.html', root), 'utf8');

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export function storageHub() {
  const data = new Map();
  const listeners = new Map();
  let sequence = 0;
  return {
    data,
    connect(listener) {
      const id = ++sequence;
      listeners.set(id, listener);
      const emit = event => {
        for (const [other, receive] of listeners) {
          if (other !== id) queueMicrotask(() => receive(event));
        }
      };
      return {
        getItem: key => data.get(key) ?? null,
        setItem(key, value) {
          const oldValue = data.get(key) ?? null;
          if (oldValue === value) return;
          data.set(key, value);
          emit({ key, oldValue, newValue: value });
        },
        removeItem(key) {
          if (!data.has(key)) return;
          const oldValue = data.get(key);
          data.delete(key);
          emit({ key, oldValue, newValue: null });
        }
      };
    }
  };
}

function clock() {
  const timers = new Map();
  let now = 0, sequence = 0;
  return {
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = target;
    }
  };
}

class Element {
  constructor(tagName, id, document, history) {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.ownerDocument = document;
    this.children = [];
    this.attributes = new Map();
    this.events = new Map();
    this.value = '';
    this.disabled = false;
    this.checked = false;
    this.dataset = {};
    this.isConnected = true;
    this._textContent = '';
    this._innerHTML = '';
    const names = new Set();
    const change = (name, present) => {
      if (present) names.add(name); else names.delete(name);
      history.push({ id: this.id, name, present });
    };
    this.classList = {
      add: (...values) => values.forEach(name => change(name, true)),
      remove: (...values) => values.forEach(name => change(name, false)),
      contains: name => names.has(name),
      toggle: (name, force) => { const enabled = force ?? !names.has(name); change(name, enabled); return enabled; },
      names
    };
  }
  get className() { return [...this.classList.names].join(' '); }
  set className(value) { this.classList.names.clear(); this.classList.add(...value.split(/\s+/).filter(Boolean)); }
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = value; this.children = []; }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = value; this.children = []; }
  addEventListener(name, listener) {
    if (!this.events.has(name)) this.events.set(name, []);
    this.events.get(name).push(listener);
  }
  dispatch(name, init = {}) {
    const event = { type: name, target: this, preventDefault() {}, ...init };
    return Promise.all((this.events.get(name) || []).map(fn => fn(event)));
  }
  click() { if (!this.disabled && this.onclick) return this.onclick({ type: 'click', target: this }); }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
  appendChild(element) { this.children.push(element); return element; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  getClientRects() { return this.classList.contains('hidden') ? [] : [{}]; }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  querySelectorAll(selector) {
    const matches = [];
    const walk = element => {
      for (const child of element.children) {
        if (selector.startsWith('.') ? child.classList.contains(selector.slice(1)) : child.tagName === selector.toUpperCase()) matches.push(child);
        walk(child);
      }
    };
    walk(this);
    return matches;
  }
}

export async function createVaultFixture() {
  const bytes = new Uint8Array(32).fill(19);
  const key = await webcrypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const encrypt = async text => {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const cipher = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return 'enc:v1:' + btoa(JSON.stringify({ iv: Buffer.from(iv).toString('base64'), data: Buffer.from(cipher).toString('base64') }));
  };
  const config = { vaultSalt: btoa('s'.repeat(16)), cipher: 'aes-gcm-256', kdf: 'pbkdf2-sha256', iterations: 250000, version: 1,
    keyCheck: await encrypt('private-notes-key-check:v1') };
  const session = { token: 'test.signed.session', vaultId: 'default', expiresAt: Date.now() + 600000 };
  return { key, config, session, encrypt };
}

export function note(id = '11111111-1111-4111-8111-111111111111', title = '标题', content = '正文', revision = 1000) {
  return { id, title, content, revision, created_at: 1000, updated_at: revision, encrypted: true, decryptFailed: false };
}

export async function loadApp({ hub = storageHub(), fetch: fetchHandler, fixture, notes = [], vaultBackend = createMemoryVaultKeyBackend(), vaultTimeoutMs } = {}) {
  const elements = new Map();
  const events = new Map();
  const history = [];
  const calls = [];
  const timers = clock();
  const document = {
    documentElement: { dataset: {} }, activeElement: null,
    getElementById: id => elements.get(id) || null,
    createElement: tag => new Element(tag, '', document, history),
    addEventListener: (name, listener) => events.set('document:' + name, listener)
  };
  const html = await htmlPromise;
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const element = new Element(match[1], match[3], document, history);
    element.className = /class="([^"]*)"/.exec(match[2])?.[1] || '';
    element.disabled = /\bdisabled(?:\s|$)/.test(match[2]);
    element.checked = /\bchecked(?:\s|$)/.test(match[2]);
    elements.set(element.id, element);
  }
  const storage = hub.connect(event => events.get('storage')?.(event));
  const context = createContext({
    document,
    window: { location: { origin: 'https://example.test' }, scrollY: 0, scrollTo() {},
      addEventListener: (name, listener) => events.set(name, listener),
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    HTMLElement: Element, HTMLInputElement: Element, HTMLTextAreaElement: Element,
    HTMLSelectElement: Element, HTMLButtonElement: Element,
    createLogoutSignal: () => createLogoutSignal(storage), createVaultKeyStore: () => createVaultKeyStore({ backend: vaultBackend, timeoutMs: vaultTimeoutMs }), clearLegacyDeviceStore() {},
    LOGOUT_EVENT_KEY, isLoginSession, loginWithToken, encryptSharedPayload, createQrSvg,
    crypto: webcrypto, Headers, AbortController, URL, Response, TextEncoder, TextDecoder, Uint8Array, Promise, Error, TypeError, Intl,
    btoa, atob, console, confirm: () => true,
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fetchHandler ? fetchHandler(url, options) : jsonResponse({ ok: true, notes: [], nextCursor: null });
    },
    fixture, initialNotes: notes
  });
  const source = (await sourcePromise).replace(/^import[^\n]*\r?\n/gm, '')
    .replace('\ncheckSession().catch(', '\nglobalThis.__bootTask = checkSession().catch(');
  assert.ok(source.includes('globalThis.__bootTask ='), 'the harness must expose the real startup promise');
  runInContext(source, context, { filename: 'public/app.js' });
  const run = code => runInContext(code, context);
  return { context, elements, history, calls, timers, hub, run, boot: context.__bootTask,
    snapshot: code => JSON.parse(JSON.stringify(run(code))) };
}

export async function readyApp(options = {}) {
  const fixture = options.fixture || await createVaultFixture();
  let booting = true;
  const operationFetch = options.fetch;
  const app = await loadApp({
    ...options,
    fixture,
    fetch: (url, requestOptions) => {
      if (booting && url === '/api/session') return jsonResponse({ ok: true, authenticated: false });
      return operationFetch
        ? operationFetch(url, requestOptions)
        : jsonResponse({ ok: true, notes: [], nextCursor: null });
    }
  });
  await app.boot;
  booting = false;
  // Startup now checks the HttpOnly cookie on every page load. Operation tests
  // should observe only the requests made by the operation under test.
  app.calls.length = 0;
  app.run(`
    activeSession = fixture.session;
    state.sessionAuthenticated = true;
    state.vaultUnlocked = true;
    state.vaultKey = fixture.key;
    state.cryptoConfig = fixture.config;
    state.listReady = true;
    state.allNotes = initialNotes;
    state.allNotes.forEach(indexNote);
    refreshLocalMetadata();
    showApp();
    applySearch();
  `);
  return app;
}
