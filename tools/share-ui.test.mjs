import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const root = new URL('../', import.meta.url);

async function readProjectFile(path) {
	return readFile(new URL(path, root), 'utf8');
}

test('share creation offers explicit one-time and reusable choices', async () => {
	const [html, app] = await Promise.all([
		readProjectFile('public/index.html'),
		readProjectFile('public/app.js'),
	]);

	assert.match(html, /<option value="3600"[^>]*>阅后即焚（一次性）<\/option>/);
	assert.match(html, /<option value="86400"[^>]*>24 小时有效<\/option>/);
	assert.match(html, /<option value="604800"[^>]*>7 天有效<\/option>/);
	assert.match(app, /shareMode/);
	assert.match(app, /shareMode: shareMode/);
	assert.match(app, /可在期限内重复查看/);
	assert.match(app, /首次主动查看后立即失效/);
});

test('share result renders a local accessible QR and keeps copy-link fallback', async () => {
	const [html, app, qr] = await Promise.all([
		readProjectFile('public/index.html'),
		readProjectFile('public/app.js'),
		readProjectFile('public/qr.js'),
	]);

	assert.match(html, /id="shareQrPanel"/);
	assert.match(html, /id="shareQr"[^>]*role="img"/);
	assert.match(html, /id="shareQrTitle"/);
	assert.match(html, /id="shareQrDescription"/);
	assert.match(html, /id="copyShareLinkBtn"[^>]*>复制链接/);
	assert.match(app, /import \{ createQrSvg \} from ['"]\.\/qr\.js['"]/);
	assert.match(app, /shareUrl\.hash = encrypted\.keyFragment/);
	assert.match(app, /createQrSvg\(shareUrlText\)/);
	assert.match(app, /shareQr\.innerHTML/);
	const hashIndex = app.indexOf('shareUrl.hash = encrypted.keyFragment');
	const shareUrlTextIndex = app.indexOf('const shareUrlText = shareUrl.toString()', hashIndex);
	const qrIndex = app.indexOf('createQrSvg(shareUrlText)', shareUrlTextIndex);
	assert.ok(hashIndex >= 0 && shareUrlTextIndex > hashIndex && qrIndex > shareUrlTextIndex,
		'the QR must receive the same complete URL after its secret fragment is attached');
	assert.match(app, /二维码生成失败[\s\S]*复制链接/);
	assert.doesNotMatch(app, /fetch\([^)]*shareUrl/);
	assert.match(qr, /export function createQrSvg/);
	assert.doesNotMatch(qr, /<script/i);
});

test('app headings use concise hierarchy copy and the share page distinguishes modes', async () => {
	const [html, shareHtml, share] = await Promise.all([
		readProjectFile('public/index.html'),
		readProjectFile('public/share.html'),
		readProjectFile('public/share.js'),
	]);

	assert.match(html, /<h1 id="topbarTitle" class="topbar-title">我的笔记<\/h1>/);
	assert.match(html, /加密保存 · 本地解锁 · 快速搜索/);
	assert.match(html, /<h2 class="section-title">全部笔记<\/h2>/);
	assert.match(html, /按最近更新排列，支持搜索、编辑、复制和分享。/);
	assert.match(shareHtml, /查看分享内容/);
	assert.match(share, /data\.shareMode/);
	assert.match(share, /期限内可重复查看/);
	assert.match(share, /查看后立即失效/);
});

function createClassList() {
	const values = new Set();
	return {
		add(...names) {
			names.forEach((name) => values.add(name));
		},
		remove(...names) {
			names.forEach((name) => values.delete(name));
		},
		contains(name) {
			return values.has(name);
		},
		toggle(name, force) {
			const enabled = force === undefined ? !values.has(name) : force;
			if (enabled) values.add(name);
			else values.delete(name);
			return enabled;
		},
	};
}

function createElement(textContent = '') {
	return { textContent, disabled: false, classList: createClassList(), onclick: null };
}

async function loadSharePage(shareMode) {
	const source = await readProjectFile('public/share.js');
	const elements = {
		shareIntro: createElement(),
		consumeShareBtn: createElement('查看分享内容'),
		shareStatus: createElement(),
		sharedNote: createElement(),
		sharedMeta: createElement(),
		sharedTitle: createElement(),
		sharedContent: createElement(),
		clearSharedNoteBtn: createElement('立即清除当前页面内容'),
	};
	elements.sharedNote.classList.add('hidden');
	const buttonPrototype = class {};
	Object.setPrototypeOf(elements.consumeShareBtn, buttonPrototype.prototype);
	Object.setPrototypeOf(elements.clearSharedNoteBtn, buttonPrototype.prototype);
	const token = `${'a'.repeat(43)}.${'b'.repeat(43)}.${'c'.repeat(43)}`;
	const fetchCalls = [];
	const response = {
		ok: true,
		status: 200,
		json: async () => ({ ok: true, ciphertext: 'share:v1:test', shareMode }),
	};
	const context = {
		document: { getElementById: (id) => elements[id] || null },
		HTMLButtonElement: buttonPrototype,
		URL,
		Uint8Array,
		Promise,
		Intl,
		TextEncoder,
		Error,
		Number,
		fetch: async (...args) => {
			fetchCalls.push(args);
			return response;
		},
		window: {
			location: { href: `https://example.test/share?t=${token}#v1.${'d'.repeat(43)}` },
			history: { replaceState() {} },
			addEventListener() {},
		},
		console,
	};
	const executable = source.replace(
		"import { createShareProof, decryptSharedPayload, parseShareKeyFragment } from './share-crypto.js';",
		`const createShareProof = async () => 'proof';
const decryptSharedPayload = async () => ({
	v: 1,
	title: '测试标题',
	content: '测试正文',
	createdAt: 1,
	sharedAt: 2,
});
const parseShareKeyFragment = () => new Uint8Array([1, 2, 3]);`
	);
	runInNewContext(executable, context);
	return { elements, fetchCalls, names: { intro: 'shareIntro', consume: 'consumeShareBtn', status: 'shareStatus', note: 'sharedNote', clear: 'clearSharedNoteBtn' } };
}

async function click(element) {
	element.onclick();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

test('share page applies one-time and reusable view behavior', async () => {
	const oneTime = await loadSharePage('one_time');
	await click(oneTime.elements.consumeShareBtn);
	assert.equal(oneTime.elements.shareIntro.classList.contains('hidden'), true);
	assert.equal(oneTime.elements.sharedNote.classList.contains('hidden'), false);
	assert.equal(oneTime.elements.consumeShareBtn.disabled, true);
	assert.match(oneTime.elements.shareStatus.textContent, /一次性链接已失效/);
	assert.equal(oneTime.fetchCalls.length, 1);

	const reusable = await loadSharePage('reusable');
	await click(reusable.elements.consumeShareBtn);
	assert.equal(reusable.elements.shareIntro.classList.contains('hidden'), false);
	assert.equal(reusable.elements.sharedNote.classList.contains('hidden'), false);
	assert.equal(reusable.elements.consumeShareBtn.disabled, false);
	assert.equal(reusable.elements.consumeShareBtn.textContent, '再次查看');

	await click(reusable.elements.consumeShareBtn);
	assert.equal(reusable.fetchCalls.length, 2);
	assert.equal(reusable.elements.consumeShareBtn.disabled, false);
	assert.equal(reusable.elements.sharedNote.classList.contains('hidden'), false);

	reusable.elements.clearSharedNoteBtn.onclick();
	assert.equal(reusable.elements.sharedNote.classList.contains('hidden'), true);
	assert.equal(reusable.elements.consumeShareBtn.disabled, false);
	assert.match(reusable.elements.shareStatus.textContent, /可再次查看/);
});